import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
import { authenticate } from '../middleware/auth.js';
import { requireMinRole, getOrgId } from '../middleware/rbac.js';
import { cacheGet, cacheSet, cacheInvalidate, cacheKey } from '../lib/cache.js';
type Messenger = 'telegram' | 'slack' | 'whatsapp' | 'gmail' | 'teams';

const DEFAULT_ANTIBAN: Record<Messenger, {
  messagesPerBatch: number;
  delayBetweenMessages: number;
  delayBetweenBatches: number;
  maxMessagesPerHour: number;
  maxMessagesPerDay: number;
}> = {
  telegram: { messagesPerBatch: 10, delayBetweenMessages: 5, delayBetweenBatches: 180, maxMessagesPerHour: 50, maxMessagesPerDay: 300 },
  whatsapp: { messagesPerBatch: 3, delayBetweenMessages: 15, delayBetweenBatches: 600, maxMessagesPerHour: 20, maxMessagesPerDay: 80 },
  slack: { messagesPerBatch: 30, delayBetweenMessages: 1, delayBetweenBatches: 30, maxMessagesPerHour: 200, maxMessagesPerDay: 2000 },
  gmail: { messagesPerBatch: 5, delayBetweenMessages: 8, delayBetweenBatches: 180, maxMessagesPerHour: 80, maxMessagesPerDay: 400 },
  // Browser automation: slow and conspicuous. The teams-agent adds 3–10s of
  // random jitter on top of these deterministic delays.
  teams: { messagesPerBatch: 5, delayBetweenMessages: 8, delayBetweenBatches: 300, maxMessagesPerHour: 40, maxMessagesPerDay: 200 },
};

// ─── Zod Schemas ───

const messengerEnum = z.enum(['telegram', 'slack', 'whatsapp', 'gmail', 'teams']);

const messengerParamSchema = z.object({
  messenger: messengerEnum,
});

const updateAntibanBodySchema = z.object({
  messagesPerBatch: z.number().int().min(1).max(1000),
  // Float: the UI slider steps by 0.5s, so an int() schema 422'd on half-seconds.
  delayBetweenMessages: z.number().min(0).max(3600),
  delayBetweenBatches: z.number().int().min(0).max(86400),
  maxMessagesPerHour: z.number().int().min(1).max(10000),
  maxMessagesPerDay: z.number().int().min(1).max(100000),
  autoRetryEnabled: z.boolean().optional(),
  maxRetryAttempts: z.number().int().min(0).max(10).optional(),
  retryWindowHours: z.number().int().min(1).max(72).optional(),
});

const riskScoreQuerySchema = z.object({
  messenger: messengerEnum,
  messagesPerBatch: z.coerce.number().int().min(1),
  delayBetweenMessages: z.coerce.number().min(0),
  delayBetweenBatches: z.coerce.number().int().min(0),
  maxMessagesPerHour: z.coerce.number().int().min(1),
  maxMessagesPerDay: z.coerce.number().int().min(1),
});

// ─── Helpers ───

function sendError(reply: FastifyReply, code: string, message: string, statusCode: number) {
  return reply.status(statusCode).send({
    error: { code, message, statusCode },
  });
}

/**
 * Calculate risk score 0-100 based on how aggressive the antiban settings are
 * compared to the defaults for the given messenger.
 *
 * Higher batch sizes and lower delays = higher risk.
 */
function calculateRiskScore(
  messenger: Messenger,
  settings: {
    messagesPerBatch: number;
    delayBetweenMessages: number;
    delayBetweenBatches: number;
    maxMessagesPerHour: number;
    maxMessagesPerDay: number;
  },
): { score: number; zone: 'safe' | 'moderate' | 'risky' | 'dangerous'; description: string } {
  const defaults = DEFAULT_ANTIBAN[messenger];

  // Calculate ratios: how far the settings are from defaults.
  // For batch size / max messages: higher = riskier, so ratio > 1 = more aggressive
  // For delays: lower = riskier, so inverted ratio < 1 = more aggressive

  const batchRatio = settings.messagesPerBatch / defaults.messagesPerBatch;
  const hourlyRatio = settings.maxMessagesPerHour / defaults.maxMessagesPerHour;
  const dailyRatio = settings.maxMessagesPerDay / defaults.maxMessagesPerDay;

  // For delays, invert: lower delay = higher risk. Use max(1, ...) to avoid division by zero.
  const msgDelayRatio = Math.max(1, defaults.delayBetweenMessages) / Math.max(1, settings.delayBetweenMessages);
  const batchDelayRatio = Math.max(1, defaults.delayBetweenBatches) / Math.max(1, settings.delayBetweenBatches);

  // Weight each factor
  const weightedScore =
    batchRatio * 20 +
    msgDelayRatio * 25 +
    batchDelayRatio * 20 +
    hourlyRatio * 20 +
    dailyRatio * 15;

  // weightedScore of 100 means exactly at defaults. Normalize: defaults = ~25 score.
  // Scale so defaults ≈ 25, 2x aggressive ≈ 50, 4x ≈ 75, etc.
  const normalizedScore = Math.min(100, Math.round((weightedScore / 100) * 25));

  // Clamp
  const score = Math.max(0, Math.min(100, normalizedScore));

  let zone: 'safe' | 'moderate' | 'risky' | 'dangerous';
  let description: string;

  if (score <= 25) {
    zone = 'safe';
    description = 'You\u2019re sending at a relaxed pace. Accounts stay comfortably under the radar.';
  } else if (score <= 50) {
    zone = 'moderate';
    description = 'A bit brisk. Smaller batches or longer pauses would make this safer.';
  } else if (score <= 75) {
    zone = 'risky';
    description = 'This pace can look like spam to the messengers. Worth slowing down.';
  } else {
    zone = 'dangerous';
    description = 'At this speed a ban is a real possibility. Ease off the volume and add delays.';
  }

  return { score, zone, description };
}

// ─── Plugin ───

export default async function settingsRoutes(fastify: FastifyInstance): Promise<void> {
  const authPreHandlers = [authenticate];
  const adminPreHandlers = [authenticate, requireMinRole('admin')];

  // ─── GET /settings/antiban ───

  fastify.get(
    '/settings/antiban',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      const ck = cacheKey(organizationId, 'settings', 'antiban');
      const cached = await cacheGet(ck);
      if (cached) return reply.send(cached);

      const settings = await prisma.antibanSettings.findMany({
        where: { organizationId },
      });

      // Build response with defaults for missing messengers
      const messengers: Messenger[] = ['telegram', 'slack', 'whatsapp', 'gmail', 'teams'];
      const result: Record<string, unknown> = {};

      for (const m of messengers) {
        const existing = settings.find((s) => s.messenger === m);
        if (existing) {
          result[m] = {
            id: existing.id,
            messenger: existing.messenger,
            messagesPerBatch: existing.messagesPerBatch,
            delayBetweenMessages: existing.delayBetweenMessages,
            delayBetweenBatches: existing.delayBetweenBatches,
            maxMessagesPerHour: existing.maxMessagesPerHour,
            maxMessagesPerDay: existing.maxMessagesPerDay,
            autoRetryEnabled: existing.autoRetryEnabled,
            maxRetryAttempts: existing.maxRetryAttempts,
            retryWindowHours: existing.retryWindowHours,
          };
        } else {
          const defaults = DEFAULT_ANTIBAN[m];
          result[m] = {
            id: null,
            messenger: m,
            ...defaults,
            autoRetryEnabled: true,
            maxRetryAttempts: 3,
            retryWindowHours: 6,
          };
        }
      }

      await cacheSet(ck, result, 300);
      return reply.send(result);
    },
  );

  // ─── PATCH /settings/antiban/:messenger ───

  fastify.patch(
    '/settings/antiban/:messenger',
    { preHandler: adminPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsParsed = messengerParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', 'Invalid messenger type', 422);
      }

      const bodyParsed = updateAntibanBodySchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', bodyParsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 422);
      }

      const { messenger } = paramsParsed.data;
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      const {
        messagesPerBatch,
        delayBetweenMessages,
        delayBetweenBatches,
        maxMessagesPerHour,
        maxMessagesPerDay,
        autoRetryEnabled,
        maxRetryAttempts,
        retryWindowHours,
      } = bodyParsed.data;

      const upserted = await prisma.antibanSettings.upsert({
        where: {
          messenger_organizationId: {
            messenger,
            organizationId,
          },
        },
        update: {
          messagesPerBatch,
          delayBetweenMessages,
          delayBetweenBatches,
          maxMessagesPerHour,
          maxMessagesPerDay,
          autoRetryEnabled: autoRetryEnabled ?? undefined,
          maxRetryAttempts: maxRetryAttempts ?? undefined,
          retryWindowHours: retryWindowHours ?? undefined,
        },
        create: {
          messenger,
          organizationId,
          messagesPerBatch,
          delayBetweenMessages,
          delayBetweenBatches,
          maxMessagesPerHour,
          maxMessagesPerDay,
          autoRetryEnabled: autoRetryEnabled ?? true,
          maxRetryAttempts: maxRetryAttempts ?? 3,
          retryWindowHours: retryWindowHours ?? 6,
        },
      });

      await cacheInvalidate(cacheKey(organizationId, 'settings', '*'));

      return reply.send({
        id: upserted.id,
        messenger: upserted.messenger,
        messagesPerBatch: upserted.messagesPerBatch,
        delayBetweenMessages: upserted.delayBetweenMessages,
        delayBetweenBatches: upserted.delayBetweenBatches,
        maxMessagesPerHour: upserted.maxMessagesPerHour,
        maxMessagesPerDay: upserted.maxMessagesPerDay,
        autoRetryEnabled: upserted.autoRetryEnabled,
        maxRetryAttempts: upserted.maxRetryAttempts,
        retryWindowHours: upserted.retryWindowHours,
      });
    },
  );

  // ─── GET /settings/antiban/risk-score ───

  fastify.get(
    '/settings/antiban/risk-score',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = riskScoreQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; '), 422);
      }

      const { messenger, ...settings } = parsed.data;
      const result = calculateRiskScore(messenger, settings);

      return reply.send(result);
    },
  );
}
