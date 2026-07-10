import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma.js';
import { authenticate } from '../middleware/auth.js';
import { getOrgId } from '../middleware/rbac.js';

// ─── Constants ───

const MESSENGERS = ['telegram', 'slack', 'whatsapp', 'gmail', 'teams'] as const;
type Messenger = (typeof MESSENGERS)[number];

// ─── Schema ───

const querySchema = z.object({
  scope: z.enum(['my', 'org']).default('my'),
  period: z.enum(['7d', '30d', '90d']).default('30d'),
  granularity: z.enum(['day', 'week', 'month']).default('day'),
  userId: z.string().uuid().optional(),
});

// ─── Types ───

interface DeltaValue {
  value: number;
  deltaPct: number | null;
}

interface ChatsKpi {
  active: number;
  inactive: number;
  deltaPctActive: number | null;
}

interface PerMessengerStats {
  count: number;
  percent: number;
  activeChats: number;
  inactiveChats: number;
}

interface TrendBucket {
  bucket: string;
  total: number;
  byMessenger: Record<Messenger, number>;
}

interface HeatmapCell {
  weekday: number;
  hour: number;
  count: number;
}

interface MemberRow {
  id: string;
  name: string;
  email: string;
  role: string;
  messages: number;
  activeChats: number;
  inactiveChats: number;
  lastActiveAt: string | null;
  topMessenger: Messenger | null;
}

interface AnalyticsResponse {
  kpis: {
    messagesSent: DeltaValue;
    messagesReceived: DeltaValue;
    chats: ChatsKpi;
    activeDaysOrMembers: DeltaValue;
  };
  trend: TrendBucket[];
  byMessenger: Record<Messenger, PerMessengerStats>;
  heatmap: HeatmapCell[];
  members?: MemberRow[];
}

// ─── Helpers ───

function periodToDays(period: '7d' | '30d' | '90d'): number {
  return period === '7d' ? 7 : period === '30d' ? 30 : 90;
}

function getDateRanges(period: '7d' | '30d' | '90d'): {
  currentStart: Date;
  currentEnd: Date;
  previousStart: Date;
  previousEnd: Date;
} {
  const days = periodToDays(period);
  const ms = days * 24 * 60 * 60 * 1000;
  const now = new Date();
  const currentEnd = now;
  const currentStart = new Date(now.getTime() - ms);
  const previousEnd = currentStart;
  const previousStart = new Date(currentStart.getTime() - ms);
  return { currentStart, currentEnd, previousStart, previousEnd };
}

function computeDelta(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function toNumber(v: unknown): number {
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number') return v;
  if (v === null || v === undefined) return 0;
  return Number(v);
}

function sendError(
  reply: FastifyReply,
  code: string,
  message: string,
  statusCode: number,
) {
  return reply.status(statusCode).send({
    error: { code, message, statusCode },
  });
}

// ─── Query helpers (all scoped by organization + optional ownerId) ───

async function countMessages(
  organizationId: string,
  ownerId: string | null | undefined,
  start: Date,
  end: Date,
): Promise<{ sent: number; received: number }> {
  // Using a single raw query with FILTER so it's one DB round-trip.
  const rows = await prisma.$queryRaw<
    Array<{ sent: bigint; received: bigint }>
  >`
    SELECT
      COUNT(*) FILTER (WHERE m."isSelf" = true) AS sent,
      COUNT(*) FILTER (WHERE m."isSelf" = false) AS received
    FROM "Message" m
    JOIN "Chat" c ON c.id = m."chatId"
    WHERE c."organizationId" = ${organizationId}
      AND c."deletedAt" IS NULL
      AND m."deletedAt" IS NULL
      AND m."createdAt" >= ${start}
      AND m."createdAt" < ${end}
      ${ownerId ? Prisma.sql`AND c."ownerId" = ${ownerId}` : Prisma.empty}
  `;
  const row = rows[0] ?? { sent: 0n, received: 0n };
  return { sent: toNumber(row.sent), received: toNumber(row.received) };
}

async function countChats(
  organizationId: string,
  ownerId: string | null | undefined,
  start: Date,
  end: Date,
): Promise<{ active: number; total: number }> {
  // A chat is "active" if it has at least one message in [start, end).
  // "Total" is every chat the user owns (or, for org-scope, every chat in the org) that existed
  // before the end of the period. We do not exclude chats created after the start — a chat
  // created inside the period with zero messages still counts as owned-but-inactive.
  const rows = await prisma.$queryRaw<
    Array<{ active: bigint; total: bigint }>
  >`
    SELECT
      COUNT(DISTINCT c.id) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM "Message" m
          WHERE m."chatId" = c.id
            AND m."deletedAt" IS NULL
            AND m."createdAt" >= ${start}
            AND m."createdAt" < ${end}
        )
      ) AS active,
      COUNT(DISTINCT c.id) AS total
    FROM "Chat" c
    WHERE c."organizationId" = ${organizationId}
      AND c."deletedAt" IS NULL
      AND c."createdAt" < ${end}
      ${ownerId ? Prisma.sql`AND c."ownerId" = ${ownerId}` : Prisma.empty}
  `;
  const row = rows[0] ?? { active: 0n, total: 0n };
  return { active: toNumber(row.active), total: toNumber(row.total) };
}

async function countActiveDays(
  organizationId: string,
  ownerId: string,
  start: Date,
  end: Date,
): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ days: bigint }>>`
    SELECT COUNT(DISTINCT DATE(m."createdAt")) AS days
    FROM "Message" m
    JOIN "Chat" c ON c.id = m."chatId"
    WHERE c."organizationId" = ${organizationId}
      AND c."ownerId" = ${ownerId}
      AND c."deletedAt" IS NULL
      AND m."deletedAt" IS NULL
      AND m."createdAt" >= ${start}
      AND m."createdAt" < ${end}
  `;
  return toNumber(rows[0]?.days);
}

async function countActiveMembers(
  organizationId: string,
  start: Date,
  end: Date,
): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ members: bigint }>>`
    SELECT COUNT(DISTINCT c."ownerId") AS members
    FROM "Message" m
    JOIN "Chat" c ON c.id = m."chatId"
    WHERE c."organizationId" = ${organizationId}
      AND c."ownerId" IS NOT NULL
      AND c."deletedAt" IS NULL
      AND m."deletedAt" IS NULL
      AND m."createdAt" >= ${start}
      AND m."createdAt" < ${end}
  `;
  return toNumber(rows[0]?.members);
}

async function trendBuckets(
  organizationId: string,
  ownerId: string | null | undefined,
  start: Date,
  end: Date,
  granularity: 'day' | 'week' | 'month',
): Promise<TrendBucket[]> {
  const rows = await prisma.$queryRaw<
    Array<{ bucket: Date; messenger: string; count: bigint }>
  >`
    SELECT
      date_trunc(${granularity}, m."createdAt") AS bucket,
      c.messenger,
      COUNT(*) AS count
    FROM "Message" m
    JOIN "Chat" c ON c.id = m."chatId"
    WHERE c."organizationId" = ${organizationId}
      AND c."deletedAt" IS NULL
      AND m."deletedAt" IS NULL
      AND m."isSelf" = true
      AND m."createdAt" >= ${start}
      AND m."createdAt" < ${end}
      ${ownerId ? Prisma.sql`AND c."ownerId" = ${ownerId}` : Prisma.empty}
    GROUP BY bucket, c.messenger
    ORDER BY bucket ASC
  `;

  const byBucket = new Map<string, TrendBucket>();
  for (const row of rows) {
    const key = row.bucket.toISOString();
    let entry = byBucket.get(key);
    if (!entry) {
      entry = {
        bucket: key,
        total: 0,
        // Derived from MESSENGERS rather than spelled out, so adding a messenger
        // cannot silently leave a hole here.
        byMessenger: Object.fromEntries(MESSENGERS.map((m) => [m, 0])) as Record<Messenger, number>,
      };
      byBucket.set(key, entry);
    }
    const count = toNumber(row.count);
    entry.total += count;
    if ((MESSENGERS as readonly string[]).includes(row.messenger)) {
      entry.byMessenger[row.messenger as Messenger] = count;
    }
  }
  return Array.from(byBucket.values());
}

async function byMessengerBreakdown(
  organizationId: string,
  ownerId: string | null | undefined,
  start: Date,
  end: Date,
): Promise<Record<Messenger, PerMessengerStats>> {
  // Message counts per messenger.
  const msgRows = await prisma.$queryRaw<
    Array<{ messenger: string; count: bigint }>
  >`
    SELECT c.messenger, COUNT(*) AS count
    FROM "Message" m
    JOIN "Chat" c ON c.id = m."chatId"
    WHERE c."organizationId" = ${organizationId}
      AND c."deletedAt" IS NULL
      AND m."deletedAt" IS NULL
      AND m."createdAt" >= ${start}
      AND m."createdAt" < ${end}
      ${ownerId ? Prisma.sql`AND c."ownerId" = ${ownerId}` : Prisma.empty}
    GROUP BY c.messenger
  `;

  // Chat counts per messenger (active vs total).
  const chatRows = await prisma.$queryRaw<
    Array<{ messenger: string; active: bigint; total: bigint }>
  >`
    SELECT
      c.messenger,
      COUNT(DISTINCT c.id) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM "Message" m
          WHERE m."chatId" = c.id
            AND m."deletedAt" IS NULL
            AND m."createdAt" >= ${start}
            AND m."createdAt" < ${end}
        )
      ) AS active,
      COUNT(DISTINCT c.id) AS total
    FROM "Chat" c
    WHERE c."organizationId" = ${organizationId}
      AND c."deletedAt" IS NULL
      AND c."createdAt" < ${end}
      ${ownerId ? Prisma.sql`AND c."ownerId" = ${ownerId}` : Prisma.empty}
    GROUP BY c.messenger
  `;

  const totalMessages = msgRows.reduce((sum, r) => sum + toNumber(r.count), 0);

  // Derived from MESSENGERS: a new messenger gets a zeroed row for free. The object
  // literal sits inside the callback, so each messenger gets its own instance.
  const result = Object.fromEntries(
    MESSENGERS.map((m) => [m, { count: 0, percent: 0, activeChats: 0, inactiveChats: 0 }]),
  ) as Record<Messenger, PerMessengerStats>;

  for (const row of msgRows) {
    if (!(MESSENGERS as readonly string[]).includes(row.messenger)) continue;
    const m = row.messenger as Messenger;
    const count = toNumber(row.count);
    result[m].count = count;
    result[m].percent = totalMessages > 0 ? (count / totalMessages) * 100 : 0;
  }

  for (const row of chatRows) {
    if (!(MESSENGERS as readonly string[]).includes(row.messenger)) continue;
    const m = row.messenger as Messenger;
    const active = toNumber(row.active);
    const total = toNumber(row.total);
    result[m].activeChats = active;
    result[m].inactiveChats = Math.max(total - active, 0);
  }

  return result;
}

async function heatmapCells(
  organizationId: string,
  ownerId: string | null | undefined,
  start: Date,
  end: Date,
): Promise<HeatmapCell[]> {
  const rows = await prisma.$queryRaw<
    Array<{ weekday: number; hour: number; count: bigint }>
  >`
    SELECT
      EXTRACT(DOW FROM m."createdAt")::int AS weekday,
      EXTRACT(HOUR FROM m."createdAt")::int AS hour,
      COUNT(*) AS count
    FROM "Message" m
    JOIN "Chat" c ON c.id = m."chatId"
    WHERE c."organizationId" = ${organizationId}
      AND c."deletedAt" IS NULL
      AND m."deletedAt" IS NULL
      AND m."createdAt" >= ${start}
      AND m."createdAt" < ${end}
      ${ownerId ? Prisma.sql`AND c."ownerId" = ${ownerId}` : Prisma.empty}
    GROUP BY weekday, hour
  `;
  return rows.map((r) => ({
    weekday: Number(r.weekday),
    hour: Number(r.hour),
    count: toNumber(r.count),
  }));
}

async function membersList(
  organizationId: string,
  start: Date,
  end: Date,
): Promise<MemberRow[]> {
  // Per-member aggregate: message count + active/total chats.
  const aggRows = await prisma.$queryRaw<
    Array<{
      id: string;
      name: string;
      email: string;
      role: string;
      lastActiveAt: Date | null;
      messages: bigint;
      activeChats: bigint;
      totalChats: bigint;
    }>
  >`
    SELECT
      u.id, u.name, u.email, u.role, u."lastActiveAt",
      COUNT(m.id) FILTER (
        WHERE m."deletedAt" IS NULL
          AND m."isSelf" = true
          AND m."createdAt" >= ${start}
          AND m."createdAt" < ${end}
      ) AS messages,
      COUNT(DISTINCT c.id) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM "Message" m2
          WHERE m2."chatId" = c.id
            AND m2."deletedAt" IS NULL
            AND m2."createdAt" >= ${start}
            AND m2."createdAt" < ${end}
        )
      ) AS "activeChats",
      COUNT(DISTINCT c.id) AS "totalChats"
    FROM "User" u
    LEFT JOIN "Chat" c
      ON c."ownerId" = u.id
      AND c."organizationId" = ${organizationId}
      AND c."deletedAt" IS NULL
      AND c."createdAt" < ${end}
    LEFT JOIN "Message" m ON m."chatId" = c.id
    WHERE u."organizationId" = ${organizationId}
      AND u."deletedAt" IS NULL
      AND u.status = 'active'
    GROUP BY u.id, u.name, u.email, u.role, u."lastActiveAt"
    ORDER BY messages DESC, u.name ASC
  `;

  // Top messenger per user (most messages in the period).
  const topRows = await prisma.$queryRaw<
    Array<{ ownerId: string; messenger: string; count: bigint }>
  >`
    SELECT DISTINCT ON (c."ownerId")
      c."ownerId" AS "ownerId",
      c.messenger,
      COUNT(*) AS count
    FROM "Message" m
    JOIN "Chat" c ON c.id = m."chatId"
    WHERE c."organizationId" = ${organizationId}
      AND c."ownerId" IS NOT NULL
      AND c."deletedAt" IS NULL
      AND m."deletedAt" IS NULL
      AND m."createdAt" >= ${start}
      AND m."createdAt" < ${end}
    GROUP BY c."ownerId", c.messenger
    ORDER BY c."ownerId", count DESC
  `;

  const topByUser = new Map<string, Messenger>();
  for (const row of topRows) {
    if (
      !topByUser.has(row.ownerId) &&
      (MESSENGERS as readonly string[]).includes(row.messenger)
    ) {
      topByUser.set(row.ownerId, row.messenger as Messenger);
    }
  }

  return aggRows.map((r) => {
    const active = toNumber(r.activeChats);
    const total = toNumber(r.totalChats);
    return {
      id: r.id,
      name: r.name,
      email: r.email,
      role: r.role,
      messages: toNumber(r.messages),
      activeChats: active,
      inactiveChats: Math.max(total - active, 0),
      lastActiveAt: r.lastActiveAt ? r.lastActiveAt.toISOString() : null,
      topMessenger: topByUser.get(r.id) ?? null,
    };
  });
}

// ─── Route ───

export default async function analyticsRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get(
    '/analytics',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = querySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendError(
          reply,
          'VALIDATION_ERROR',
          parsed.error.issues.map((i) => i.message).join('; '),
          422,
        );
      }

      const { scope, period, granularity, userId } = parsed.data;

      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(
          reply,
          'VALIDATION_ERROR',
          'Organization context is required',
          400,
        );
      }

      const isAdmin =
        request.user.role === 'admin' || request.user.role === 'superadmin';

      // RBAC: regular user cannot use org scope or drill into another user
      if (!isAdmin && (scope === 'org' || userId)) {
        return sendError(
          reply,
          'AUTH_INSUFFICIENT_PERMISSIONS',
          'Admin role required for organization scope or member drill-down',
          403,
        );
      }

      // When drilling down, verify target user belongs to the same org.
      if (userId) {
        const target = await prisma.user.findUnique({
          where: { id: userId },
          select: { organizationId: true, deletedAt: true },
        });
        if (
          !target ||
          target.deletedAt !== null ||
          target.organizationId !== organizationId
        ) {
          return sendError(
            reply,
            'AUTH_INSUFFICIENT_PERMISSIONS',
            'Target user not found in your organization',
            403,
          );
        }
      }

      // Resolve the ownerId filter for queries.
      // - scope=my → always the current user
      // - scope=org without userId → no owner filter (whole org)
      // - scope=org with userId → that user
      let ownerFilter: string | null = null;
      if (scope === 'my') {
        ownerFilter = request.user.id;
      } else if (userId) {
        ownerFilter = userId;
      }

      const { currentStart, currentEnd, previousStart, previousEnd } =
        getDateRanges(period);

      // Run the main aggregations. Previous-period queries only run for KPIs that have deltas.
      const [
        currentMessages,
        previousMessages,
        currentChats,
        previousChats,
        trend,
        byMessenger,
        heatmap,
      ] = await Promise.all([
        countMessages(organizationId, ownerFilter, currentStart, currentEnd),
        countMessages(organizationId, ownerFilter, previousStart, previousEnd),
        countChats(organizationId, ownerFilter, currentStart, currentEnd),
        countChats(organizationId, ownerFilter, previousStart, previousEnd),
        trendBuckets(
          organizationId,
          ownerFilter,
          currentStart,
          currentEnd,
          granularity,
        ),
        byMessengerBreakdown(
          organizationId,
          ownerFilter,
          currentStart,
          currentEnd,
        ),
        heatmapCells(organizationId, ownerFilter, currentStart, currentEnd),
      ]);

      // 4th KPI: active days (my/drill-down) or active members (org view)
      let activeDaysOrMembers: DeltaValue;
      const needsActiveMembers = scope === 'org' && !userId;
      if (needsActiveMembers) {
        const [current, previous] = await Promise.all([
          countActiveMembers(organizationId, currentStart, currentEnd),
          countActiveMembers(organizationId, previousStart, previousEnd),
        ]);
        activeDaysOrMembers = {
          value: current,
          deltaPct: computeDelta(current, previous),
        };
      } else {
        const target = ownerFilter ?? request.user.id;
        const [current, previous] = await Promise.all([
          countActiveDays(organizationId, target, currentStart, currentEnd),
          countActiveDays(organizationId, target, previousStart, previousEnd),
        ]);
        activeDaysOrMembers = {
          value: current,
          deltaPct: computeDelta(current, previous),
        };
      }

      // Members list (only in plain org view, not in drill-down)
      let members: MemberRow[] | undefined;
      if (scope === 'org' && !userId) {
        members = await membersList(organizationId, currentStart, currentEnd);
      }

      const response: AnalyticsResponse = {
        kpis: {
          messagesSent: {
            value: currentMessages.sent,
            deltaPct: computeDelta(currentMessages.sent, previousMessages.sent),
          },
          messagesReceived: {
            value: currentMessages.received,
            deltaPct: computeDelta(
              currentMessages.received,
              previousMessages.received,
            ),
          },
          chats: {
            active: currentChats.active,
            inactive: Math.max(currentChats.total - currentChats.active, 0),
            deltaPctActive: computeDelta(
              currentChats.active,
              previousChats.active,
            ),
          },
          activeDaysOrMembers,
        },
        trend,
        byMessenger,
        heatmap,
        ...(members ? { members } : {}),
      };

      return reply.send(response);
    },
  );
}
