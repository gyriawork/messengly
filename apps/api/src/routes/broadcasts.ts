import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma.js';
import { authenticate } from '../middleware/auth.js';
import { requireMinRole, getOrgId } from '../middleware/rbac.js';
import { broadcastQueue } from '../lib/queue.js';
import { getIO } from '../websocket/index.js';
import { logActivity } from '../lib/activity-logger.js';

/**
 * Markers an adapter puts on a failure that must never be retried.
 *
 * `unverified:` — the Teams agent could not confirm delivery, but the message may
 *   well have arrived. Retrying would put a second copy in a real chat.
 * `attachment:` — the file could not be attached (a PDF to a Teams group chat has
 *   nowhere to go). Re-running the same flow fails identically.
 */
const NON_RETRIABLE_REASON_PREFIXES = ['unverified:', 'attachment:'] as const;

// ─── Zod Schemas ───

const broadcastStatusEnum = z.enum([
  'draft', 'scheduled', 'sending', 'canceling', 'sent', 'partially_failed', 'failed', 'canceled',
]);

const listBroadcastsQuerySchema = z.object({
  status: broadcastStatusEnum.optional(),
  search: z.string().min(1).max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const idParamSchema = z.object({
  id: z.string().uuid(),
});

// Task 7/8: per-messenger sending account. NULL/omitted = legacy behavior
// (worker picks the org's oldest connected integration for that messenger).
// sendAs is Slack-only (bot vs personal account).
const senderConfigSchema = z.record(
  z.enum(['telegram', 'slack', 'whatsapp', 'gmail', 'teams']),
  z.object({
    integrationId: z.string().uuid(),
    sendAs: z.enum(['bot', 'user']).optional(),
  }),
).optional();

// Telegram rejects messages over 4096 chars with MESSAGE_TOO_LONG for EVERY
// recipient, so the API caps at Telegram's limit (the wizard already does) —
// a template/duplicate/API edit can no longer smuggle a too-long message past.
const MAX_MESSAGE_LENGTH = 4096;

const createBroadcastBodySchema = z.object({
  name: z.string().min(1).max(500),
  messageText: z.string().min(1).max(MAX_MESSAGE_LENGTH),
  chatIds: z.array(z.string().uuid()).min(1).max(10000),
  scheduledAt: z.coerce.date().optional(),
  templateId: z.string().uuid().optional(),
  attachments: z.any().optional(),
  senderConfig: senderConfigSchema,
});

const updateBroadcastBodySchema = z.object({
  name: z.string().min(1).max(500).optional(),
  messageText: z.string().min(1).max(MAX_MESSAGE_LENGTH).optional(),
  chatIds: z.array(z.string().uuid()).min(1).max(10000).optional(),
  scheduledAt: z.coerce.date().nullable().optional(),
  senderConfig: senderConfigSchema,
});

const analyticsQuerySchema = z.object({
  period: z.string().regex(/^\d+d$/).default('30d'),
  messenger: z.enum(['telegram', 'slack', 'whatsapp', 'gmail', 'teams']).optional(),
});

// ─── Helpers ───

function sendError(reply: FastifyReply, code: string, message: string, statusCode: number) {
  return reply.status(statusCode).send({
    error: { code, message, statusCode },
  });
}

type SenderConfig = Record<string, { integrationId: string; sendAs?: 'bot' | 'user' }>;

/**
 * Task 7/8: validate a broadcast's chosen sender per messenger.
 * - The integration must exist, belong to this org, match the messenger, and
 *   be connected.
 * - admin/superadmin may pick any integration in the org (Task 7: admin sends
 *   from any org user's connected account).
 * - A plain `user` may only pick their own connection, EXCEPT Slack's
 *   org-level bot with sendAs:'bot' — that's the one org-owned resource a
 *   regular user is allowed to send through (Task 8).
 * - sendAs is only meaningful for Slack.
 */
async function validateSenderConfig(
  request: FastifyRequest,
  organizationId: string,
  senderConfig: SenderConfig | undefined,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!senderConfig) return { ok: true };
  const isPrivileged = request.user.role === 'admin' || request.user.role === 'superadmin';

  for (const [messenger, cfg] of Object.entries(senderConfig)) {
    if (cfg.sendAs && messenger !== 'slack') {
      return { ok: false, message: `sendAs is only supported for slack (got ${messenger})` };
    }

    const integration = await prisma.integration.findUnique({ where: { id: cfg.integrationId } });
    if (!integration || integration.organizationId !== organizationId || integration.messenger !== messenger) {
      return { ok: false, message: `Sender account for ${messenger} was not found in this organization` };
    }
    if (integration.status !== 'connected') {
      return { ok: false, message: `Sender account for ${messenger} is not connected` };
    }

    if (!isPrivileged) {
      const isOwnAccount = integration.userId === request.user.id;
      const isOrgSlackBot = messenger === 'slack' && integration.scope === 'org' && cfg.sendAs === 'bot';
      if (!isOwnAccount && !isOrgSlackBot) {
        return { ok: false, message: `You can only send ${messenger} messages from your own connected account` };
      }
    }
  }

  return { ok: true };
}

/** Push a broadcast status change to the org's connected browsers. */
function emitBroadcastStatus(organizationId: string, broadcastId: string, status: string): void {
  try {
    const io = getIO();
    io.to(`org:${organizationId}`).emit('broadcast_status', { broadcastId, status });
  } catch {
    // WebSocket might not be initialized in tests
  }
}

/** Fire-and-forget activity log entry for a cancel — never blocks the response. */
function logBroadcastCancel(
  request: FastifyRequest,
  organizationId: string,
  broadcastId: string,
  resultStatus: 'canceled' | 'canceling',
): void {
  prisma.broadcast.findUnique({ where: { id: broadcastId }, select: { name: true } }).then((b) => {
    if (!b) return;
    return logActivity({
      category: 'broadcast',
      action: 'canceled',
      description:
        resultStatus === 'canceled'
          ? `Broadcast "${b.name}" canceled`
          : `Broadcast "${b.name}" canceling (was already sending)`,
      targetType: 'broadcast',
      targetId: broadcastId,
      userId: request.user.id,
      userName: request.user.name,
      organizationId,
    });
  }).catch(() => { /* non-critical */ });
}

// ─── Plugin ───

export default async function broadcastRoutes(fastify: FastifyInstance): Promise<void> {
  const authPreHandlers = [authenticate];
  // Broadcasting is the regular user's core job — allow any authenticated user.
  // (Messenger configuration is locked to superadmin; see integrations routes.)
  const broadcastPreHandlers = [authenticate, requireMinRole('user')];

  // ─── GET /broadcasts ───

  fastify.get(
    '/broadcasts',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = listBroadcastsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; '), 422);
      }

      const { status, search, page, limit } = parsed.data;
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      const where: Record<string, unknown> = { organizationId };
      if (request.user.role === 'user') {
        where.createdById = request.user.id;
      }
      if (status) where.status = status;
      if (search) {
        where.name = { contains: search, mode: 'insensitive' };
      }

      const [broadcasts, total] = await Promise.all([
        prisma.broadcast.findMany({
          where,
          include: {
            createdBy: { select: { id: true, name: true, email: true } },
            _count: { select: { chats: true } },
          },
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.broadcast.count({ where }),
      ]);

      // Fetch per-broadcast status counts in a single query instead of loading all BroadcastChat rows
      const broadcastIds = broadcasts.map((b) => b.id);
      const statusCountRows = broadcastIds.length > 0
        ? await prisma.$queryRaw<Array<{ broadcastId: string; status: string; count: bigint }>>(
            Prisma.sql`
              SELECT "broadcastId", "status", COUNT(*)::bigint as count
              FROM "BroadcastChat"
              WHERE "broadcastId" IN (${Prisma.join(broadcastIds)})
              GROUP BY "broadcastId", "status"
            `,
          )
        : [];

      // Build a map of broadcastId -> { sent, failed, pending }
      const statsMap = new Map<string, { sent: number; failed: number; skipped: number; pending: number }>();
      for (const row of statusCountRows) {
        if (!statsMap.has(row.broadcastId)) {
          statsMap.set(row.broadcastId, { sent: 0, failed: 0, skipped: 0, pending: 0 });
        }
        const entry = statsMap.get(row.broadcastId)!;
        const count = Number(row.count);
        if (row.status === 'sent') entry.sent += count;
        if (row.status === 'failed' || row.status === 'retry_exhausted') entry.failed += count;
        // A skipped chat was never attempted (missing chat, or the messenger halted),
        // so it is neither delivered nor a delivery failure. Without its own bucket
        // the counts silently stop adding up to the total.
        if (row.status === 'skipped') entry.skipped += count;
        if (row.status === 'pending' || row.status === 'retrying') entry.pending += count;
      }

      const result = broadcasts.map((b) => {
        const stats = statsMap.get(b.id) ?? { sent: 0, failed: 0, skipped: 0, pending: 0 };
        return {
          id: b.id,
          name: b.name,
          messageText: b.messageText,
          attachments: b.attachments,
          status: b.status,
          scheduledAt: b.scheduledAt,
          sentAt: b.sentAt,
          deliveryRate: b.deliveryRate,
          templateId: b.templateId,
          createdBy: b.createdBy,
          createdAt: b.createdAt,
          updatedAt: b.updatedAt,
          stats: {
            total: b._count.chats,
            sent: stats.sent,
            failed: stats.failed,
            skipped: stats.skipped,
            pending: stats.pending,
          },
        };
      });

      return reply.send({ broadcasts: result, total, page, limit });
    },
  );

  // ─── GET /broadcasts/analytics ───
  // Must be before /broadcasts/:id to avoid route collision

  fastify.get(
    '/broadcasts/analytics',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = analyticsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; '), 422);
      }

      const { period, messenger } = parsed.data;
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      const days = parseInt(period.replace('d', ''), 10);
      const since = new Date();
      since.setDate(since.getDate() - days);

      // Common where clause for Prisma groupBy
      const broadcastFilter: Record<string, unknown> = {
        organizationId,
        sentAt: { gte: since },
      };
      if (request.user.role === 'user') {
        broadcastFilter.createdById = request.user.id;
      }
      const broadcastChatWhere: Record<string, unknown> = {
        broadcast: broadcastFilter,
      };

      if (messenger) {
        broadcastChatWhere.chat = { messenger };
      }

      // Build conditional SQL fragment for messenger filter
      const messengerCondition = messenger
        ? Prisma.sql`AND c."messenger" = ${messenger}`
        : Prisma.empty;

      const userCondition = request.user.role === 'user'
        ? Prisma.sql`AND b."createdById" = ${request.user.id}`
        : Prisma.empty;

      // Use database-level aggregation instead of loading all rows into memory
      const [statusCounts, messengerStatusCounts, dailyStatusCounts] = await Promise.all([
        // Overall status counts via Prisma groupBy
        prisma.broadcastChat.groupBy({
          by: ['status'],
          where: broadcastChatWhere,
          _count: { status: true },
        }),

        // Per-messenger status counts via raw SQL (needs join through Chat)
        prisma.$queryRaw<Array<{ messenger: string; status: string; count: bigint }>>(
          Prisma.sql`
            SELECT c."messenger", bc."status", COUNT(*)::bigint as count
            FROM "BroadcastChat" bc
            JOIN "Chat" c ON bc."chatId" = c."id"
            JOIN "Broadcast" b ON bc."broadcastId" = b."id"
            WHERE b."organizationId" = ${organizationId}
              AND b."sentAt" >= ${since}
              ${userCondition}
              ${messengerCondition}
            GROUP BY c."messenger", bc."status"
          `,
        ),

        // Daily counts via raw SQL (grouped by date + status)
        prisma.$queryRaw<Array<{ date: string; status: string; count: bigint }>>(
          Prisma.sql`
            SELECT bc."sentAt"::date::text as date, bc."status", COUNT(*)::bigint as count
            FROM "BroadcastChat" bc
            JOIN "Broadcast" b ON bc."broadcastId" = b."id"
            ${messenger ? Prisma.sql`JOIN "Chat" c ON bc."chatId" = c."id"` : Prisma.empty}
            WHERE b."organizationId" = ${organizationId}
              AND b."sentAt" >= ${since}
              AND bc."sentAt" IS NOT NULL
              ${userCondition}
              ${messengerCondition}
            GROUP BY bc."sentAt"::date, bc."status"
            ORDER BY date
          `,
        ),
      ]);

      // Convert statusCounts groupBy result into totals
      let totalAll = 0;
      let totalSent = 0;
      let totalFailed = 0;
      for (const row of statusCounts) {
        const count = row._count.status;
        totalAll += count;
        if (row.status === 'sent') totalSent += count;
        if (row.status === 'failed' || row.status === 'retry_exhausted') totalFailed += count;
      }
      const deliveryRate = totalAll > 0 ? totalSent / totalAll : 0;

      // Convert messengerStatusCounts into perMessenger map
      const perMessenger: Record<string, { sent: number; failed: number; total: number; deliveryRate: number }> = {};
      for (const row of messengerStatusCounts) {
        const m = row.messenger;
        if (!perMessenger[m]) {
          perMessenger[m] = { sent: 0, failed: 0, total: 0, deliveryRate: 0 };
        }
        const count = Number(row.count);
        perMessenger[m].total += count;
        if (row.status === 'sent') perMessenger[m].sent += count;
        if (row.status === 'failed' || row.status === 'retry_exhausted') perMessenger[m].failed += count;
      }
      for (const entry of Object.values(perMessenger)) {
        entry.deliveryRate = entry.total > 0 ? entry.sent / entry.total : 0;
      }

      // Convert dailyStatusCounts into dailyCounts array
      const dailyMap = new Map<string, { sent: number; failed: number }>();
      for (const row of dailyStatusCounts) {
        const dateStr = row.date;
        if (!dailyMap.has(dateStr)) {
          dailyMap.set(dateStr, { sent: 0, failed: 0 });
        }
        const entry = dailyMap.get(dateStr)!;
        const count = Number(row.count);
        if (row.status === 'sent') entry.sent += count;
        if (row.status === 'failed' || row.status === 'retry_exhausted') entry.failed += count;
      }
      const dailyCounts = Array.from(dailyMap.entries())
        .map(([date, counts]) => ({ date, ...counts }));

      return reply.send({
        totalSent,
        totalFailed,
        total: totalAll,
        deliveryRate,
        perMessenger,
        dailyCounts,
      });
    },
  );

  // ─── GET /broadcasts/:id ───

  fastify.get(
    '/broadcasts/:id',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsParsed = idParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', 'Invalid broadcast id', 422);
      }

      const { id } = paramsParsed.data;
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      const where: Record<string, unknown> = { id, organizationId };
      if (request.user.role === 'user') {
        where.createdById = request.user.id;
      }

      const broadcast = await prisma.broadcast.findFirst({
        where,
        include: {
          createdBy: { select: { id: true, name: true, email: true } },
          chats: {
            include: {
              chat: {
                select: {
                  id: true,
                  name: true,
                  messenger: true,
                  externalChatId: true,
                  chatType: true,
                },
              },
            },
          },
        },
      });

      if (!broadcast) {
        return sendError(reply, 'RESOURCE_NOT_FOUND', `Broadcast with id ${id} not found`, 404);
      }

      // Group chats by status
      const chatsByStatus: Record<string, typeof broadcast.chats> = {};
      for (const bc of broadcast.chats) {
        const arr = chatsByStatus[bc.status] ?? [];
        arr.push(bc);
        chatsByStatus[bc.status] = arr;
      }

      const totalChats = broadcast.chats.length;
      const sentCount = broadcast.chats.filter((c) => c.status === 'sent').length;
      const failedCount = broadcast.chats.filter((c) =>
        c.status === 'failed' || c.status === 'retry_exhausted',
      ).length;
      // Never attempted: the chat was missing, or the messenger halted mid-batch.
      // Neither delivered nor failed, so it needs its own bucket for the counts
      // to add up to the total.
      const skippedCount = broadcast.chats.filter((c) => c.status === 'skipped').length;
      const pendingCount = broadcast.chats.filter((c) =>
        c.status === 'pending' || c.status === 'retrying',
      ).length;

      return reply.send({
        id: broadcast.id,
        name: broadcast.name,
        messageText: broadcast.messageText,
        attachments: broadcast.attachments,
        status: broadcast.status,
        scheduledAt: broadcast.scheduledAt,
        sentAt: broadcast.sentAt,
        deliveryRate: broadcast.deliveryRate,
        templateId: broadcast.templateId,
        createdBy: broadcast.createdBy,
        createdAt: broadcast.createdAt,
        updatedAt: broadcast.updatedAt,
        stats: {
          total: totalChats,
          sent: sentCount,
          failed: failedCount,
          skipped: skippedCount,
          pending: pendingCount,
        },
        chatsByStatus,
      });
    },
  );

  // ─── GET /broadcasts/:id/stats ───
  // Lightweight live view: status + per-status counts + the most recent
  // delivery events. The detail endpoint above ships EVERY recipient row —
  // polling that every few seconds during a 1000-chat send re-transfers the
  // whole list each tick; this is what the live poll uses instead.

  fastify.get(
    '/broadcasts/:id/stats',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsParsed = idParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', 'Invalid broadcast id', 422);
      }

      const { id } = paramsParsed.data;
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      const where: Record<string, unknown> = { id, organizationId };
      if (request.user.role === 'user') {
        where.createdById = request.user.id;
      }

      const broadcast = await prisma.broadcast.findFirst({
        where,
        select: { id: true, status: true, deliveryRate: true, sentAt: true },
      });
      if (!broadcast) {
        return sendError(reply, 'RESOURCE_NOT_FOUND', `Broadcast with id ${id} not found`, 404);
      }

      const grouped = await prisma.broadcastChat.groupBy({
        by: ['status'],
        where: { broadcastId: id },
        _count: true,
      });
      const counts: Record<string, number> = {};
      let total = 0;
      for (const g of grouped) {
        counts[g.status] = g._count;
        total += g._count;
      }

      const recent = await prisma.broadcastChat.findMany({
        where: { broadcastId: id, status: { not: 'pending' } },
        orderBy: { updatedAt: 'desc' },
        take: 30,
        select: {
          chatId: true,
          status: true,
          errorReason: true,
          sentAt: true,
          updatedAt: true,
          chat: { select: { name: true, messenger: true } },
        },
      });

      // Per-messenger totals for the live breakdown cards. One grouped query
      // (messenger × status → count) so the poll stays cheap even on a big send —
      // messenger lives on Chat, so this joins rather than a plain groupBy.
      const byMessengerRows = await prisma.$queryRaw<
        Array<{ messenger: string; status: string; count: bigint }>
      >`
        SELECT c."messenger" AS messenger, bc."status" AS status, COUNT(*)::bigint AS count
        FROM "BroadcastChat" bc
        JOIN "Chat" c ON c."id" = bc."chatId"
        WHERE bc."broadcastId" = ${id}
        GROUP BY c."messenger", bc."status"
      `;
      const byMessengerMap: Record<string, { total: number; sent: number; failed: number }> = {};
      for (const row of byMessengerRows) {
        const bucket = (byMessengerMap[row.messenger] ??= { total: 0, sent: 0, failed: 0 });
        const n = Number(row.count);
        bucket.total += n;
        if (row.status === 'sent') bucket.sent += n;
        if (row.status === 'failed') bucket.failed += n;
      }
      const byMessenger = Object.entries(byMessengerMap).map(([messenger, s]) => ({
        messenger,
        ...s,
      }));

      return reply.send({
        id: broadcast.id,
        status: broadcast.status,
        deliveryRate: broadcast.deliveryRate,
        sentAt: broadcast.sentAt,
        total,
        counts,
        byMessenger,
        recent: recent.map((r) => ({
          chatId: r.chatId,
          chatName: r.chat?.name ?? 'Unknown chat',
          messenger: r.chat?.messenger ?? 'telegram',
          status: r.status,
          error: r.errorReason ?? undefined,
          sentAt: r.sentAt,
          updatedAt: r.updatedAt,
        })),
      });
    },
  );

  // ─── POST /broadcasts ───

  fastify.post(
    '/broadcasts',
    { preHandler: broadcastPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = createBroadcastBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 422);
      }

      const { name, messageText: rawMessageText, chatIds, scheduledAt, templateId, attachments, senderConfig } = parsed.data;
      // Store the text exactly as typed — display is React-escaped and no
      // messenger send path renders HTML (Telegram=Markdown, others plain),
      // so stripping "<...>" only destroyed legitimate content like <Name> (M13).
      const messageText = rawMessageText;
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }
      // A past schedule would fire instantly but be labelled "scheduled" —
      // reject it (small grace for clock skew / submit latency).
      if (scheduledAt && scheduledAt.getTime() <= Date.now() - 60_000) {
        return sendError(reply, 'VALIDATION_ERROR', 'Scheduled time must be in the future', 422);
      }

      // Validate all chatIds belong to this org. Role `user` is further
      // restricted to chats they own (via ChatOwner) — canViewAllChats only
      // affects viewing, never broadcasting (explicit requirement).
      const isPlainUser = request.user.role === 'user';
      const validChats = await prisma.chat.findMany({
        where: {
          id: { in: chatIds },
          organizationId,
          ...(isPlainUser ? { owners: { some: { userId: request.user.id } } } : {}),
        },
        select: { id: true },
      });
      const validChatIds = validChats.map((c) => c.id);

      if (isPlainUser && validChatIds.length !== new Set(chatIds).size) {
        return sendError(reply, 'VALIDATION_ERROR', 'You can only broadcast to chats assigned to you', 422);
      }

      if (validChatIds.length === 0) {
        return sendError(reply, 'VALIDATION_ERROR', 'No valid chats found in this organization', 422);
      }

      // Validate templateId if provided
      if (templateId) {
        const template = await prisma.template.findFirst({
          where: { id: templateId, organizationId },
        });
        if (!template) {
          return sendError(reply, 'RESOURCE_NOT_FOUND', `Template with id ${templateId} not found`, 404);
        }
      }

      const senderCheck = await validateSenderConfig(request, organizationId, senderConfig);
      if (!senderCheck.ok) {
        return sendError(reply, 'VALIDATION_ERROR', senderCheck.message, 422);
      }

      const broadcast = await prisma.$transaction(async (tx) => {
        const b = await tx.broadcast.create({
          data: {
            name,
            messageText,
            attachments: attachments ?? undefined,
            status: scheduledAt ? 'scheduled' : 'draft',
            scheduledAt: scheduledAt ?? undefined,
            organizationId,
            createdById: request.user.id,
            templateId: templateId ?? undefined,
            senderConfig: senderConfig ?? undefined,
          },
        });

        await tx.broadcastChat.createMany({
          data: validChatIds.map((chatId) => ({
            broadcastId: b.id,
            chatId,
            status: 'pending',
          })),
        });

        return b;
      });

      // If scheduled, enqueue delayed job
      if (scheduledAt) {
        const delay = Math.max(0, scheduledAt.getTime() - Date.now());
        await broadcastQueue.add(
          'broadcast:send',
          { broadcastId: broadcast.id, organizationId },
          { delay, jobId: `broadcast-${broadcast.id}` },
        );
      }

      const full = await prisma.broadcast.findFirst({
        where: { id: broadcast.id },
        include: {
          createdBy: { select: { id: true, name: true, email: true } },
          chats: { select: { id: true, chatId: true, status: true } },
        },
      });

      logActivity({
        category: 'broadcast',
        action: 'created',
        description: `Broadcast "${name}" created (${validChatIds.length} chat${validChatIds.length === 1 ? '' : 's'})`,
        targetType: 'broadcast',
        targetId: broadcast.id,
        userId: request.user.id,
        userName: request.user.name,
        organizationId,
      }).catch(() => { /* non-critical */ });

      return reply.status(201).send(full);
    },
  );

  // ─── PATCH /broadcasts/:id ───

  fastify.patch(
    '/broadcasts/:id',
    { preHandler: broadcastPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsParsed = idParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', 'Invalid broadcast id', 422);
      }

      const bodyParsed = updateBroadcastBodySchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', bodyParsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 422);
      }

      const { id } = paramsParsed.data;
      const { name, messageText: rawMessageText, chatIds, scheduledAt, senderConfig } = bodyParsed.data;
      const messageText = rawMessageText;
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }
      if (scheduledAt && scheduledAt.getTime() <= Date.now() - 60_000) {
        return sendError(reply, 'VALIDATION_ERROR', 'Scheduled time must be in the future', 422);
      }

      const existing = await prisma.broadcast.findFirst({
        where: { id, organizationId },
      });
      if (!existing) {
        return sendError(reply, 'RESOURCE_NOT_FOUND', `Broadcast with id ${id} not found`, 404);
      }

      if (existing.status !== 'draft' && existing.status !== 'scheduled') {
        return sendError(reply, 'VALIDATION_ERROR', 'Only draft or scheduled broadcasts can be updated', 422);
      }

      const isPlainUser = request.user.role === 'user';

      if (senderConfig !== undefined) {
        const senderCheck = await validateSenderConfig(request, organizationId, senderConfig);
        if (!senderCheck.ok) {
          return sendError(reply, 'VALIDATION_ERROR', senderCheck.message, 422);
        }
      }

      const updated = await prisma.$transaction(async (tx) => {
        const updateData: Record<string, unknown> = {};
        if (name !== undefined) updateData.name = name;
        if (messageText !== undefined) updateData.messageText = messageText;
        if (senderConfig !== undefined) updateData.senderConfig = senderConfig;
        if (scheduledAt !== undefined) {
          updateData.scheduledAt = scheduledAt;
          updateData.status = scheduledAt ? 'scheduled' : 'draft';
        }

        const b = await tx.broadcast.update({
          where: { id },
          data: updateData,
        });

        // Replace chatIds if provided. Same ChatOwner scoping as create —
        // canViewAllChats never grants broadcast rights.
        if (chatIds !== undefined) {
          const validChats = await tx.chat.findMany({
            where: {
              id: { in: chatIds },
              organizationId,
              ...(isPlainUser ? { owners: { some: { userId: request.user.id } } } : {}),
            },
            select: { id: true },
          });
          const validChatIds = validChats.map((c) => c.id);

          if (isPlainUser && validChatIds.length !== new Set(chatIds).size) {
            throw new Error('NOT_OWNED_CHATS');
          }

          if (validChatIds.length === 0) {
            throw new Error('NO_VALID_CHATS');
          }

          await tx.broadcastChat.deleteMany({ where: { broadcastId: id } });
          await tx.broadcastChat.createMany({
            data: validChatIds.map((chatId) => ({
              broadcastId: id,
              chatId,
              status: 'pending',
            })),
          });
        }

        return b;
      }).catch((err) => {
        if (err instanceof Error && (err.message === 'NO_VALID_CHATS' || err.message === 'NOT_OWNED_CHATS')) {
          return err.message;
        }
        throw err;
      });

      if (updated === 'NO_VALID_CHATS') {
        return sendError(reply, 'VALIDATION_ERROR', 'No valid chats found in this organization', 422);
      }
      if (updated === 'NOT_OWNED_CHATS') {
        return sendError(reply, 'VALIDATION_ERROR', 'You can only broadcast to chats assigned to you', 422);
      }

      // Update scheduled job if scheduledAt changed
      if (scheduledAt !== undefined) {
        // Remove old job
        const oldJob = await broadcastQueue.getJob(`broadcast-${id}`);
        if (oldJob) await oldJob.remove();

        // Add new job if scheduled
        if (scheduledAt) {
          const delay = Math.max(0, scheduledAt.getTime() - Date.now());
          await broadcastQueue.add(
            'broadcast:send',
            { broadcastId: id, organizationId },
            { delay, jobId: `broadcast-${id}` },
          );
        }
      }

      const full = await prisma.broadcast.findFirst({
        where: { id },
        include: {
          createdBy: { select: { id: true, name: true, email: true } },
          chats: { select: { id: true, chatId: true, status: true } },
        },
      });

      return reply.send(full);
    },
  );

  // ─── DELETE /broadcasts/:id ───

  fastify.delete(
    '/broadcasts/:id',
    { preHandler: broadcastPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsParsed = idParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', 'Invalid broadcast id', 422);
      }

      const { id } = paramsParsed.data;
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      const existing = await prisma.broadcast.findFirst({
        where: { id, organizationId },
      });
      if (!existing) {
        return sendError(reply, 'RESOURCE_NOT_FOUND', `Broadcast with id ${id} not found`, 404);
      }

      if (existing.status === 'sending' || existing.status === 'canceling') {
        return sendError(reply, 'VALIDATION_ERROR', 'Cannot delete a broadcast that is currently sending', 422);
      }

      // Remove scheduled job if exists
      const scheduledJob = await broadcastQueue.getJob(`broadcast-${id}`);
      if (scheduledJob) await scheduledJob.remove();

      await prisma.broadcast.delete({ where: { id } });

      logActivity({
        category: 'broadcast',
        action: 'deleted',
        description: `Broadcast "${existing.name}" deleted`,
        targetType: 'broadcast',
        targetId: id,
        userId: request.user.id,
        userName: request.user.name,
        organizationId,
      }).catch(() => { /* non-critical */ });

      return reply.status(204).send();
    },
  );

  // ─── POST /broadcasts/:id/send ───

  fastify.post(
    '/broadcasts/:id/send',
    { preHandler: broadcastPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsParsed = idParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', 'Invalid broadcast id', 422);
      }

      const { id } = paramsParsed.data;
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      // Atomic status transition to prevent race conditions
      const updated = await prisma.broadcast.updateMany({
        where: { id, organizationId, status: { in: ['draft', 'scheduled'] } },
        data: { status: 'sending', sentAt: new Date() },
      });
      if (updated.count === 0) {
        const broadcast = await prisma.broadcast.findUnique({ where: { id } });
        if (!broadcast || broadcast.organizationId !== organizationId) {
          return sendError(reply, 'RESOURCE_NOT_FOUND', `Broadcast with id ${id} not found`, 404);
        }
        return reply.status(409).send({ error: { code: 'BROADCAST_ALREADY_SENT', message: `Broadcast is already ${broadcast.status}`, statusCode: 409 } });
      }

      // Check for overlapping chats with other active broadcasts (antiban protection)
      const overlapping = await prisma.broadcastChat.findMany({
        where: {
          broadcastId: id,
          chat: {
            broadcastChats: {
              some: {
                broadcastId: { not: id },
                broadcast: { status: 'sending', organizationId },
              },
            },
          },
        },
        select: { chatId: true },
        take: 5,
      });
      if (overlapping.length > 0) {
        // Roll back status
        await prisma.broadcast.update({ where: { id }, data: { status: 'draft', sentAt: null } });
        return reply.status(409).send({
          error: {
            code: 'BROADCAST_CHAT_OVERLAP',
            message: `${overlapping.length} chat(s) are already targeted by an active broadcast. Wait for it to finish or remove overlapping chats.`,
            statusCode: 409,
          },
        });
      }

      // Verify broadcast has recipient chats
      const chatCount = await prisma.broadcastChat.count({ where: { broadcastId: id } });
      if (chatCount === 0) {
        // Roll back status
        await prisma.broadcast.update({ where: { id }, data: { status: 'draft', sentAt: null } });
        return sendError(reply, 'VALIDATION_ERROR', 'Broadcast has no recipient chats', 422);
      }

      // Remove scheduled job if exists (in case of early manual send)
      const scheduledJob = await broadcastQueue.getJob(`broadcast-${id}`);
      if (scheduledJob) await scheduledJob.remove();

      // Enqueue broadcast job
      await broadcastQueue.add(
        'broadcast:send',
        { broadcastId: id, organizationId },
        { jobId: `broadcast-${id}-${Date.now()}` },
      );

      // Emit real-time status
      try {
        const io = getIO();
        io.to(`org:${organizationId}`).emit('broadcast_status', {
          broadcastId: id,
          status: 'sending',
        });
      } catch {
        // WebSocket might not be initialized in tests
      }

      prisma.broadcast.findUnique({ where: { id }, select: { name: true } }).then((b) => {
        if (!b) return;
        return logActivity({
          category: 'broadcast',
          action: 'sent',
          description: `Broadcast "${b.name}" started sending (${chatCount} chat${chatCount === 1 ? '' : 's'})`,
          targetType: 'broadcast',
          targetId: id,
          userId: request.user.id,
          userName: request.user.name,
          organizationId,
        });
      }).catch(() => { /* non-critical */ });

      return reply.send({ success: true });
    },
  );

  // ─── POST /broadcasts/:id/cancel ───
  // Scheduled → canceled immediately (delayed job removed, recipients marked
  // skipped). Sending → 'canceling': the worker owns the in-flight rows and
  // bails at the next message boundary, then finalizes to 'canceled'.

  fastify.post(
    '/broadcasts/:id/cancel',
    { preHandler: broadcastPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsParsed = idParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', 'Invalid broadcast id', 422);
      }

      const { id } = paramsParsed.data;
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      // Scheduled: nothing is in flight — cancel outright.
      const canceledScheduled = await prisma.broadcast.updateMany({
        where: { id, organizationId, status: 'scheduled' },
        data: { status: 'canceled' },
      });
      if (canceledScheduled.count > 0) {
        const scheduledJob = await broadcastQueue.getJob(`broadcast-${id}`);
        if (scheduledJob) await scheduledJob.remove();
        await prisma.broadcastChat.updateMany({
          where: { broadcastId: id, status: 'pending' },
          data: { status: 'skipped', errorReason: 'Broadcast canceled' },
        });
        emitBroadcastStatus(organizationId, id, 'canceled');
        logBroadcastCancel(request, organizationId, id, 'canceled');
        return reply.send({ success: true, status: 'canceled' });
      }

      // Sending: flag it; the worker stops between messages and finalizes.
      const canceling = await prisma.broadcast.updateMany({
        where: { id, organizationId, status: 'sending' },
        data: { status: 'canceling' },
      });
      if (canceling.count > 0) {
        emitBroadcastStatus(organizationId, id, 'canceling');
        logBroadcastCancel(request, organizationId, id, 'canceling');
        return reply.send({ success: true, status: 'canceling' });
      }

      const broadcast = await prisma.broadcast.findUnique({ where: { id } });
      if (!broadcast || broadcast.organizationId !== organizationId) {
        return sendError(reply, 'RESOURCE_NOT_FOUND', `Broadcast with id ${id} not found`, 404);
      }
      return reply.status(409).send({
        error: {
          code: 'BROADCAST_NOT_CANCELABLE',
          message: `Only scheduled or sending broadcasts can be canceled (this one is ${broadcast.status})`,
          statusCode: 409,
        },
      });
    },
  );

  // ─── POST /broadcasts/:id/retry ───

  fastify.post(
    '/broadcasts/:id/retry',
    { preHandler: broadcastPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsParsed = idParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', 'Invalid broadcast id', 422);
      }

      const { id } = paramsParsed.data;
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      // Atomic status transition to prevent race conditions
      const retryUpdated = await prisma.broadcast.updateMany({
        where: { id, organizationId, status: { in: ['partially_failed', 'failed', 'sent'] } },
        data: { status: 'sending' },
      });
      if (retryUpdated.count === 0) {
        const broadcast = await prisma.broadcast.findUnique({ where: { id } });
        if (!broadcast || broadcast.organizationId !== organizationId) {
          return sendError(reply, 'RESOURCE_NOT_FOUND', `Broadcast with id ${id} not found`, 404);
        }
        return reply.status(409).send({ error: { code: 'BROADCAST_ALREADY_SENT', message: `Broadcast is already ${broadcast.status}`, statusCode: 409 } });
      }

      // Failures the adapter marked as permanent are terminal: retrying either
      // duplicates a message that already arrived, or repeats an identical
      // failure. `skipped` chats are excluded automatically — they are neither
      // `failed` nor `retry_exhausted`.
      const nonRetriable = await prisma.broadcastChat.updateMany({
        where: {
          broadcastId: id,
          status: 'failed',
          OR: NON_RETRIABLE_REASON_PREFIXES.map((prefix) => ({
            errorReason: { startsWith: prefix },
          })),
        },
        data: { status: 'retry_exhausted' },
      });

      // Reset the genuinely failed chats to retrying. `errorReason: null` would
      // otherwise be matched by `NOT startsWith`, so spell the null case out.
      const resetResult = await prisma.broadcastChat.updateMany({
        where: {
          broadcastId: id,
          status: { in: ['failed', 'retry_exhausted'] },
          AND: NON_RETRIABLE_REASON_PREFIXES.map((prefix) => ({
            OR: [
              { errorReason: null },
              { NOT: { errorReason: { startsWith: prefix } } },
            ],
          })),
        },
        data: { status: 'retrying', errorReason: null },
      });

      if (resetResult.count === 0) {
        // Roll back broadcast status — no failed chats to retry
        await prisma.broadcast.update({ where: { id }, data: { status: 'partially_failed' } });
        return sendError(
          reply,
          'VALIDATION_ERROR',
          nonRetriable.count > 0
            ? `No chats can be retried: ${nonRetriable.count} cannot be sent again without risking a duplicate or repeating the same failure`
            : 'No failed chats to retry',
          422,
        );
      }

      // Enqueue retry job
      await broadcastQueue.add(
        'broadcast:retry',
        { broadcastId: id, organizationId },
        { jobId: `broadcast-retry-${id}-${Date.now()}` },
      );

      // Emit real-time status
      try {
        const io = getIO();
        io.to(`org:${organizationId}`).emit('broadcast_status', {
          broadcastId: id,
          status: 'sending',
          retrying: true,
        });
      } catch {
        // WebSocket might not be initialized
      }

      return reply.send({ success: true });
    },
  );

  // ─── POST /broadcasts/:id/duplicate ───

  fastify.post(
    '/broadcasts/:id/duplicate',
    { preHandler: broadcastPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsParsed = idParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', 'Invalid broadcast id', 422);
      }

      const { id } = paramsParsed.data;
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      const original = await prisma.broadcast.findFirst({
        where: { id, organizationId },
        include: {
          chats: { select: { chatId: true } },
        },
      });
      if (!original) {
        return sendError(reply, 'RESOURCE_NOT_FOUND', `Broadcast with id ${id} not found`, 404);
      }

      const duplicate = await prisma.$transaction(async (tx) => {
        const b = await tx.broadcast.create({
          data: {
            name: `${original.name} (copy)`,
            messageText: original.messageText,
            attachments: original.attachments ?? undefined,
            status: 'draft',
            organizationId,
            createdById: request.user.id,
            templateId: original.templateId ?? undefined,
            // Copy the sender too — a duplicate that silently reset to the
            // legacy default sender would send from the wrong identity.
            senderConfig: original.senderConfig ?? undefined,
          },
        });

        if (original.chats.length > 0) {
          await tx.broadcastChat.createMany({
            data: original.chats.map((bc) => ({
              broadcastId: b.id,
              chatId: bc.chatId,
              status: 'pending',
            })),
          });
        }

        return b;
      });

      const full = await prisma.broadcast.findFirst({
        where: { id: duplicate.id },
        include: {
          createdBy: { select: { id: true, name: true, email: true } },
          chats: { select: { id: true, chatId: true, status: true } },
        },
      });

      logActivity({
        category: 'broadcast',
        action: 'duplicated',
        description: `Broadcast "${original.name}" duplicated as "${duplicate.name}"`,
        targetType: 'broadcast',
        targetId: duplicate.id,
        userId: request.user.id,
        userName: request.user.name,
        organizationId,
      }).catch(() => { /* non-critical */ });

      return reply.status(201).send(full);
    },
  );
}
