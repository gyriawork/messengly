import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import prisma from '../lib/prisma.js';
import analyticsRoutes from './analytics.js';

// ─── Test app builder ───

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _req, reply) =>
    reply.status(error.statusCode ?? 500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: error.message,
        statusCode: error.statusCode ?? 500,
      },
    }),
  );
  await app.register(analyticsRoutes, { prefix: '/api' });
  await app.ready();
  return app;
}

const JWT_SECRET =
  process.env.JWT_SECRET || 'test-jwt-secret-at-least-16-chars';

function makeToken(params: {
  id: string;
  email: string;
  name: string;
  role: 'user' | 'admin' | 'superadmin';
  organizationId: string | null;
}) {
  return jwt.sign(params, JWT_SECRET, { expiresIn: '15m' });
}

// ─── Fixture IDs / prefixes (stable per test run to keep cleanup targeted) ───

const RUN = `analytics-test-${Date.now()}`;
const ORG1_ID = `${RUN}-org1`;
const ORG2_ID = `${RUN}-org2`;

// ─── Date helpers ───

const DAY_MS = 24 * 60 * 60 * 1000;
const now = new Date();
// A date inside the current 30-day window (10 days ago)
const inCurrent = (hoursFromNow = -10 * 24) =>
  new Date(now.getTime() + hoursFromNow * 60 * 60 * 1000);
// A date inside the previous 30-day window (45 days ago)
const inPrevious = () => new Date(now.getTime() - 45 * DAY_MS);

// ─── Test state ───

let app: FastifyInstance;

let adminUserId: string;
let regularUserId: string;
let otherMemberUserId: string;
let outsiderUserId: string;

let adminToken: string;
let regularToken: string;
let outsiderToken: string;

// Chats for org1
let tgActive1ChatId: string;
let tgActive2ChatId: string;
let tgInactiveChatId: string;
let slackActiveChatId: string;
let gmailActiveChatId: string;
let gmailInactiveChatId: string;
let otherMemberTgChatId: string;

beforeAll(async () => {
  app = await buildApp();

  // ─── Organizations ───
  await prisma.organization.create({
    data: {
      id: ORG1_ID,
      name: 'Analytics Org 1',
      defaultLanguage: 'en',
      timezone: 'UTC',
      chatVisibilityAll: true,
      status: 'active',
    },
  });
  await prisma.organization.create({
    data: {
      id: ORG2_ID,
      name: 'Analytics Org 2',
      defaultLanguage: 'en',
      timezone: 'UTC',
      chatVisibilityAll: true,
      status: 'active',
    },
  });

  const passwordHash = await bcrypt.hash('testpass123', 4);

  // ─── Users (org1: admin + regular + other member; org2: outsider) ───
  const admin = await prisma.user.create({
    data: {
      email: `${RUN}-admin@test.local`,
      name: 'Admin Tester',
      passwordHash,
      role: 'admin',
      status: 'active',
      organizationId: ORG1_ID,
      lastActiveAt: new Date(),
    },
  });
  adminUserId = admin.id;

  const regular = await prisma.user.create({
    data: {
      email: `${RUN}-regular@test.local`,
      name: 'Regular Tester',
      passwordHash,
      role: 'user',
      status: 'active',
      organizationId: ORG1_ID,
      lastActiveAt: new Date(),
    },
  });
  regularUserId = regular.id;

  const otherMember = await prisma.user.create({
    data: {
      email: `${RUN}-other@test.local`,
      name: 'Other Member',
      passwordHash,
      role: 'user',
      status: 'active',
      organizationId: ORG1_ID,
      lastActiveAt: new Date(),
    },
  });
  otherMemberUserId = otherMember.id;

  const outsider = await prisma.user.create({
    data: {
      email: `${RUN}-outsider@test.local`,
      name: 'Outsider',
      passwordHash,
      role: 'admin',
      status: 'active',
      organizationId: ORG2_ID,
    },
  });
  outsiderUserId = outsider.id;

  adminToken = makeToken({
    id: adminUserId,
    email: admin.email,
    name: admin.name,
    role: 'admin',
    organizationId: ORG1_ID,
  });
  regularToken = makeToken({
    id: regularUserId,
    email: regular.email,
    name: regular.name,
    role: 'user',
    organizationId: ORG1_ID,
  });
  outsiderToken = makeToken({
    id: outsiderUserId,
    email: outsider.email,
    name: outsider.name,
    role: 'admin',
    organizationId: ORG2_ID,
  });

  // ─── Chats ───
  // Helper: create chat and return id
  async function chat(data: {
    ownerId: string;
    messenger: 'telegram' | 'slack' | 'whatsapp' | 'gmail' | 'teams';
    name: string;
    externalChatId: string;
  }) {
    const c = await prisma.chat.create({
      data: {
        name: data.name,
        messenger: data.messenger,
        externalChatId: data.externalChatId,
        chatType: 'direct',
        status: 'active',
        organizationId: ORG1_ID,
        ownerId: data.ownerId,
        importedById: data.ownerId,
        createdAt: new Date(now.getTime() - 60 * DAY_MS),
      },
    });
    return c.id;
  }

  // Regular user's chats
  tgActive1ChatId = await chat({
    ownerId: regularUserId,
    messenger: 'telegram',
    name: 'TG Active 1',
    externalChatId: `${RUN}-tg-1`,
  });
  tgActive2ChatId = await chat({
    ownerId: regularUserId,
    messenger: 'telegram',
    name: 'TG Active 2',
    externalChatId: `${RUN}-tg-2`,
  });
  tgInactiveChatId = await chat({
    ownerId: regularUserId,
    messenger: 'telegram',
    name: 'TG Inactive',
    externalChatId: `${RUN}-tg-3`,
  });
  slackActiveChatId = await chat({
    ownerId: regularUserId,
    messenger: 'slack',
    name: 'Slack Active',
    externalChatId: `${RUN}-sl-1`,
  });
  gmailActiveChatId = await chat({
    ownerId: regularUserId,
    messenger: 'gmail',
    name: 'Gmail Active',
    externalChatId: `${RUN}-gm-1`,
  });
  gmailInactiveChatId = await chat({
    ownerId: regularUserId,
    messenger: 'gmail',
    name: 'Gmail Inactive',
    externalChatId: `${RUN}-gm-2`,
  });

  // Other member's chat
  otherMemberTgChatId = await chat({
    ownerId: otherMemberUserId,
    messenger: 'telegram',
    name: 'Other TG',
    externalChatId: `${RUN}-tg-other`,
  });

  // ─── Messages ───
  // Regular user — current period:
  //   tgActive1: 3 sent, 2 received (all ~10 days ago)
  //   tgActive2: 1 sent
  //   slackActive: 2 sent, 1 received
  //   gmailActive: 1 sent
  //   (tgInactive + gmailInactive → zero current-period messages)
  // Regular user — previous period:
  //   tgActive1: 1 sent, 1 received (≈45 days ago)
  // Other member — current period:
  //   otherMemberTg: 2 sent, 1 received

  const msgs: Array<{
    chatId: string;
    isSelf: boolean;
    createdAt: Date;
    text: string;
  }> = [];
  const push = (
    chatId: string,
    isSelf: boolean,
    createdAt: Date,
    text: string,
  ) => msgs.push({ chatId, isSelf, createdAt, text });

  // TG Active 1: 3 sent + 2 received (current)
  push(tgActive1ChatId, true, inCurrent(-10 * 24 + 1), 'tg1-s1');
  push(tgActive1ChatId, true, inCurrent(-10 * 24 + 2), 'tg1-s2');
  push(tgActive1ChatId, true, inCurrent(-10 * 24 + 3), 'tg1-s3');
  push(tgActive1ChatId, false, inCurrent(-10 * 24 + 4), 'tg1-r1');
  push(tgActive1ChatId, false, inCurrent(-10 * 24 + 5), 'tg1-r2');
  // TG Active 2: 1 sent (current)
  push(tgActive2ChatId, true, inCurrent(-5 * 24), 'tg2-s1');
  // Slack: 2 sent + 1 received (current)
  push(slackActiveChatId, true, inCurrent(-15 * 24), 'sl-s1');
  push(slackActiveChatId, true, inCurrent(-15 * 24 + 1), 'sl-s2');
  push(slackActiveChatId, false, inCurrent(-15 * 24 + 2), 'sl-r1');
  // Gmail: 1 sent (current)
  push(gmailActiveChatId, true, inCurrent(-20 * 24), 'gm-s1');

  // Regular user — previous period (≈45 days ago)
  push(tgActive1ChatId, true, inPrevious(), 'tg1-prev-s1');
  push(tgActive1ChatId, false, inPrevious(), 'tg1-prev-r1');

  // Other member — current
  push(otherMemberTgChatId, true, inCurrent(-7 * 24), 'other-s1');
  push(otherMemberTgChatId, true, inCurrent(-7 * 24 + 1), 'other-s2');
  push(otherMemberTgChatId, false, inCurrent(-7 * 24 + 2), 'other-r1');

  let i = 0;
  for (const m of msgs) {
    await prisma.message.create({
      data: {
        chatId: m.chatId,
        externalMessageId: `${RUN}-msg-${i++}`,
        senderName: m.isSelf ? 'Self' : 'Other',
        isSelf: m.isSelf,
        text: m.text,
        createdAt: m.createdAt,
      },
    });
  }
});

afterAll(async () => {
  // Cascading cleanup via Chat onDelete: Cascade for Message
  await prisma.message.deleteMany({
    where: { chat: { organizationId: { in: [ORG1_ID, ORG2_ID] } } },
  });
  await prisma.chat.deleteMany({
    where: { organizationId: { in: [ORG1_ID, ORG2_ID] } },
  });
  await prisma.user.deleteMany({
    where: { organizationId: { in: [ORG1_ID, ORG2_ID] } },
  });
  await prisma.organization.deleteMany({
    where: { id: { in: [ORG1_ID, ORG2_ID] } },
  });
  await app.close();
  await prisma.$disconnect();
});

// ─── Tests ───

describe('GET /api/analytics — auth & RBAC', () => {
  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/analytics' });
    expect(res.statusCode).toBe(401);
  });

  it('regular user can fetch scope=my', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/analytics?scope=my&period=30d',
      headers: { authorization: `Bearer ${regularToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('regular user requesting scope=org is rejected', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/analytics?scope=org&period=30d',
      headers: { authorization: `Bearer ${regularToken}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('AUTH_INSUFFICIENT_PERMISSIONS');
  });

  it('regular user passing userId is rejected', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/analytics?scope=my&userId=${otherMemberUserId}`,
      headers: { authorization: `Bearer ${regularToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('admin cross-org drill-down is rejected', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/analytics?scope=org&userId=${adminUserId}`,
      headers: { authorization: `Bearer ${outsiderToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('admin drill-down into own-org user is allowed', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/analytics?scope=org&userId=${regularUserId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /api/analytics — KPI counts (scope=my, regular user)', () => {
  it('counts sent/received messages in current period', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/analytics?scope=my&period=30d&granularity=day',
      headers: { authorization: `Bearer ${regularToken}` },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json();

    // Current: sent = 3+1+2+1 = 7, received = 2+1 = 3
    expect(data.kpis.messagesSent.value).toBe(7);
    expect(data.kpis.messagesReceived.value).toBe(3);
  });

  it('computes delta pct against previous period', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/analytics?scope=my&period=30d',
      headers: { authorization: `Bearer ${regularToken}` },
    });
    const data = res.json();
    // prev sent = 1, prev received = 1
    // sent delta = (7 - 1)/1 * 100 = 600
    // received delta = (3 - 1)/1 * 100 = 200
    expect(data.kpis.messagesSent.deltaPct).toBe(600);
    expect(data.kpis.messagesReceived.deltaPct).toBe(200);
  });

  it('splits chats into active/inactive', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/analytics?scope=my&period=30d',
      headers: { authorization: `Bearer ${regularToken}` },
    });
    const data = res.json();
    // Regular owns 6 chats. Active in period: tgActive1, tgActive2, slackActive, gmailActive = 4.
    // Inactive: tgInactive, gmailInactive = 2.
    expect(data.kpis.chats.active).toBe(4);
    expect(data.kpis.chats.inactive).toBe(2);
  });

  it('returns active days as 4th KPI in my-scope', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/analytics?scope=my&period=30d',
      headers: { authorization: `Bearer ${regularToken}` },
    });
    const data = res.json();
    // Messages were authored on 4 distinct days: ~10d, ~5d, ~15d, ~20d ago
    expect(data.kpis.activeDaysOrMembers.value).toBeGreaterThanOrEqual(3);
  });
});

describe('GET /api/analytics — per-messenger breakdown', () => {
  it('returns counts and chat split for each messenger', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/analytics?scope=my&period=30d',
      headers: { authorization: `Bearer ${regularToken}` },
    });
    const data = res.json();

    // Messages: telegram 6 (3+2+1), slack 3, gmail 1, whatsapp 0 → total 10
    expect(data.byMessenger.telegram.count).toBe(6);
    expect(data.byMessenger.slack.count).toBe(3);
    expect(data.byMessenger.gmail.count).toBe(1);
    expect(data.byMessenger.whatsapp.count).toBe(0);

    // Chat split
    // telegram: 2 active (tgActive1, tgActive2), 1 inactive (tgInactive)
    expect(data.byMessenger.telegram.activeChats).toBe(2);
    expect(data.byMessenger.telegram.inactiveChats).toBe(1);
    // gmail: 1 active, 1 inactive
    expect(data.byMessenger.gmail.activeChats).toBe(1);
    expect(data.byMessenger.gmail.inactiveChats).toBe(1);
    // slack: 1 active, 0 inactive
    expect(data.byMessenger.slack.activeChats).toBe(1);
    expect(data.byMessenger.slack.inactiveChats).toBe(0);
    // whatsapp: empty
    expect(data.byMessenger.whatsapp.activeChats).toBe(0);
    expect(data.byMessenger.whatsapp.inactiveChats).toBe(0);
  });

  it('percents across messengers sum to ~100 when there are messages', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/analytics?scope=my&period=30d',
      headers: { authorization: `Bearer ${regularToken}` },
    });
    const data = res.json();
    const total =
      data.byMessenger.telegram.percent +
      data.byMessenger.slack.percent +
      data.byMessenger.whatsapp.percent +
      data.byMessenger.gmail.percent;
    expect(Math.round(total)).toBe(100);
  });
});

describe('GET /api/analytics — trend buckets', () => {
  it('returns non-empty day buckets when there are messages', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/analytics?scope=my&period=30d&granularity=day',
      headers: { authorization: `Bearer ${regularToken}` },
    });
    const data = res.json();
    expect(Array.isArray(data.trend)).toBe(true);
    expect(data.trend.length).toBeGreaterThan(0);

    // "Activity Over Time" tracks messages sent BY the user/org (isSelf=true)
    // — not received. For regular user's current period that's 7.
    const sum = data.trend.reduce(
      (acc: number, b: { total: number }) => acc + b.total,
      0,
    );
    expect(sum).toBe(7);
  });

  it('respects granularity=week (buckets aligned to ISO weeks)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/analytics?scope=my&period=30d&granularity=week',
      headers: { authorization: `Bearer ${regularToken}` },
    });
    const data = res.json();
    expect(data.trend.length).toBeGreaterThan(0);
    // Week granularity must yield fewer or equal buckets than day granularity
    // over a 30d window.
    expect(data.trend.length).toBeLessThanOrEqual(6);

    // Sum of sent messages (isSelf=true) still matches 7
    const sum = data.trend.reduce(
      (acc: number, b: { total: number }) => acc + b.total,
      0,
    );
    expect(sum).toBe(7);
  });
});

describe('GET /api/analytics — heatmap', () => {
  it('returns cells with valid weekday/hour ranges', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/analytics?scope=my&period=30d',
      headers: { authorization: `Bearer ${regularToken}` },
    });
    const data = res.json();
    expect(Array.isArray(data.heatmap)).toBe(true);
    for (const cell of data.heatmap) {
      expect(cell.weekday).toBeGreaterThanOrEqual(0);
      expect(cell.weekday).toBeLessThanOrEqual(6);
      expect(cell.hour).toBeGreaterThanOrEqual(0);
      expect(cell.hour).toBeLessThanOrEqual(23);
      expect(cell.count).toBeGreaterThan(0);
    }

    // Heatmap cell counts should sum to 10 (total current-period messages)
    const sum = data.heatmap.reduce(
      (acc: number, c: { count: number }) => acc + c.count,
      0,
    );
    expect(sum).toBe(10);
  });
});

describe('GET /api/analytics — org scope (admin)', () => {
  it('aggregates across all members in org', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/analytics?scope=org&period=30d',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json();

    // Org totals: sent = 7 (regular) + 2 (other) = 9; received = 3 + 1 = 4
    expect(data.kpis.messagesSent.value).toBe(9);
    expect(data.kpis.messagesReceived.value).toBe(4);

    // KPI 4 in org-mode = active members
    // regular and otherMember both sent messages → 2
    expect(data.kpis.activeDaysOrMembers.value).toBe(2);
  });

  it('returns a members list sorted by messages desc', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/analytics?scope=org&period=30d',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const data = res.json();
    expect(Array.isArray(data.members)).toBe(true);

    // Regular user has more messages than other member
    const regularRow = data.members.find(
      (m: { id: string }) => m.id === regularUserId,
    );
    const otherRow = data.members.find(
      (m: { id: string }) => m.id === otherMemberUserId,
    );
    const adminRow = data.members.find(
      (m: { id: string }) => m.id === adminUserId,
    );

    expect(regularRow).toBeDefined();
    expect(otherRow).toBeDefined();
    expect(adminRow).toBeDefined();

    // "Messages" in the Team Activity table counts messages sent BY the member
    // (isSelf=true), not inbound messages into their chats. Regular = 7, other = 2.
    expect(regularRow.messages).toBe(7);
    expect(otherRow.messages).toBe(2);
    // admin has no chats → 0 messages
    expect(adminRow.messages).toBe(0);

    // regular owns 6 chats: 4 active / 2 inactive
    expect(regularRow.activeChats).toBe(4);
    expect(regularRow.inactiveChats).toBe(2);

    // regular's top messenger = telegram (6 msgs > slack 3 > gmail 1)
    expect(regularRow.topMessenger).toBe('telegram');

    // Sort: messages desc → first row should be the regular user
    expect(data.members[0].id).toBe(regularUserId);
  });

  it('drill-down filters to a single user and omits members list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/analytics?scope=org&period=30d&userId=${regularUserId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const data = res.json();

    // Drill-down matches regular user's own numbers
    expect(data.kpis.messagesSent.value).toBe(7);
    expect(data.kpis.messagesReceived.value).toBe(3);

    // No members array in drill-down mode
    expect(data.members).toBeUndefined();
  });
});

describe('GET /api/analytics — organization isolation', () => {
  it('scope=my for an outsider admin sees zero data from org1', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/analytics?scope=org&period=30d',
      headers: { authorization: `Bearer ${outsiderToken}` },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.kpis.messagesSent.value).toBe(0);
    expect(data.kpis.messagesReceived.value).toBe(0);
    expect(data.kpis.chats.active).toBe(0);
    expect(data.kpis.chats.inactive).toBe(0);
  });
});

describe('GET /api/analytics — validation', () => {
  it('rejects invalid period', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/analytics?period=1y',
      headers: { authorization: `Bearer ${regularToken}` },
    });
    expect(res.statusCode).toBe(422);
  });

  it('rejects invalid granularity', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/analytics?granularity=hour',
      headers: { authorization: `Bearer ${regularToken}` },
    });
    expect(res.statusCode).toBe(422);
  });

  it('rejects non-uuid userId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/analytics?scope=org&userId=not-a-uuid',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(422);
  });
});
