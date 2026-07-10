import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
import { authenticate } from '../middleware/auth.js';

const analyticsQuerySchema = z.object({
  period: z.enum(['week', 'month', 'quarter']).optional().default('month'),
  messenger: z.enum(['telegram', 'slack', 'whatsapp', 'gmail', 'teams']).optional(),
  createdBy: z.string().uuid().optional(),
  scope: z.enum(['org', 'my']).optional(),
});

function getDateFilter(period: string): { gte: Date } {
  const now = new Date();
  switch (period) {
    case 'week':
      return { gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) };
    case 'quarter':
      return { gte: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000) };
    case 'month':
    default:
      return { gte: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) };
  }
}

export default async function broadcastAnalyticsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/broadcasts/analytics',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = analyticsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(422).send({
          error: { code: 'VALIDATION_ERROR', message: parsed.error.issues[0].message, statusCode: 422 },
        });
      }
      const { period, messenger, createdBy, scope } = parsed.data;

      const orgId = request.user.organizationId;
      if (!orgId) {
        return reply.status(403).send({
          error: { code: 'AUTH_INSUFFICIENT_PERMISSIONS', message: 'No organization', statusCode: 403 },
        });
      }

      const dateFilter = getDateFilter(period ?? 'month');

      const where: Record<string, unknown> = {
        organizationId: orgId,
        createdAt: dateFilter,
      };
      if (messenger) where.messenger = messenger;
      if (createdBy) where.createdById = createdBy;
      // User role: only own broadcasts; Admin with scope=my: also only own
      if (request.user.role === 'user' || scope === 'my') where.createdById = request.user.id;

      const broadcasts = await prisma.broadcast.findMany({
        where,
        include: {
          chats: {
            select: { status: true, chat: { select: { messenger: true } } },
          },
        },
      });

      const total = broadcasts.length;
      let totalSent = 0;
      let totalDelivered = 0;
      let totalFailed = 0;
      const byMessenger: Record<string, { sent: number; delivered: number; failed: number }> = {};

      for (const b of broadcasts) {
        for (const bc of b.chats) {
          const m = bc.chat.messenger;
          if (!byMessenger[m]) byMessenger[m] = { sent: 0, delivered: 0, failed: 0 };
          totalSent++;
          byMessenger[m].sent++;
          if (bc.status === 'sent') {
            totalDelivered++;
            byMessenger[m].delivered++;
          }
          if (bc.status === 'failed' || bc.status === 'retry_exhausted') {
            totalFailed++;
            byMessenger[m].failed++;
          }
        }
      }

      return reply.send({
        global: {
          totalBroadcasts: total,
          totalMessages: totalSent,
          deliveryRate: totalSent > 0 ? totalDelivered / totalSent : 0,
          failedCount: totalFailed,
        },
        byMessenger: Object.entries(byMessenger).map(([m, stats]) => ({
          messenger: m,
          ...stats,
          deliveryRate: stats.sent > 0 ? stats.delivered / stats.sent : 0,
        })),
      });
    },
  );
}
