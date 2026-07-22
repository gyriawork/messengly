import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import prisma from '../lib/prisma.js';
import { authenticate } from '../middleware/auth.js';
import { requireMinRole } from '../middleware/rbac.js';
import { messageSyncQueue } from '../lib/queue.js';
import { cacheGet, cacheSet, cacheInvalidate, cacheKey } from '../lib/cache.js';
import { decryptCredentials } from '../lib/crypto.js';
import { createAdapter } from '../integrations/factory.js';
import { resolveIntegration } from '../lib/integration-resolver.js';
import { setPendingImports, syncDiscoveredChats, type PendingImports } from '../lib/pending-imports.js';
import { getIO } from '../websocket/index.js';

// ─── Zod Schemas ───

const messengerEnum = z.enum(['telegram', 'slack', 'whatsapp', 'gmail', 'teams']);

const listChatsQuerySchema = z.object({
  messenger: messengerEnum.optional(),
  status: z.enum(['active', 'read-only', 'inactive']).optional(),
  owner: z.string().min(1).max(100).optional(), // free-text owner name filter (legacy, quietly deprecated by ownerId)
  ownerId: z.string().uuid().optional(), // filter to chats linked (ChatOwner) to this user
  search: z.string().min(1).max(200).optional(),
  // 'all' (default) matches chat name OR message body OR Gmail sender — the
  // /messenger panel relies on this (e.g. finding Gmail threads by sender
  // domain). 'name' restricts to the chat name only, for the /chats
  // management table which displays nothing but the name (a body match there
  // looks like a wrong result to the user).
  searchScope: z.enum(['name', 'all']).default('all'),
  tagId: z.union([z.string().uuid(), z.literal('none')]).optional(),
  scope: z.enum(['org', 'my']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(1000).default(50),
});

const chatIdParamSchema = z.object({
  id: z.string().uuid(),
});

const updateChatBodySchema = z.object({
  ownerId: z.string().uuid().nullable().optional(),
  status: z.enum(['active', 'read-only']).optional(),
  tags: z.array(z.string().uuid()).optional(),
  externalChatId: z.string().min(1).optional(),
});

const bulkAssignBodySchema = z.object({
  chatIds: z.array(z.string().uuid()).min(1).max(500),
  ownerName: z.string().max(100), // free text; empty string clears the owner
});

const bulkTagBodySchema = z.object({
  chatIds: z.array(z.string().uuid()).min(1).max(500),
  tagId: z.string().uuid(),
  action: z.enum(['add', 'remove']),
});

const bulkDeleteBodySchema = z.object({
  chatIds: z.array(z.string().uuid()).min(1).max(500),
});

const bulkUnlinkBodySchema = z.object({
  chatIds: z.array(z.string().uuid()).min(1).max(500),
});

// ─── Helpers ───

function sendError(reply: FastifyReply, code: string, message: string, statusCode: number) {
  return reply.status(statusCode).send({
    error: { code, message, statusCode },
  });
}

function getOrgId(request: FastifyRequest): string | null {
  if (request.user.role === 'superadmin') {
    const query = request.query as Record<string, string>;
    return query.organizationId ?? request.user.organizationId;
  }
  return request.user.organizationId;
}

/**
 * Whether the caller can see every chat in the org, or only the ones linked
 * to them via ChatOwner. Only admins and superadmins see everything; a plain
 * `user` ALWAYS sees just the chats they imported themselves. (The per-user
 * canViewAllChats flag no longer grants org-wide visibility — regular users
 * are strictly scoped to their own chats.)
 */
async function canViewAllChats(request: FastifyRequest): Promise<boolean> {
  return request.user.role === 'admin' || request.user.role === 'superadmin';
}

/**
 * Resolve the effective ChatOwner filter for a request: an unrestricted
 * caller optionally narrows to a requested ownerId; a restricted caller is
 * always forced to their own chats regardless of what ownerId they asked for.
 */
async function resolveOwnerFilter(
  request: FastifyRequest,
  requestedOwnerId: string | undefined,
): Promise<{ canViewAll: boolean; effectiveOwnerId: string | undefined }> {
  const canViewAll = await canViewAllChats(request);
  return { canViewAll, effectiveOwnerId: canViewAll ? requestedOwnerId : request.user.id };
}

// ─── Plugin ───

export default async function chatRoutes(fastify: FastifyInstance): Promise<void> {
  const authPreHandlers = [authenticate];
  // Bulk-deleting chats is destructive and stays superadmin-only. Editing a
  // single chat (owner/status/tags) and queuing a history backfill are
  // regular admin-level org management (Task 3/4 widened this).
  const superadminPreHandlers = [authenticate, requireMinRole('superadmin')];
  const adminPreHandlers = [authenticate, requireMinRole('admin')];

  // ─── GET /chats ───

  fastify.get(
    '/chats',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = listChatsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; '), 422);
      }

      const { messenger, status, owner, ownerId, search, searchScope, tagId, scope, page, limit } = parsed.data;

      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      const { canViewAll, effectiveOwnerId } = await resolveOwnerFilter(request, ownerId);

      // scope/canViewAll change what the query returns for the SAME params, so
      // both must be in the cache key — a prior bug here let scope=my leak a
      // cached scope=default (or vice versa) within the 60s TTL. searchScope
      // likewise: a name-scoped and all-scoped request share the same `search`
      // string and would otherwise collide within the TTL.
      const queryHash = createHash('md5')
        .update(JSON.stringify({ messenger, status, owner, search, searchScope, tagId, scope, page, limit, userId: request.user.id, effectiveOwnerId }))
        .digest('hex')
        .slice(0, 12);

      const ck = cacheKey(organizationId, 'chats', queryHash);
      const cached = await cacheGet<{ chats: unknown[]; total: number; page: number; limit: number }>(ck);
      if (cached) {
        return reply.send(cached);
      }

      const where: Record<string, unknown> = { organizationId, deletedAt: null };

      // Superadmin imports the org's chats; every user can target them for
      // broadcasts, so all org chats are visible. The optional `scope=my`
      // filter still narrows the list to chats the caller imported themselves.
      if (scope === 'my') {
        where.importedById = request.user.id;
      }

      // Task 10: an explicit ownerId filter, or a forced self-filter for a
      // restricted caller (canViewAllChats=false) — see resolveOwnerFilter().
      if (effectiveOwnerId) {
        where.owners = { some: { userId: effectiveOwnerId } };
      }

      if (messenger) where.messenger = messenger;
      if (status) where.status = status;
      if (owner) where.ownerName = owner;
      if (search) {
        if (searchScope === 'name') {
          // Name-only — the /chats table shows only the name, so matching
          // message bodies would surface rows that look unrelated.
          where.name = { contains: search, mode: 'insensitive' };
        } else {
          where.OR = [
            { name: { contains: search, mode: 'insensitive' } },
            { messages: { some: { text: { contains: search, mode: 'insensitive' } } } },
            // Match Gmail sender domain so /messenger?search=google.com works.
            { messages: { some: { fromEmail: { contains: search, mode: 'insensitive' } } } },
          ];
        }
      }
      if (tagId === 'none') {
        // Only chats with zero labels.
        where.tags = { none: {} };
      } else if (tagId) {
        where.tags = { some: { tagId } };
      }

      const [chats, total, statusGroups] = await Promise.all([
        prisma.chat.findMany({
          where,
          include: {
            tags: {
              select: { tag: { select: { id: true, name: true, color: true } } },
            },
            owner: {
              select: { id: true, name: true },
            },
            owners: {
              select: { userId: true, user: { select: { name: true } } },
            },
            messages: {
              take: 1,
              orderBy: { createdAt: 'desc' },
              select: { id: true, text: true, senderName: true, createdAt: true, fromEmail: true },
            },
            preferences: {
              where: { userId: request.user.id },
              take: 1,
              select: { pinned: true, favorite: true, muted: true, unread: true },
            },
          },
          orderBy: { lastActivityAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.chat.count({ where }),
        // Org-wide reachability summary (ignores the filter bar) — but NOT the
        // visibility restriction: a restricted caller must only ever see
        // counts for their own chats, matching the list they're shown.
        prisma.chat.groupBy({
          by: ['status'],
          where: {
            organizationId,
            deletedAt: null,
            ...(canViewAll ? {} : { owners: { some: { userId: request.user.id } } }),
          },
          _count: true,
        }),
      ]);

      const statusCounts: Record<string, number> = {};
      for (const g of statusGroups) statusCounts[g.status] = g._count;

      const result = chats.map((chat) => ({
        id: chat.id,
        name: chat.name,
        messenger: chat.messenger,
        externalChatId: chat.externalChatId,
        chatType: chat.chatType,
        status: chat.status,
        organizationId: chat.organizationId,
        ownerId: chat.ownerId,
        ownerName: chat.ownerName,
        owner: chat.owner
          ? { id: chat.owner.id, name: chat.owner.name }
          : null,
        // Every user who can currently reach this chat via their own
        // connection (Task 11 — many-to-many chat<->owner).
        owners: chat.owners.map((o) => ({ userId: o.userId, name: o.user.name })),
        importedById: chat.importedById,
        messageCount: chat.messageCount,
        lastActivityAt: chat.lastActivityAt,
        syncStatus: chat.syncStatus,
        hasFullHistory: chat.hasFullHistory,
        tags: chat.tags.map((ct) => ({
          id: ct.tag.id,
          name: ct.tag.name,
          color: ct.tag.color,
        })),
        // Pass-through includes fromEmail (selected above) — required by /chats Gmail grouping.
        lastMessage: chat.messages[0] ?? null,
        preferences: chat.preferences[0]
          ? {
              pinned: chat.preferences[0].pinned,
              favorite: chat.preferences[0].favorite,
              muted: chat.preferences[0].muted,
              unread: chat.preferences[0].unread,
            }
          : { pinned: false, favorite: false, muted: false, unread: false },
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
      }));

      const response = { chats: result, total, page, limit, statusCounts };
      await cacheSet(ck, response, 60);
      return reply.send(response);
    },
  );

  // ─── GET /chats/:id ───

  fastify.get(
    '/chats/:id',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsParsed = chatIdParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', 'Invalid chat id', 422);
      }

      const { id } = paramsParsed.data;
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      // Task 10: a restricted caller (canViewAllChats=false) can't read a
      // chat outside their own links even by guessing its id — 404, not 403,
      // so the response doesn't confirm the chat exists at all.
      const { canViewAll } = await resolveOwnerFilter(request, undefined);

      const chat = await prisma.chat.findFirst({
        where: {
          id,
          organizationId,
          deletedAt: null,
          ...(canViewAll ? {} : { owners: { some: { userId: request.user.id } } }),
        },
        include: {
          tags: {
            include: { tag: true },
          },
          owner: {
            select: { id: true, name: true, email: true },
          },
          participants: {
            select: { id: true, externalUserId: true, displayName: true, role: true },
          },
          preferences: {
            where: { userId: request.user.id },
            take: 1,
          },
        },
      });

      if (!chat) {
        return sendError(reply, 'RESOURCE_NOT_FOUND', `Chat with id ${id} not found`, 404);
      }

      return reply.send({
        id: chat.id,
        name: chat.name,
        messenger: chat.messenger,
        externalChatId: chat.externalChatId,
        chatType: chat.chatType,
        status: chat.status,
        organizationId: chat.organizationId,
        ownerId: chat.ownerId,
        owner: chat.owner
          ? { id: chat.owner.id, name: chat.owner.name, email: chat.owner.email }
          : null,
        importedById: chat.importedById,
        messageCount: chat.messageCount,
        lastActivityAt: chat.lastActivityAt,
        syncStatus: chat.syncStatus,
        hasFullHistory: chat.hasFullHistory,
        tags: chat.tags.map((ct) => ({
          id: ct.tag.id,
          name: ct.tag.name,
          color: ct.tag.color,
        })),
        participants: chat.participants,
        preferences: chat.preferences[0]
          ? {
              pinned: chat.preferences[0].pinned,
              favorite: chat.preferences[0].favorite,
              muted: chat.preferences[0].muted,
              unread: chat.preferences[0].unread,
            }
          : { pinned: false, favorite: false, muted: false, unread: false },
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
      });
    },
  );

  // ─── PATCH /chats/:id ───

  fastify.patch(
    '/chats/:id',
    { preHandler: adminPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsParsed = chatIdParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', 'Invalid chat id', 422);
      }

      const bodyParsed = updateChatBodySchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', bodyParsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 422);
      }

      const { id } = paramsParsed.data;
      const { ownerId, status, tags, externalChatId } = bodyParsed.data;

      if (ownerId === undefined && status === undefined && tags === undefined && externalChatId === undefined) {
        return sendError(reply, 'VALIDATION_ERROR', 'At least one field must be provided for update', 422);
      }

      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      const existing = await prisma.chat.findFirst({
        where: { id, organizationId },
      });
      if (!existing) {
        return sendError(reply, 'RESOURCE_NOT_FOUND', `Chat with id ${id} not found`, 404);
      }

      // If ownerId is provided, validate it belongs to the same org
      if (ownerId !== undefined && ownerId !== null) {
        const ownerUser = await prisma.user.findFirst({
          where: { id: ownerId, organizationId },
        });
        if (!ownerUser) {
          return sendError(reply, 'VALIDATION_ERROR', `User with id ${ownerId} not found in organization`, 422);
        }
      }

      // If tags are provided, validate they belong to the same org
      if (tags !== undefined && tags.length > 0) {
        const existingTags = await prisma.tag.findMany({
          where: { id: { in: tags }, organizationId },
        });
        if (existingTags.length !== tags.length) {
          return sendError(reply, 'VALIDATION_ERROR', 'One or more tag IDs are invalid or do not belong to this organization', 422);
        }
      }

      const updated = await prisma.$transaction(async (tx) => {
        // Update chat fields
        const updateData: Record<string, unknown> = {};
        if (ownerId !== undefined) updateData.ownerId = ownerId;
        if (status !== undefined) updateData.status = status;
        if (externalChatId !== undefined) updateData.externalChatId = externalChatId;

        const chat = await tx.chat.update({
          where: { id },
          data: updateData,
        });

        // Replace tags if provided
        if (tags !== undefined) {
          await tx.chatTag.deleteMany({ where: { chatId: id } });

          if (tags.length > 0) {
            await tx.chatTag.createMany({
              data: tags.map((tagId) => ({ chatId: id, tagId })),
            });
          }
        }

        return chat;
      });

      // Fetch full updated chat with relations
      const fullChat = await prisma.chat.findFirst({
        where: { id },
        include: {
          tags: { include: { tag: true } },
          owner: { select: { id: true, name: true, email: true } },
        },
      });

      await cacheInvalidate(cacheKey(organizationId, 'chats', '*'));

      return reply.send({
        id: updated.id,
        name: updated.name,
        messenger: updated.messenger,
        externalChatId: updated.externalChatId,
        chatType: updated.chatType,
        status: updated.status,
        organizationId: updated.organizationId,
        ownerId: updated.ownerId,
        owner: fullChat?.owner ?? null,
        importedById: updated.importedById,
        messageCount: updated.messageCount,
        lastActivityAt: updated.lastActivityAt,
        tags: fullChat?.tags.map((ct) => ({
          id: ct.tag.id,
          name: ct.tag.name,
          color: ct.tag.color,
        })) ?? [],
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      });
    },
  );

  // ─── DELETE /chats/:id ───

  fastify.delete(
    '/chats/:id',
    { preHandler: superadminPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsParsed = chatIdParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', 'Invalid chat id', 422);
      }

      const { id } = paramsParsed.data;
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      const existing = await prisma.chat.findFirst({
        where: { id, organizationId },
      });
      if (!existing) {
        return sendError(reply, 'RESOURCE_NOT_FOUND', `Chat with id ${id} not found`, 404);
      }

      // Block deletion if this chat is part of an active (sending) broadcast
      const activeBroadcast = await prisma.broadcastChat.findFirst({
        where: {
          chatId: id,
          broadcast: { status: { in: ['sending', 'scheduled'] } },
        },
        include: { broadcast: { select: { id: true, name: true, status: true } } },
      });
      if (activeBroadcast) {
        return sendError(
          reply,
          'CHAT_IN_ACTIVE_BROADCAST',
          `This chat is part of the active broadcast "${activeBroadcast.broadcast.name}" (${activeBroadcast.broadcast.status}), so it can\u2019t be deleted right now`,
          409,
        );
      }

      // Hard delete in a transaction to prevent race conditions
      await prisma.$transaction([
        prisma.message.deleteMany({ where: { chatId: id } }),
        prisma.chatTag.deleteMany({ where: { chatId: id } }),
        prisma.chatPreference.deleteMany({ where: { chatId: id } }),
        prisma.chatParticipant.deleteMany({ where: { chatId: id } }),
        prisma.broadcastChat.deleteMany({ where: { chatId: id } }),
        prisma.chat.delete({ where: { id } }),
      ]);

      await cacheInvalidate(cacheKey(organizationId, 'chats', '*'));

      return reply.status(204).send();
    },
  );

  // ─── POST /chats/import ───
  // Import selected chats from a connected messenger.

  const importChatItemSchema = z.object({
    externalChatId: z.string(),
    name: z.string().optional(),
    // 'unknown' = the messenger couldn't determine the type (e.g. Teams' DOM
    // detection); rendered as "—" in the UI rather than guessed as 'direct'.
    chatType: z.enum(['direct', 'group', 'channel', 'unknown']).optional(),
  });

  const importBodySchema = z.object({
    messenger: z.enum(['telegram', 'slack', 'whatsapp', 'gmail', 'teams']),
    // Accept either legacy string array or rich objects with name/chatType
    externalChatIds: z.union([
      z.array(z.string()).min(1).max(500),
      z.array(importChatItemSchema).min(1).max(500),
    ]),
  });

  fastify.post(
    '/chats/import',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = importBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 422);
      }

      const { messenger, externalChatIds: rawChatIds } = parsed.data;
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      // A plain user may only import through their OWN connected account —
      // this route previously never checked at all, so a user could import
      // via whichever account the caller of list-chats/import-with-history
      // had resolved (or, with a hand-crafted request, any org connection).
      // Admin+ is unrestricted, matching every other route in this file.
      if (request.user.role === 'user') {
        const own = await prisma.integration.findUnique({
          where: {
            messenger_organizationId_userId_scope: {
              messenger, organizationId, userId: request.user.id, scope: 'user',
            },
          },
        });
        if (!own || own.status !== 'connected') {
          return sendError(
            reply,
            'AUTH_INSUFFICIENT_PERMISSIONS',
            `You can only import ${messenger} chats through your own connected account. Connect ${messenger} first.`,
            403,
          );
        }
      }

      // Normalize input: accept both string[] and {externalChatId, name, chatType}[]
      const chatItems = rawChatIds.map((item) =>
        typeof item === 'string'
          ? { externalChatId: item, name: undefined as string | undefined, chatType: undefined as string | undefined }
          : item,
      );

      const imported: Array<{ id: string; name: string; externalChatId: string }> = [];

      for (const { externalChatId, name, chatType } of chatItems) {
        // Skip if already imported
        const existing = await prisma.chat.findFirst({
          where: { externalChatId, organizationId, messenger, deletedAt: null },
        });
        if (existing) {
          // Update name if we have a better one now
          if (name && existing.name === externalChatId) {
            await prisma.chat.update({ where: { id: existing.id }, data: { name } });
          }
          // Task 11: re-importing a chat that already exists (e.g. a second
          // user's connected account can also reach it) links the CALLER as
          // an additional owner instead of creating a duplicate Chat row.
          await prisma.chatOwner.upsert({
            where: { chatId_userId: { chatId: existing.id, userId: request.user.id } },
            create: { chatId: existing.id, userId: request.user.id },
            update: {},
          });
          imported.push({ id: existing.id, name: name || existing.name, externalChatId });
          continue;
        }

        const chat = await prisma.chat.create({
          data: {
            name: name || externalChatId,
            messenger,
            externalChatId,
            chatType: (chatType as 'direct' | 'group' | 'channel' | 'unknown') || 'direct',
            organizationId,
            importedById: request.user.id,
            ownerId: request.user.id,
            owners: { create: { userId: request.user.id } },
          },
        });
        imported.push({ id: chat.id, name: chat.name, externalChatId });
      }

      await cacheInvalidate(cacheKey(organizationId, 'chats', '*'));

      return reply.send({ imported, count: imported.length });
    },
  );

  // ─── POST /chats/import-with-history ───
  // Import selected chats and load recent message history for each.
  // Emits real-time progress via WebSocket so the wizard can show a progress bar.

  const importWithHistoryBodySchema = z.object({
    messenger: z.enum(['telegram', 'slack', 'whatsapp', 'gmail', 'teams']),
    chats: z.array(z.object({
      externalChatId: z.string(),
      name: z.string(),
      chatType: z.enum(['direct', 'group', 'channel', 'unknown']).default('direct'),
    })).min(1).max(200),
  });

  fastify.post(
    '/chats/import-with-history',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = importWithHistoryBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 422);
      }

      const { messenger, chats: selectedChats } = parsed.data;
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }
      const userId = request.user.id;
      const isPlainUser = request.user.role === 'user';

      // Resolve the integration this import runs through: the caller's own
      // personal connection if they have one (Task 3/4 self-connect), else
      // the org's oldest connected row for admin+ — unchanged from pre-v2.2
      // behavior for orgs where only the shared/admin-connected account
      // exists. A plain user NEVER falls back to someone else's connection —
      // they either have their own, or this import doesn't run.
      const integration = await resolveIntegration(messenger, organizationId, {
        userId,
        ownOnly: isPlainUser,
      });

      if (!integration) {
        return sendError(
          reply,
          'VALIDATION_ERROR',
          isPlainUser
            ? `You don't have a connected ${messenger} account. Connect it in Settings → My Messengers first.`
            : `No connected ${messenger} account found. Ask your administrator to connect it first.`,
          400,
        );
      }

      // Decrypt credentials and create adapter
      const creds = decryptCredentials<Record<string, unknown>>(integration.credentials as string);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adapter = await createAdapter(messenger, creds, { organizationId }) as any;
      await adapter.connect();

      const io = getIO();
      const room = `org:${organizationId}`;
      const total = selectedChats.length;
      let done = 0;
      let failed = 0;
      const imported: Array<{ id: string; name: string; externalChatId: string; messageCount: number }> = [];

      // Sender name cache to avoid redundant API calls
      const senderNameCache = new Map<string, string>();

      async function resolveSenderName(senderId: string): Promise<string> {
        if (!senderId) return 'Unknown';
        const cached = senderNameCache.get(senderId);
        if (cached) return cached;
        try {
          const name = adapter.getSenderName
            ? await adapter.getSenderName(senderId)
            : senderId;
          senderNameCache.set(senderId, name);
          return name;
        } catch {
          senderNameCache.set(senderId, senderId);
          return senderId;
        }
      }

      // Import one chat's record + recent history. Written to run concurrently.
      // Arrow (not a hoisted `function`) so the non-null narrowing of
      // organizationId from the guard above is preserved inside the closure.
      const importOne = async (chatInfo: (typeof selectedChats)[number]): Promise<void> => {
        try {
          // 1. Upsert chat record
          const chat = await prisma.chat.upsert({
            where: {
              externalChatId_messenger_organizationId: {
                externalChatId: chatInfo.externalChatId,
                messenger,
                organizationId,
              },
            },
            create: {
              name: chatInfo.name,
              messenger,
              externalChatId: chatInfo.externalChatId,
              chatType: chatInfo.chatType,
              organizationId,
              importedById: userId,
              ownerId: userId,
              syncStatus: 'synced',
              hasFullHistory: false,
              lastActivityAt: new Date(),
            },
            update: {
              // Update name if stored as raw ID
              ...(chatInfo.name !== chatInfo.externalChatId ? { name: chatInfo.name } : {}),
            },
          });

          // Task 11: link the importing user as an owner regardless of
          // whether the chat was just created or already existed (a second
          // user's own connection reaching the same chat) — never a
          // duplicate Chat row, and integrationId ties the link to this
          // connection so disconnecting it later removes only this link.
          await prisma.chatOwner.upsert({
            where: { chatId_userId: { chatId: chat.id, userId } },
            create: { chatId: chat.id, userId, integrationId: integration.id },
            update: {},
          });

          // 2. Fetch recent messages (50)
          let messageCount = 0;
          if (adapter.getMessages) {
            try {
              const messages = await adapter.getMessages(chatInfo.externalChatId, 50);

              if (messages.length > 0) {
                // Resolve all unique sender names
                const uniqueSenderIds = [...new Set(messages.map((m: { senderId: string }) => m.senderId).filter(Boolean))] as string[];
                await Promise.all(uniqueSenderIds.map((id) => resolveSenderName(id)));

                // Bulk insert messages, skip duplicates
                const messageData = messages.map((m: { id: string; text: string; senderId: string; date: Date; out: boolean }) => ({
                  chatId: chat.id,
                  externalMessageId: m.id,
                  senderName: senderNameCache.get(m.senderId) || m.senderId || 'Unknown',
                  senderExternalId: m.senderId || null,
                  isSelf: m.out,
                  text: m.text || '',
                  createdAt: m.date,
                }));

                const result = await prisma.message.createMany({
                  data: messageData,
                  skipDuplicates: true,
                });
                messageCount = result.count;

                // Update chat lastActivityAt from newest message
                const newest = messages[messages.length - 1];
                await prisma.chat.update({
                  where: { id: chat.id },
                  data: { lastActivityAt: newest.date },
                });
              }
            } catch (msgErr) {
              console.warn(`[import-with-history] Failed to fetch messages for ${chatInfo.name}:`, msgErr);
            }
          }

          imported.push({
            id: chat.id,
            name: chat.name,
            externalChatId: chatInfo.externalChatId,
            messageCount,
          });
        } catch (chatErr) {
          console.warn(`[import-with-history] Failed to import chat ${chatInfo.name}:`, chatErr);
          failed++;
        }

        done++;
        io.to(room).emit('import_chat_progress', {
          done,
          total,
          currentName: chatInfo.name,
        });
      }

      try {
        // Import chats in parallel with a bounded pool: Telegram is rate-limit
        // sensitive so it stays low; other adapters (and the Teams agent, which
        // serialises on its own single-browser mutex) tolerate more.
        const concurrency = messenger === 'telegram' ? 3 : 5;
        const executing = new Set<Promise<void>>();
        for (const chatInfo of selectedChats) {
          const p = importOne(chatInfo).finally(() => executing.delete(p));
          executing.add(p);
          if (executing.size >= concurrency) await Promise.race(executing);
        }
        await Promise.all(executing);
      } finally {
        try { await adapter.disconnect(); } catch { /* ignore */ }
      }

      // Emit completion event
      io.to(room).emit('import_chat_complete', {
        imported: imported.length,
        failed,
      });

      // Imported chats are no longer "new"; the next scan recomputes exactly.
      if (imported.length > 0) {
        const org = await prisma.organization.findUnique({
          where: { id: organizationId },
          select: { pendingImports: true },
        });
        const pending = ((org?.pendingImports as PendingImports | null) ?? {})[messenger]?.count ?? 0;
        await setPendingImports(organizationId, messenger, Math.max(0, pending - imported.length));
      }

      // Invalidate caches
      await cacheInvalidate(cacheKey(organizationId, 'chats', '*'));

      return reply.send({
        imported,
        count: imported.length,
        failed,
      });
    },
  );

  // ─── GET /chats/pending-imports ───
  // Feeds the "new chats pending" banner: per-messenger counts of chats seen
  // in the latest scans that are not imported yet.

  fastify.get(
    '/chats/pending-imports',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }
      const org = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: { pendingImports: true },
      });
      return reply.send({ pending: (org?.pendingImports as PendingImports | null) ?? {} });
    },
  );

  // ─── POST /chats/refresh-statuses ───
  // Re-checks every imported chat against its messenger and flips it between
  // `active` and `inactive`, so broadcasts are not aimed at chats the connected
  // account can no longer reach (e.g. chats left over from a previous Teams
  // login). A chat is reachable iff the adapter's listChats() still returns it —
  // the same signal the import wizard trusts. The manual `read-only` status is a
  // user decision and is never touched.
  //
  // Deactivation requires TWO consecutive misses: the Teams adapter scans a
  // virtualized sidebar with a browser, and a single cold/partial scan can
  // under-collect the list — one flaky scan must not flip statuses. Each scan
  // that misses a chat bumps its `missedScans` counter; a scan that finds it
  // resets the counter. Only chats at `missedScans >= 2` are deactivated.
  // On top of that, a scan that saw fewer than half of the known-active chats
  // is treated as partial and hands out no penalties at all.
  //
  // Runs synchronously within the request, but messengers are scanned in
  // parallel — total time is the slowest messenger (Teams browser scan, up to
  // a few minutes on large sidebars), acceptable for a button with a spinner.

  fastify.post(
    '/chats/refresh-statuses',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      const orgChats = await prisma.chat.findMany({
        where: { organizationId, deletedAt: null },
        select: { messenger: true },
        distinct: ['messenger'],
      });

      const results: Record<string, { checked: number; activated: number; deactivated: number; partialScan?: boolean }> = {};
      const errors: Record<string, string> = {};

      // Messengers are independent — scan them in parallel. Teams is a slow
      // browser scan; running the API-based messengers alongside it makes the
      // whole refresh take as long as the slowest one, not the sum.
      const refreshOne = async (messenger: string): Promise<void> => {
        // Task 3/4 made per-user connections possible, so more than one
        // connected integration can now exist for the same messenger+org. A
        // chat is reachable if ANY of them still sees it — scanning only the
        // oldest (as before) would wrongly deactivate chats that only a
        // second user's personal account can still reach.
        const integrations = await prisma.integration.findMany({
          where: { messenger, organizationId, status: 'connected' },
          orderBy: { createdAt: 'asc' },
        });
        // A disconnected messenger is simply not checkable — that is not an
        // error, its chats just keep their current status.
        if (integrations.length === 0) return;

        const reachable = new Set<string>();
        const failures: string[] = [];
        for (const integration of integrations) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let adapter: any;
          try {
            const creds = decryptCredentials<Record<string, unknown>>(integration.credentials as string);
            adapter = await createAdapter(messenger, creds, { organizationId });
            await adapter.connect();
            const chats: Array<{ externalChatId: string }> = await adapter.listChats();
            for (const c of chats) reachable.add(c.externalChatId);
          } catch (err) {
            failures.push(err instanceof Error ? err.message : 'Failed to list chats');
          } finally {
            try { await adapter?.disconnect(); } catch { /* ignore */ }
          }
        }
        // Every connected account failed to scan — no signal at all, leave
        // chats alone (byte-identical to the single-integration failure path).
        if (failures.length === integrations.length) {
          errors[messenger] = failures[0];
          return;
        }

        const chats = await prisma.chat.findMany({
          where: { organizationId, messenger, deletedAt: null },
          select: { id: true, externalChatId: true, status: true },
        });

        const presentIds = chats
          .filter((c) => reachable.has(c.externalChatId))
          .map((c) => c.id);

        // Partial-scan guard: if the scan saw fewer than half of the chats we
        // currently believe are active, the scan itself is suspect (Teams
        // sidebar under-collected, messenger hiccup) — sightings still count,
        // but nobody gets a missed-scan penalty from a scan we don't trust.
        // Without this, a few bad scans in a row mass-deactivate the org.
        const activeCount = chats.filter((c) => c.status === 'active').length;
        const partialScan = activeCount >= 10 && presentIds.length < activeCount * 0.5;

        // The same scan tells us how many chats exist that were never
        // imported — that feeds the "new chats pending" banner.
        const importedIds = new Set(chats.map((c) => c.externalChatId));
        const newIds = [...reachable].filter((extId) => !importedIds.has(extId));
        if (!partialScan) {
          await setPendingImports(organizationId, messenger, newIds.length);
          await syncDiscoveredChats(organizationId, messenger, newIds.map((externalChatId) => ({ externalChatId })));
        }

        const activateIds = chats
          .filter((c) => c.status === 'inactive' && reachable.has(c.externalChatId))
          .map((c) => c.id);
        const missedIds = chats
          .filter((c) => !reachable.has(c.externalChatId))
          .map((c) => c.id);

        if (presentIds.length > 0) {
          // A confirmed sighting wipes the miss history, so counters only ever
          // reflect *consecutive* misses.
          await prisma.chat.updateMany({ where: { id: { in: presentIds } }, data: { missedScans: 0 } });
        }
        if (activateIds.length > 0) {
          await prisma.chat.updateMany({ where: { id: { in: activateIds } }, data: { status: 'active' } });
        }

        let deactivated = 0;
        if (missedIds.length > 0 && !partialScan) {
          // Increment BEFORE deactivating: a chat missed for the first time
          // must end this run at missedScans=1 and still active.
          await prisma.chat.updateMany({
            where: { id: { in: missedIds } },
            data: { missedScans: { increment: 1 } },
          });
          const result = await prisma.chat.updateMany({
            where: { id: { in: missedIds }, status: 'active', missedScans: { gte: 2 } },
            data: { status: 'inactive' },
          });
          deactivated = result.count;
        }

        results[messenger] = {
          checked: chats.length,
          activated: activateIds.length,
          deactivated,
          ...(partialScan ? { partialScan: true } : {}),
        };
      };

      await Promise.allSettled(orgChats.map(({ messenger }) => refreshOne(messenger)));

      await cacheInvalidate(cacheKey(organizationId, 'chats', '*'));

      return reply.send({ results, errors });
    },
  );

  // ─── POST /chats/:id/load-full-history ───
  // Queues a background job to pull the full message history for a single chat.
  // Used by the "Load full history" button in the chat header (lazy-history model).

  fastify.post(
    '/chats/:id/load-full-history',
    { preHandler: adminPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsParsed = chatIdParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', 'Invalid chat id', 422);
      }

      const { id } = paramsParsed.data;
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      const chat = await prisma.chat.findFirst({
        where: { id, organizationId, deletedAt: null },
        select: { id: true, messenger: true, syncStatus: true, hasFullHistory: true },
      });

      if (!chat) {
        return sendError(reply, 'RESOURCE_NOT_FOUND', `Chat with id ${id} not found`, 404);
      }

      if (chat.hasFullHistory) {
        return reply.send({ queued: false, reason: 'already_fetched' });
      }

      if (chat.syncStatus === 'syncing') {
        return reply.send({ queued: false, reason: 'already_syncing' });
      }

      const integration = await prisma.integration.findFirst({
        where: { messenger: chat.messenger, organizationId, status: 'connected' },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });

      if (!integration) {
        return sendError(
          reply,
          'MESSENGER_API_ERROR',
          `No connected ${chat.messenger} integration found`,
          502,
        );
      }

      // Mark the chat as pending so the existing sync-history processor picks it up.
      await prisma.chat.update({
        where: { id },
        data: { syncStatus: 'pending' },
      });

      await messageSyncQueue.add(
        'sync:chat-history',
        {
          chatIds: [id],
          integrationId: integration.id,
          organizationId,
          messenger: chat.messenger,
        },
        { jobId: `load-full-history-${id}-${Date.now()}` },
      );

      return reply.send({ queued: true });
    },
  );

  // ─── POST /chats/bulk/assign ───

  fastify.post(
    '/chats/bulk/assign',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = bulkAssignBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 422);
      }

      const { chatIds, ownerName } = parsed.data;
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      // Owner is a free-text label; empty string clears it.
      const result = await prisma.chat.updateMany({
        where: {
          id: { in: chatIds },
          organizationId,
        },
        data: { ownerName: ownerName.trim() || null },
      });

      await cacheInvalidate(cacheKey(organizationId, 'chats', '*'));

      return reply.send({ updated: result.count });
    },
  );

  // ─── POST /chats/bulk/tag ───

  fastify.post(
    '/chats/bulk/tag',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = bulkTagBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 422);
      }

      const { chatIds, tagId, action } = parsed.data;
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      // Validate tag belongs to org
      const tag = await prisma.tag.findFirst({
        where: { id: tagId, organizationId },
      });
      if (!tag) {
        return sendError(reply, 'RESOURCE_NOT_FOUND', `Tag with id ${tagId} not found`, 404);
      }

      // Validate all chats belong to org
      const validChats = await prisma.chat.findMany({
        where: { id: { in: chatIds }, organizationId },
        select: { id: true },
      });
      const validChatIds = validChats.map((c) => c.id);

      if (action === 'add') {
        // Use skipDuplicates to handle already-tagged chats
        await prisma.chatTag.createMany({
          data: validChatIds.map((chatId) => ({ chatId, tagId })),
          skipDuplicates: true,
        });
      } else {
        await prisma.chatTag.deleteMany({
          where: {
            chatId: { in: validChatIds },
            tagId,
          },
        });
      }

      await cacheInvalidate(cacheKey(organizationId, 'chats', '*'));

      return reply.send({ updated: validChatIds.length });
    },
  );

  // ─── PATCH /chats/:id/read ───

  fastify.patch(
    '/chats/:id/read',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsParsed = chatIdParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', 'Invalid chat id', 422);
      }

      const { id } = paramsParsed.data;
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      const existing = await prisma.chat.findFirst({
        where: { id, organizationId },
      });
      if (!existing) {
        return sendError(reply, 'RESOURCE_NOT_FOUND', `Chat with id ${id} not found`, 404);
      }

      await prisma.chatPreference.upsert({
        where: { userId_chatId: { chatId: id, userId: request.user.id } },
        create: { chatId: id, userId: request.user.id, unread: false },
        update: { unread: false },
      });

      await cacheInvalidate(cacheKey(organizationId, 'chats', '*'));

      return reply.send({ success: true });
    },
  );

  // ─── DELETE /chats/bulk ───

  fastify.delete(
    '/chats/bulk',
    { preHandler: superadminPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = bulkDeleteBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 422);
      }

      const { chatIds } = parsed.data;
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      // Hard delete: remove all related data, then chats
      await prisma.message.deleteMany({ where: { chatId: { in: chatIds } } });
      await prisma.chatTag.deleteMany({ where: { chatId: { in: chatIds } } });
      await prisma.chatPreference.deleteMany({ where: { chatId: { in: chatIds } } });
      await prisma.chatParticipant.deleteMany({ where: { chatId: { in: chatIds } } });
      await prisma.broadcastChat.deleteMany({ where: { chatId: { in: chatIds } } });
      const result = await prisma.chat.deleteMany({
        where: {
          id: { in: chatIds },
          organizationId,
        },
      });

      await cacheInvalidate(cacheKey(organizationId, 'chats', '*'));

      return reply.send({ deleted: result.count });
    },
  );

  // ─── POST /chats/bulk/unlink ───
  // "Remove from my list" for any user. Deletes only the CALLER's ChatOwner
  // links — the shared Chat row and everyone else's links survive (same
  // mechanic as disconnecting an integration). The chats leave the caller's
  // view and, because list-chats offers chats the caller doesn't own, become
  // re-importable from their own account.

  fastify.post(
    '/chats/bulk/unlink',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = bulkUnlinkBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 422);
      }

      const { chatIds } = parsed.data;
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      // Scoped to the caller's own links AND to this org — a hand-crafted
      // chatIds list can therefore only ever remove the caller's own ownership.
      const result = await prisma.chatOwner.deleteMany({
        where: {
          userId: request.user.id,
          chatId: { in: chatIds },
          chat: { organizationId },
        },
      });

      await cacheInvalidate(cacheKey(organizationId, 'chats', '*'));

      return reply.send({ unlinked: result.count });
    },
  );
}
