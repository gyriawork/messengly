import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma.js';
import { authenticate } from '../middleware/auth.js';
import { requireMinRole, getOrgId } from '../middleware/rbac.js';
import { broadcastQueue } from '../lib/queue.js';
import { getIO } from '../websocket/index.js';

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
  'draft', 'scheduled', 'sending', 'sent', 'partially_failed', 'failed',
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

const createBroadcastBodySchema = z.object({
  name: z.string().min(1).max(500),
  messageText: z.string().min(1).max(10000),
  chatIds: z.array(z.string().uuid()).min(1).max(10000),
  scheduledAt: z.coerce.date().optional(),
  templateId: z.string().uuid().optional(),
  attachments: z.any().optional(),
});

const updateBroadcastBodySchema = z.object({
  name: z.string().min(1).max(500).optional(),
  messageText: z.string().min(1).max(10000).optional(),
  chatIds: z.array(z.string().uuid()).min(1).max(10000).optional(),
  scheduledAt: z.coerce.date().nullable().optional(),
});

const analyticsQuerySchema = z.object({
  period: z.string().regex(/^\d+d$/).default('30d'),
  messenger: z.enum(['telegram', 'slack', 'whatsapp', 'gmail', 'teams']).optional(),
});

// ─── Helpers ───

/** Strip HTML tags from broadcast message text to prevent XSS when rendered. */
function stripHtml(text: string): string {
  return text.replace(/<[^>]*>/g, '');
}

function sendError(reply: FastifyReply, code: string, message: string, statusCode: number) {
  return reply.status(statusCode).send({
    error: { code, message, statusCode },
  });
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

  // ─── POST /broadcasts ───

  fastify.post(
    '/broadcasts',
    { preHandler: broadcastPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = createBroadcastBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 422);
      }

      const { name, messageText: rawMessageText, chatIds, scheduledAt, templateId, attachments } = parsed.data;
      const messageText = stripHtml(rawMessageText);
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      // Validate all chatIds belong to this org
      const validChats = await prisma.chat.findMany({
        where: { id: { in: chatIds }, organizationId },
        select: { id: true },
      });
      const validChatIds = validChats.map((c) => c.id);

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
      const { name, messageText: rawMessageText, chatIds, scheduledAt } = bodyParsed.data;
      const messageText = rawMessageText !== undefined ? stripHtml(rawMessageText) : undefined;
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

      if (existing.status !== 'draft' && existing.status !== 'scheduled') {
        return sendError(reply, 'VALIDATION_ERROR', 'Only draft or scheduled broadcasts can be updated', 422);
      }

      const updated = await prisma.$transaction(async (tx) => {
        const updateData: Record<string, unknown> = {};
        if (name !== undefined) updateData.name = name;
        if (messageText !== undefined) updateData.messageText = messageText;
        if (scheduledAt !== undefined) {
          updateData.scheduledAt = scheduledAt;
          updateData.status = scheduledAt ? 'scheduled' : 'draft';
        }

        const b = await tx.broadcast.update({
          where: { id },
          data: updateData,
        });

        // Replace chatIds if provided
        if (chatIds !== undefined) {
          const validChats = await tx.chat.findMany({
            where: { id: { in: chatIds }, organizationId },
            select: { id: true },
          });
          const validChatIds = validChats.map((c) => c.id);

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
        if (err instanceof Error && err.message === 'NO_VALID_CHATS') {
          return null;
        }
        throw err;
      });

      if (updated === null) {
        return sendError(reply, 'VALIDATION_ERROR', 'No valid chats found in this organization', 422);
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

      if (existing.status === 'sending') {
        return sendError(reply, 'VALIDATION_ERROR', 'Cannot delete a broadcast that is currently sending', 422);
      }

      // Remove scheduled job if exists
      const scheduledJob = await broadcastQueue.getJob(`broadcast-${id}`);
      if (scheduledJob) await scheduledJob.remove();

      await prisma.broadcast.delete({ where: { id } });

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

      return reply.send({ success: true });
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

      return reply.status(201).send(full);
    },
  );
}
