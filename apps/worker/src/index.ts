import { Worker, Queue, type Job, type ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';
import prisma from './lib/prisma.js';
import { decryptCredentials } from './lib/crypto.js';
import { createAdapter } from './integrations/factory.js';
import { MessengerError, type SendFailurePolicy } from './integrations/base.js';
import { ensureChat } from './services/chat-service.js';
import { emojify } from 'node-emoji';
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

// Safety ceilings, mirrored from apps/api settings (M12). Applied to stored
// settings at send time so a row saved before the API clamp existed can't
// drive an unsafe rate.
const ANTIBAN_CEILINGS: Record<Messenger, {
  maxMessagesPerHour: number; maxMessagesPerDay: number; messagesPerBatch: number;
  minDelayBetweenMessages: number; minDelayBetweenBatches: number;
}> = {
  telegram: { maxMessagesPerHour: 100, maxMessagesPerDay: 450, messagesPerBatch: 20, minDelayBetweenMessages: 2, minDelayBetweenBatches: 60 },
  whatsapp: { maxMessagesPerHour: 40, maxMessagesPerDay: 120, messagesPerBatch: 6, minDelayBetweenMessages: 8, minDelayBetweenBatches: 300 },
  slack: { maxMessagesPerHour: 400, maxMessagesPerDay: 3000, messagesPerBatch: 60, minDelayBetweenMessages: 0.5, minDelayBetweenBatches: 15 },
  gmail: { maxMessagesPerHour: 160, maxMessagesPerDay: 600, messagesPerBatch: 10, minDelayBetweenMessages: 4, minDelayBetweenBatches: 60 },
  teams: { maxMessagesPerHour: 80, maxMessagesPerDay: 300, messagesPerBatch: 10, minDelayBetweenMessages: 5, minDelayBetweenBatches: 120 },
};

function clampAntibanConfig<T extends {
  messagesPerBatch: number; delayBetweenMessages: number; delayBetweenBatches: number;
  maxMessagesPerHour: number; maxMessagesPerDay: number;
}>(messenger: string, v: T): T {
  const c = ANTIBAN_CEILINGS[messenger as Messenger];
  if (!c) return v;
  return {
    ...v,
    messagesPerBatch: Math.min(v.messagesPerBatch, c.messagesPerBatch),
    delayBetweenMessages: Math.max(v.delayBetweenMessages, c.minDelayBetweenMessages),
    delayBetweenBatches: Math.max(v.delayBetweenBatches, c.minDelayBetweenBatches),
    maxMessagesPerHour: Math.min(v.maxMessagesPerHour, c.maxMessagesPerHour),
    maxMessagesPerDay: Math.min(v.maxMessagesPerDay, c.maxMessagesPerDay),
  };
}

// ─── Redis connections ───

const connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

// BullMQ may resolve its own (nested) copy of ioredis whose Redis type differs
// from ours on a non-deduped install (e.g. Railway's `npm i`). Cast for the
// BullMQ constructors while keeping `connection` as a real Redis for direct
// commands like scan/del.
const bullConnection = connection as unknown as ConnectionOptions;

// Separate connection for pub/sub notifications
const pubClient = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379');

// Unhandled 'error' events on ioredis crash the process — log instead; ioredis
// reconnects on its own.
connection.on('error', (err) => console.error('[redis] connection error:', err?.message ?? String(err)));
pubClient.on('error', (err) => console.error('[redis] pubClient error:', err?.message ?? String(err)));

// ─── Logger ───

const log = {
  info: (msg: string, data?: Record<string, unknown>) => console.log(`[INFO] ${msg}`, data ?? ''),
  warn: (msg: string, data?: Record<string, unknown>) => console.warn(`[WARN] ${msg}`, data ?? ''),
  error: (msg: string, data?: Record<string, unknown>) => console.error(`[ERROR] ${msg}`, data ?? ''),
};

// ─── Types ───

interface BroadcastSendPayload {
  broadcastId: string;
  organizationId: string;
}

interface MessageSyncPayload {
  chatIds: string[];
  integrationId: string;
  organizationId: string;
  messenger: string;
}

interface GmailAutoImportPayload {
  integrationId: string;
  organizationId: string;
  userId: string;
  importCount: number;
}

interface GmailRehydratePayload {
  chatIds: string[];
  integrationId: string;
  organizationId: string;
}

interface InitialSyncPayload {
  integrationId: string;
  organizationId: string;
  userId: string;
  messenger: Messenger;
  /** Gmail-only: how many threads to pull during initial import. Defaults to 200. */
  importCount?: number;
}

interface AntibanConfig {
  messagesPerBatch: number;
  delayBetweenMessages: number;
  delayBetweenBatches: number;
  maxMessagesPerHour: number;
  maxMessagesPerDay: number;
  autoRetryEnabled: boolean;
  maxRetryAttempts: number;
  retryWindowHours: number;
}

// ─── Helpers ───

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/**
 * Get antiban settings for a messenger+org, falling back to defaults.
 */
async function getAntibanSettings(
  messenger: string,
  organizationId: string,
): Promise<AntibanConfig> {
  const stored = await prisma.antibanSettings.findUnique({
    where: {
      messenger_organizationId: { messenger, organizationId },
    },
  });

  if (stored) {
    return clampAntibanConfig(messenger, {
      messagesPerBatch: stored.messagesPerBatch,
      delayBetweenMessages: stored.delayBetweenMessages,
      delayBetweenBatches: stored.delayBetweenBatches,
      maxMessagesPerHour: stored.maxMessagesPerHour,
      maxMessagesPerDay: stored.maxMessagesPerDay,
      autoRetryEnabled: stored.autoRetryEnabled,
      maxRetryAttempts: stored.maxRetryAttempts,
      retryWindowHours: stored.retryWindowHours,
    });
  }

  const defaults = DEFAULT_ANTIBAN[messenger as Messenger];
  if (!defaults) {
    // Unknown messenger, use conservative defaults
    return {
      messagesPerBatch: 5,
      delayBetweenMessages: 10,
      delayBetweenBatches: 300,
      maxMessagesPerHour: 30,
      maxMessagesPerDay: 200,
      autoRetryEnabled: true,
      maxRetryAttempts: 3,
      retryWindowHours: 6,
    };
  }

  return {
    ...defaults,
    autoRetryEnabled: true,
    maxRetryAttempts: 3,
    retryWindowHours: 6,
  };
}

/**
 * Emit integration sync status via Redis pub/sub. The API's WebSocket server
 * subscribes to these events and pushes them to connected browsers so the
 * initial-sync overlay can show live progress.
 */
function emitIntegrationSyncStatus(
  organizationId: string,
  integrationId: string,
  event: 'integration_sync_progress' | 'integration_sync_complete' | 'integration_sync_failed',
  data: Record<string, unknown>,
) {
  const payload = JSON.stringify({
    event,
    room: `org:${organizationId}`,
    data: { integrationId, ...data },
  });
  pubClient.publish('ws:events', payload).catch((err) => {
    log.warn('Failed to publish integration sync status', { error: String(err) });
  });
}

/**
 * Emit broadcast status via Redis pub/sub. The API's WebSocket server
 * subscribes to these events and pushes them to connected browsers.
 */
function emitBroadcastStatus(
  organizationId: string,
  broadcastId: string,
  status: string,
  extra?: Record<string, unknown>,
) {
  const payload = JSON.stringify({
    event: 'broadcast_status',
    room: `org:${organizationId}`,
    data: { broadcastId, status, ...extra },
  });
  pubClient.publish('ws:events', payload).catch((err) => {
    log.warn('Failed to publish broadcast status', { error: String(err) });
  });
}

/**
 * Send messages to a group of BroadcastChats for a single messenger,
 * respecting antiban rate limits.
 */
async function sendMessengerBatch(
  broadcastId: string,
  organizationId: string,
  messageText: string,
  messengerChats: Array<{ id: string; chatId: string; chat: { externalChatId: string; messenger: string }; retryCount: number }>,
  antibanConfig: AntibanConfig,
  isRetry: boolean,
  createdById: string,
  attachments?: Array<{ url: string; filename: string; mimeType: string; size: number }>,
  senderConfig?: Record<string, { integrationId: string; sendAs?: 'bot' | 'user' }> | null,
): Promise<{ sent: number; failed: number; skipped: number }> {
  const messenger = messengerChats[0]?.chat.messenger;
  if (!messenger || messengerChats.length === 0) return { sent: 0, failed: 0, skipped: 0 };

  // Chats marked inactive by "Update chats" are skipped up front: the connected
  // account cannot reach them, so a delivery attempt is guaranteed to fail. The
  // wizard already hides them, but stale drafts, duplicated broadcasts and
  // scheduled sends carry chat lists assembled before the status changed.
  const chatStatuses = await prisma.chat.findMany({
    where: { id: { in: messengerChats.map((c) => c.chatId) } },
    select: { id: true, status: true },
  });
  const inactiveChatIds = new Set(
    chatStatuses.filter((c) => c.status === 'inactive').map((c) => c.id),
  );
  const inactiveBcIds = messengerChats
    .filter((bc) => inactiveChatIds.has(bc.chatId))
    .map((bc) => bc.id);
  if (inactiveBcIds.length > 0) {
    await prisma.broadcastChat.updateMany({
      where: { id: { in: inactiveBcIds } },
      data: { status: 'skipped', errorReason: 'Chat is inactive — not reachable by the connected account' },
    });
    log.info(`Skipping ${inactiveBcIds.length} inactive ${messenger} chat(s)`, { broadcastId });
    messengerChats = messengerChats.filter((bc) => !inactiveChatIds.has(bc.chatId));
  }
  const preSkipped = inactiveBcIds.length;
  if (messengerChats.length === 0) return { sent: 0, failed: 0, skipped: preSkipped };

  // Convert Slack-style :emoji: shortcodes to real Unicode emoji so they render
  // correctly in every messenger (Telegram shows the raw code otherwise).
  messageText = emojify(messageText);

  // Task 7/8: an explicitly chosen sender (Broadcast.senderConfig) is pinned
  // by integrationId and must be honored exactly — falling back to a
  // different account would send under the wrong identity, which is worse
  // than failing outright. No senderConfig for this messenger = legacy
  // behavior: the org's oldest connected row. orderBy matters now that
  // per-user connections (Task 3/4) can put more than one connected row per
  // messenger+org.
  const chosenSender = senderConfig?.[messenger];
  let integration;
  if (chosenSender) {
    integration = await prisma.integration.findUnique({ where: { id: chosenSender.integrationId } });
    if (!integration || integration.organizationId !== organizationId || integration.messenger !== messenger || integration.status !== 'connected') {
      log.error('Selected sender account is no longer connected', { broadcastId, messenger, integrationId: chosenSender.integrationId });
      await prisma.broadcastChat.updateMany({
        where: { id: { in: messengerChats.map((c) => c.id) } },
        data: {
          status: 'failed',
          errorReason: 'Selected sender account is no longer connected',
        },
      });
      return { sent: 0, failed: messengerChats.length, skipped: preSkipped };
    }
  } else {
    // No explicit sender chosen: default to the broadcast creator's own
    // connection so the message goes out under the account that started
    // it, not whichever account happens to be oldest. Falls back to the
    // legacy org-oldest row when the creator has no personal connection
    // (e.g. only an org-shared account exists).
    integration = await prisma.integration.findUnique({
      where: {
        messenger_organizationId_userId_scope: {
          messenger,
          organizationId,
          userId: createdById,
          scope: 'user',
        },
      },
    });
    if (!integration || integration.status !== 'connected') {
      integration = await prisma.integration.findFirst({
        where: {
          messenger,
          organizationId,
          status: 'connected',
        },
        orderBy: { createdAt: 'asc' },
      });
    }
  }

  let adapter;
  try {
    if (integration) {
      const credentials = decryptCredentials<Record<string, unknown>>(
        integration.credentials as string,
      );
      if (chosenSender?.sendAs) {
        (credentials as Record<string, unknown>).sendAs = chosenSender.sendAs;
      }
      adapter = await createAdapter(messenger, credentials, { organizationId });
    } else {
      throw new Error(`No connected integration found for ${messenger}`);
    }
    await adapter.connect();
  } catch (err) {
    // If adapter fails to connect, mark all chats as failed
    log.error(`Failed to connect ${messenger} adapter`, { error: String(err) });
    await prisma.broadcastChat.updateMany({
      where: { id: { in: messengerChats.map((c) => c.id) } },
      data: {
        status: 'failed',
        errorReason: `Adapter connection failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    });
    return { sent: 0, failed: messengerChats.length, skipped: preSkipped };
  }

  // Runtime counter only; the up-front inactive skips join it in the return —
  // mixing them here would corrupt the `remaining` progress arithmetic, which
  // works off the already-filtered list.
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let hourlyCount = 0;
  let dailyCount = 0;
  let batchCount = 0;

  const { messagesPerBatch, delayBetweenMessages, delayBetweenBatches, maxMessagesPerHour, maxMessagesPerDay } = antibanConfig;

  // Everything after a successful connect() runs under try/finally: a throw
  // anywhere in the loop (prisma, ws emit) must still disconnect the adapter,
  // or the leaked client lives on (gramjs keeps an update loop running that
  // later floods the logs with TIMEOUT errors).
  try {
  for (let i = 0; i < messengerChats.length; i++) {
    const bc = messengerChats[i]!;

    // Cancel check: the API flips the broadcast to 'canceling'; honour it at
    // the message boundary. One SELECT per message is noise next to the
    // multi-second anti-ban delays.
    const live = await prisma.broadcast.findUnique({
      where: { id: broadcastId },
      select: { status: true },
    });
    if (live?.status === 'canceling' || live?.status === 'canceled') {
      const remainingIds = messengerChats.slice(i).map((c) => c.id);
      const res = await prisma.broadcastChat.updateMany({
        where: { id: { in: remainingIds }, status: 'pending' },
        data: { status: 'skipped', errorReason: 'Broadcast canceled by user' },
      });
      skipped += res.count;
      log.info(`Cancel requested — stopping ${messenger} batch`, { broadcastId, skipped: res.count });
      break;
    }

    // Check hourly/daily limits
    if (hourlyCount >= maxMessagesPerHour) {
      log.info(`Hourly limit reached for ${messenger}, waiting 60 seconds`, { broadcastId });
      await sleep(60);
      hourlyCount = 0;
    }
    if (dailyCount >= maxMessagesPerDay) {
      log.warn(`Daily limit reached for ${messenger}, stopping batch`, { broadcastId });
      // Mark remaining as pending so they can be retried later
      const remainingIds = messengerChats.slice(i).map((c) => c.id);
      await prisma.broadcastChat.updateMany({
        where: { id: { in: remainingIds } },
        data: { status: 'pending', errorReason: 'Daily limit reached, will retry' },
      });
      break;
    }

    // Batch boundary
    if (batchCount >= messagesPerBatch && batchCount > 0) {
      log.info(`Batch complete (${batchCount}/${messagesPerBatch}), waiting ${delayBetweenBatches}s`, { broadcastId, messenger });
      await sleep(delayBetweenBatches);
      batchCount = 0;
    }

    // Inter-message delay
    if (batchCount > 0) {
      const delay = isRetry
        ? delayBetweenMessages * Math.pow(2, bc.retryCount)
        : delayBetweenMessages;
      await sleep(delay);
    }

    try {
      // Record the attempt BEFORE it happens. If the worker dies inside
      // sendMessage, this row must not look 'pending' after the restart — a
      // blind re-send would put a duplicate message in a real chat. The
      // startup sweep turns stranded 'sending' rows into unverified failures.
      await prisma.broadcastChat.update({
        where: { id: bc.id },
        data: { status: 'sending' },
      });

      await adapter.sendMessage(bc.chat.externalChatId, messageText, {
        attachments: attachments && attachments.length > 0 ? attachments : undefined,
      });

      await prisma.broadcastChat.update({
        where: { id: bc.id },
        data: { status: 'sent', sentAt: new Date(), errorReason: null },
      });

      sent++;
      batchCount++;
      hourlyCount++;
      dailyCount++;
    } catch (err) {
      const errorReason = err instanceof Error ? err.message : String(err);
      // Adapters that say nothing get `retry`, which is exactly what they got
      // before this existed.
      const policy: SendFailurePolicy = err instanceof MessengerError ? err.policy : 'retry';
      log.warn(`Failed to send to chat ${bc.chatId}`, { broadcastId, messenger, policy, error: errorReason });

      if (policy === 'skip') {
        // The chat is the problem, not the delivery. Not counted as a failure.
        await prisma.broadcastChat.update({
          where: { id: bc.id },
          data: { status: 'skipped', errorReason },
        });
        skipped++;
      } else {
        await prisma.broadcastChat.update({
          where: { id: bc.id },
          data: {
            status: 'failed',
            errorReason,
            retryCount: bc.retryCount + (isRetry ? 1 : 0),
          },
        });
        failed++;
      }

      batchCount++;
      hourlyCount++;
      dailyCount++;

      if (policy === 'halt') {
        // Continuing would drive the same broken browser through every remaining
        // chat. Stop this messenger's batch; other messengers are untouched.
        const remainingIds = messengerChats.slice(i + 1).map((c) => c.id);
        if (remainingIds.length > 0) {
          await prisma.broadcastChat.updateMany({
            where: { id: { in: remainingIds } },
            data: { status: 'skipped', errorReason: `Skipped: ${messenger} halted (${errorReason})` },
          });
          skipped += remainingIds.length;
        }
        log.error(`Halting ${messenger} batch`, { broadcastId, error: errorReason, skipped: remainingIds.length });
        break;
      }
    }

    // Emit progress periodically (every 10 messages)
    if ((sent + failed) % 10 === 0) {
      emitBroadcastStatus(organizationId, broadcastId, 'sending', {
        progress: { sent, failed, remaining: messengerChats.length - sent - failed - skipped },
      });
    }
  }
  } finally {
    try {
      await adapter.disconnect();
    } catch {
      // Non-critical
    }
  }

  return { sent, failed, skipped: skipped + preSkipped };
}

/**
 * Finalize broadcast: calculate delivery rate and set final status.
 */
async function finalizeBroadcast(broadcastId: string, organizationId: string): Promise<void> {
  const broadcastChats = await prisma.broadcastChat.findMany({
    where: { broadcastId },
    select: { status: true },
  });

  const total = broadcastChats.length;
  const sentCount = broadcastChats.filter((c) => c.status === 'sent').length;
  const failedCount = broadcastChats.filter((c) =>
    c.status === 'failed' || c.status === 'retry_exhausted',
  ).length;
  const skippedCount = broadcastChats.filter((c) => c.status === 'skipped').length;
  const pendingCount = broadcastChats.filter((c) =>
    c.status === 'pending' || c.status === 'retrying',
  ).length;

  const deliveryRate = total > 0 ? sentCount / total : 0;

  // A cancel requested mid-send wins over the computed outcome.
  const current = await prisma.broadcast.findUnique({
    where: { id: broadcastId },
    select: { status: true },
  });
  const wasCanceled = current?.status === 'canceling' || current?.status === 'canceled';

  let status: string;
  if (wasCanceled) {
    status = 'canceled';
  } else if (pendingCount > 0) {
    // Some chats still pending (hit daily limit); keep as sending
    status = 'sending';
  } else if (sentCount === total) {
    status = 'sent';
  } else if (sentCount === 0) {
    status = 'failed';
  } else {
    // Skipped chats (missing chat, halted batch) count as "not delivered", so a
    // broadcast that skipped some but delivered others is partially failed.
    status = 'partially_failed';
  }

  await prisma.broadcast.update({
    where: { id: broadcastId },
    data: {
      status,
      deliveryRate,
      sentAt: status !== 'sending' ? new Date() : undefined,
    },
  });

  emitBroadcastStatus(organizationId, broadcastId, status, {
    deliveryRate,
    stats: { total, sent: sentCount, failed: failedCount, skipped: skippedCount, pending: pendingCount },
  });

  log.info(`Broadcast ${broadcastId} finalized`, {
    status,
    deliveryRate,
    total,
    sent: sentCount,
    failed: failedCount,
    skipped: skippedCount,
  });
}

// ─── Job Processors ───

async function processBroadcastSend(job: Job<BroadcastSendPayload>): Promise<void> {
  const { broadcastId, organizationId } = job.data;
  log.info(`Processing broadcast:send`, { broadcastId, organizationId });

  // Load broadcast (idempotency: check it's still in sending or scheduled state)
  const broadcast = await prisma.broadcast.findFirst({
    where: { id: broadcastId, organizationId },
  });

  if (!broadcast) {
    log.warn('Broadcast not found, skipping', { broadcastId });
    return;
  }

  // If scheduled, update to sending now
  if (broadcast.status === 'scheduled' || broadcast.status === 'draft') {
    await prisma.broadcast.update({
      where: { id: broadcastId },
      data: { status: 'sending', sentAt: new Date() },
    });
  } else if (broadcast.status === 'canceling') {
    // Cancel raced this job — mark the untouched recipients and finalize so
    // the broadcast doesn't strand in 'canceling'.
    await prisma.broadcastChat.updateMany({
      where: { broadcastId, status: 'pending' },
      data: { status: 'skipped', errorReason: 'Broadcast canceled by user' },
    });
    await finalizeBroadcast(broadcastId, organizationId);
    return;
  } else if (broadcast.status !== 'sending') {
    log.warn(`Broadcast is in unexpected status "${broadcast.status}", skipping`, { broadcastId });
    return;
  }

  // Load pending BroadcastChats with chat info
  const pendingChats = await prisma.broadcastChat.findMany({
    where: { broadcastId, status: 'pending' },
    include: {
      chat: {
        select: { id: true, externalChatId: true, messenger: true },
      },
    },
  });

  if (pendingChats.length === 0) {
    log.info('No pending chats to process', { broadcastId });
    await finalizeBroadcast(broadcastId, organizationId);
    return;
  }

  // Group by messenger
  const byMessenger = new Map<string, typeof pendingChats>();
  for (const bc of pendingChats) {
    const m = bc.chat.messenger;
    const arr = byMessenger.get(m) ?? [];
    arr.push(bc);
    byMessenger.set(m, arr);
  }

  // Parse attachments from broadcast JSON field
  const broadcastAttachments = Array.isArray(broadcast.attachments)
    ? (broadcast.attachments as Array<{ url: string; filename?: string; originalName?: string; mimeType: string; size: number }>).map(a => ({
        url: a.url,
        filename: a.filename || a.originalName || 'attachment',
        mimeType: a.mimeType,
        size: a.size,
      }))
    : undefined;

  // Messengers send in parallel: each has its own adapter, session and antiban
  // pacing, so they cannot interfere — and a slow Teams browser batch must not
  // hold up Telegram. allSettled so one messenger's crash doesn't strand the
  // others' rows before finalize.
  const outcomes = await Promise.allSettled(
    [...byMessenger.entries()].map(async ([messenger, chats]) => {
      const antibanConfig = await getAntibanSettings(messenger, organizationId);
      log.info(`Sending ${chats.length} messages via ${messenger}`, { broadcastId });

      await sendMessengerBatch(
        broadcastId,
        organizationId,
        broadcast.messageText,
        chats.map((c) => ({
          id: c.id,
          chatId: c.chatId,
          chat: { externalChatId: c.chat.externalChatId, messenger: c.chat.messenger },
          retryCount: c.retryCount,
        })),
        antibanConfig,
        false,
        broadcast.createdById,
        broadcastAttachments,
        broadcast.senderConfig as Record<string, { integrationId: string; sendAs?: 'bot' | 'user' }> | null,
      );
    }),
  );
  for (const o of outcomes) {
    if (o.status === 'rejected') {
      log.error('Messenger batch crashed', { broadcastId, error: String(o.reason) });
    }
  }

  // Finalize
  await finalizeBroadcast(broadcastId, organizationId);
}

async function processBroadcastRetry(job: Job<BroadcastSendPayload>): Promise<void> {
  const { broadcastId, organizationId } = job.data;
  log.info('Processing broadcast:retry', { broadcastId, organizationId });

  const broadcast = await prisma.broadcast.findFirst({
    where: { id: broadcastId, organizationId },
  });

  if (!broadcast) {
    log.warn('Broadcast not found, skipping retry', { broadcastId });
    return;
  }

  // Load retrying BroadcastChats
  const retryingChats = await prisma.broadcastChat.findMany({
    where: { broadcastId, status: 'retrying' },
    include: {
      chat: {
        select: { id: true, externalChatId: true, messenger: true },
      },
    },
  });

  if (retryingChats.length === 0) {
    log.info('No retrying chats to process', { broadcastId });
    await finalizeBroadcast(broadcastId, organizationId);
    return;
  }

  // Group by messenger
  const byMessenger = new Map<string, typeof retryingChats>();
  for (const bc of retryingChats) {
    const m = bc.chat.messenger;
    const arr = byMessenger.get(m) ?? [];
    arr.push(bc);
    byMessenger.set(m, arr);
  }

  // Same parallelism as the initial send: messengers are independent.
  const retryOutcomes = await Promise.allSettled(
    [...byMessenger.entries()].map(async ([messenger, chats]) => {
      const antibanConfig = await getAntibanSettings(messenger, organizationId);

      // Filter out chats that have exceeded max retry attempts
      const retriable: typeof chats = [];
      const exhausted: typeof chats = [];

      for (const bc of chats) {
        if (bc.retryCount >= antibanConfig.maxRetryAttempts) {
          exhausted.push(bc);
        } else {
          retriable.push(bc);
        }
      }

      // Mark exhausted chats
      if (exhausted.length > 0) {
        await prisma.broadcastChat.updateMany({
          where: { id: { in: exhausted.map((c) => c.id) } },
          data: { status: 'retry_exhausted' },
        });
        log.info(`${exhausted.length} chats exhausted retries for ${messenger}`, { broadcastId });
      }

      if (retriable.length > 0) {
        log.info(`Retrying ${retriable.length} messages via ${messenger}`, { broadcastId });

        const retryAttachments = Array.isArray(broadcast.attachments)
          ? (broadcast.attachments as Array<{ url: string; filename?: string; originalName?: string; mimeType: string; size: number }>).map(a => ({
              url: a.url,
              filename: a.filename || a.originalName || 'attachment',
              mimeType: a.mimeType,
              size: a.size,
            }))
          : undefined;

        await sendMessengerBatch(
          broadcastId,
          organizationId,
          broadcast.messageText,
          retriable.map((c) => ({
            id: c.id,
            chatId: c.chatId,
            chat: { externalChatId: c.chat.externalChatId, messenger: c.chat.messenger },
            retryCount: c.retryCount,
          })),
          antibanConfig,
          true,
          broadcast.createdById,
          retryAttachments,
          broadcast.senderConfig as Record<string, { integrationId: string; sendAs?: 'bot' | 'user' }> | null,
        );
      }
    }),
  );
  for (const o of retryOutcomes) {
    if (o.status === 'rejected') {
      log.error('Messenger retry batch crashed', { broadcastId, error: String(o.reason) });
    }
  }

  // Finalize
  await finalizeBroadcast(broadcastId, organizationId);
}

// ─── Chat History Sync Processor ───

async function processChatHistorySync(job: Job<MessageSyncPayload>): Promise<void> {
  const { chatIds, integrationId, organizationId, messenger } = job.data;
  log.info('Processing sync:chat-history', { integrationId, chatCount: chatIds.length });

  // Load integration credentials
  const integration = await prisma.integration.findUnique({
    where: { id: integrationId },
    select: { credentials: true, messenger: true },
  });

  if (!integration) {
    log.warn('Integration not found, skipping history sync', { integrationId });
    return;
  }

  const credentials = decryptCredentials<Record<string, unknown>>(integration.credentials as string);
  const adapter = await createAdapter(messenger, credentials, { organizationId });

  try {
    await adapter.connect();
  } catch (err) {
    log.error('Failed to connect adapter for history sync', { error: String(err) });
    // Mark all chats as failed
    await prisma.chat.updateMany({
      where: { id: { in: chatIds } },
      data: { syncStatus: 'failed' },
    });
    return;
  }

  // Check if adapter supports getMessages
  if (!adapter.getMessages) {
    log.info(`Adapter for ${messenger} does not support history fetch, marking as synced`);
    await prisma.chat.updateMany({
      where: { id: { in: chatIds } },
      data: { syncStatus: 'synced' },
    });
    try { await adapter.disconnect(); } catch {}
    return;
  }

  // From here on the adapter must always be released — a throw mid-sync
  // otherwise leaks a live client (gramjs update loop keeps running).
  try {
  // Resolve sender names for Telegram (has getSenderName method)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hasSenderNameResolver = 'getSenderName' in adapter && typeof (adapter as any).getSenderName === 'function';

  // Process chats concurrently (up to 3 at a time for Telegram safety, 5 for others)
  const CHAT_CONCURRENCY = messenger === 'telegram' ? 3 : 5;
  const syncOneChat = async (chatId: string) => {
    try {
      const chat = await prisma.chat.findUnique({
        where: { id: chatId },
        select: { id: true, externalChatId: true, syncCursor: true, syncStatus: true },
      });

      if (!chat) return;

      // Skip already synced chats
      if (chat.syncStatus === 'synced') return;

      // Mark as syncing
      await prisma.chat.update({
        where: { id: chat.id },
        data: { syncStatus: 'syncing' },
      });

      log.info(`Syncing full history for chat ${chat.externalChatId}`, { chatId });

      let cursor = chat.syncCursor ?? undefined;
      let totalSynced = 0;
      let batchNumber = 0;
      const senderNameCache = new Map<string, string>();

      // Pagination loop — fetch all history
      while (true) {
        batchNumber++;
        let result;

        try {
          result = await adapter.getMessages!(chat.externalChatId, 100, cursor);
        } catch (err) {
          const errMsg = String(err);
          if (errMsg.includes('FloodWait') || errMsg.includes('FLOOD_WAIT')) {
            const waitMatch = errMsg.match(/(\d+)/);
            const waitSeconds = waitMatch ? parseInt(waitMatch[1]!, 10) : 30;
            log.warn(`FloodWait: waiting ${waitSeconds}s`, { chatId, batch: batchNumber });
            await sleep(Math.min(waitSeconds, 120));
            continue; // retry same cursor
          }
          log.error(`Failed to fetch batch ${batchNumber} for chat ${chatId}`, { error: errMsg });
          break; // stop pagination for this chat
        }

        if (result.messages.length === 0) {
          log.info(`No more messages in batch ${batchNumber}`, { chatId });
          break;
        }

        // Resolve sender names if supported (e.g. Telegram) — parallel with concurrency limit
        if (hasSenderNameResolver) {
          const unresolvedIds = [...new Set(
            result.messages
              .filter(m => m.senderId && !m.senderName && !senderNameCache.has(m.senderId))
              .map(m => m.senderId!),
          )];
          const NAME_CONCURRENCY = 5;
          for (let ni = 0; ni < unresolvedIds.length; ni += NAME_CONCURRENCY) {
            const batch = unresolvedIds.slice(ni, ni + NAME_CONCURRENCY);
            const settled = await Promise.allSettled(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              batch.map(id => (adapter as any).getSenderName(id).then((n: string) => ({ id, name: n }))),
            );
            for (const r of settled) {
              if (r.status === 'fulfilled') {
                senderNameCache.set(r.value.id, r.value.name);
              } else {
                // Mark as Unknown so we don't retry
                senderNameCache.set(batch[settled.indexOf(r)]!, 'Unknown');
              }
            }
          }
        }

        // Bulk insert with deduplication
        await prisma.message.createMany({
          data: result.messages.map((m) => ({
            chatId: chat.id,
            externalMessageId: m.id,
            senderName: m.senderName ?? senderNameCache.get(m.senderId) ?? 'Unknown',
            senderExternalId: m.senderId,
            isSelf: m.isSelf,
            text: m.text,
            createdAt: m.date,
            // Email-specific fields (Gmail). Undefined for other messengers,
            // which Prisma treats as NULL / default.
            subject: m.subject,
            htmlBody: m.htmlBody,
            plainBody: m.plainBody,
            fromEmail: m.fromEmail,
            toEmails: m.toEmails ?? [],
            ccEmails: m.ccEmails ?? [],
            bccEmails: m.bccEmails ?? [],
            inReplyTo: m.inReplyTo,
          })),
          skipDuplicates: true,
        });

        totalSynced += result.messages.length;

        // Save cursor for resume capability
        await prisma.chat.update({
          where: { id: chat.id },
          data: { syncCursor: result.nextCursor ?? null },
        });

        // Notify frontend every batch
        pubClient.publish('ws:events', JSON.stringify({
          event: 'chat_updated',
          room: `org:${organizationId}`,
          data: { chatId: chat.id },
        })).catch(() => {});

        log.info(`Batch ${batchNumber}: synced ${result.messages.length} messages (total: ${totalSynced})`, { chatId });

        // Check if we've exhausted history
        if (!result.hasMore || !result.nextCursor) {
          break;
        }

        cursor = result.nextCursor;

        // Small delay between batches to avoid rate limiting
        // Telegram needs longer delay (FloodWait risk), others are faster
        await sleep(messenger === 'telegram' ? 0.2 : 0.1);
      }

      // Update chat metadata
      const totalMessages = await prisma.message.count({ where: { chatId: chat.id } });
      const latestMessage = await prisma.message.findFirst({
        where: { chatId: chat.id },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });

      await prisma.chat.update({
        where: { id: chat.id },
        data: {
          syncStatus: 'synced',
          syncCursor: null,
          hasFullHistory: true,
          messageCount: totalMessages,
          lastActivityAt: latestMessage?.createdAt ?? new Date(),
        },
      });

      // Final frontend notification
      pubClient.publish('ws:events', JSON.stringify({
        event: 'chat_updated',
        room: `org:${organizationId}`,
        data: { chatId: chat.id },
      })).catch(() => {});

      log.info(`History sync complete for chat ${chatId}: ${totalSynced} messages synced`);
    } catch (err) {
      log.error(`Error syncing chat ${chatId}`, { error: String(err) });
      await prisma.chat.update({
        where: { id: chatId },
        data: { syncStatus: 'failed' },
      }).catch(() => {});
    }
  };

  // Run chats with concurrency limit
  const executing = new Set<Promise<void>>();
  for (const chatId of chatIds) {
    const p = syncOneChat(chatId).then(() => { executing.delete(p); }, () => { executing.delete(p); });
    executing.add(p);
    if (executing.size >= CHAT_CONCURRENCY) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
  } finally {
    try {
      await adapter.disconnect();
    } catch {}
  }

  log.info('Chat history sync job complete', { chatCount: chatIds.length });
}

// ─── Gmail Rehydrate Processor ───
// Re-fetches Gmail threads with format:'full' and UPDATEs existing Message rows
// with the new email-rendering fields (subject, htmlBody, plainBody, fromEmail,
// toEmails, ccEmails, bccEmails, inReplyTo). Does not insert new rows, does not
// touch non-email fields. Safe to run on already-synced Gmail chats.

async function processGmailRehydrate(job: Job<GmailRehydratePayload>): Promise<void> {
  const { chatIds, integrationId, organizationId } = job.data;
  log.info('Processing sync:gmail-rehydrate', { integrationId, chatCount: chatIds.length });

  const integration = await prisma.integration.findUnique({
    where: { id: integrationId },
    select: { credentials: true, messenger: true },
  });

  if (!integration) {
    log.warn('Integration not found, skipping gmail rehydrate', { integrationId });
    return;
  }

  if (integration.messenger !== 'gmail') {
    log.warn('Rehydrate only supported for gmail', { integrationId, messenger: integration.messenger });
    return;
  }

  const credentials = decryptCredentials<Record<string, unknown>>(integration.credentials as string);
  const adapter = await createAdapter('gmail', credentials, { organizationId });

  try {
    await adapter.connect();
  } catch (err) {
    log.error('Failed to connect Gmail adapter for rehydrate', { error: String(err) });
    return;
  }

  if (!adapter.getMessages) {
    log.warn('Gmail adapter missing getMessages, cannot rehydrate');
    try { await adapter.disconnect(); } catch {}
    return;
  }

  let totalUpdated = 0;

  // try/finally so a throw between chats never leaks the connected adapter.
  try {
  for (const chatId of chatIds) {
    try {
      const chat = await prisma.chat.findUnique({
        where: { id: chatId },
        select: { id: true, externalChatId: true },
      });

      if (!chat) continue;

      log.info(`Rehydrating Gmail thread ${chat.externalChatId}`, { chatId });

      let cursor: string | undefined;
      let chatUpdated = 0;

      // Paginate through the thread — threads.get returns everything in one call,
      // but the adapter slices client-side, so we still need to loop.
      while (true) {
        let result;
        try {
          result = await adapter.getMessages(chat.externalChatId, 100, cursor);
        } catch (err) {
          // Surface the underlying Google API error so we can diagnose
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const anyErr = err as any;
          const orig = anyErr?.originalError;
          log.error(`Failed to fetch Gmail thread ${chat.externalChatId}`, {
            error: String(err),
            origName: orig?.name,
            origMessage: orig?.message,
            origCode: orig?.code,
            origStatus: orig?.status,
            origErrors: orig?.errors,
            origResponseData: orig?.response?.data,
          });
          break;
        }

        if (result.messages.length === 0) break;

        for (const m of result.messages) {
          const res = await prisma.message.updateMany({
            where: {
              chatId: chat.id,
              externalMessageId: m.id,
            },
            data: {
              subject: m.subject,
              htmlBody: m.htmlBody,
              plainBody: m.plainBody,
              fromEmail: m.fromEmail,
              toEmails: m.toEmails ?? [],
              ccEmails: m.ccEmails ?? [],
              bccEmails: m.bccEmails ?? [],
              inReplyTo: m.inReplyTo,
              // Refresh senderName from parsed From header if it's still empty
              ...(m.senderName ? { senderName: m.senderName } : {}),
            },
          });
          chatUpdated += res.count;
        }

        if (!result.hasMore || !result.nextCursor) break;
        cursor = result.nextCursor;
      }

      totalUpdated += chatUpdated;
      log.info(`Rehydrated ${chatUpdated} messages for chat ${chatId}`);

      // Notify frontend so it refetches and re-renders with HTML
      pubClient.publish('ws:events', JSON.stringify({
        event: 'chat_updated',
        room: `org:${organizationId}`,
        data: { chatId: chat.id },
      })).catch(() => {});

      // Small pause between chats to avoid Gmail rate limits
      await sleep(1);
    } catch (err) {
      log.error(`Error rehydrating chat ${chatId}`, { error: String(err) });
    }
  }
  } finally {
    try { await adapter.disconnect(); } catch {}
  }

  log.info('Gmail rehydrate job complete', {
    chatCount: chatIds.length,
    totalUpdated,
  });
}

// ─── Gmail Auto-Import Processor ───

async function processGmailAutoImport(job: Job<GmailAutoImportPayload>): Promise<void> {
  const { integrationId, organizationId, userId, importCount } = job.data;
  const maxThreads = Math.min(importCount || 50, 500);

  log.info('Processing gmail:auto-import', { integrationId, importCount: maxThreads });

  // Load integration credentials
  const integration = await prisma.integration.findUnique({
    where: { id: integrationId },
    select: { credentials: true, messenger: true },
  });

  if (!integration) {
    log.warn('Integration not found for Gmail auto-import', { integrationId });
    return;
  }

  const credentials = decryptCredentials<Record<string, unknown>>(integration.credentials as string);

  // Import googleapis directly for thread-level operations
  const { google } = await import('googleapis');
  const oauth2Client = new google.auth.OAuth2(
    credentials.clientId as string,
    credentials.clientSecret as string,
  );
  oauth2Client.setCredentials({ refresh_token: credentials.refreshToken as string });

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  // Get user email for determining sender direction
  let userEmail = '';
  try {
    const profile = await gmail.users.getProfile({ userId: 'me' });
    userEmail = profile.data.emailAddress ?? '';
  } catch (err) {
    log.error('Failed to get Gmail profile', { error: String(err) });
    return;
  }

  // Fetch threads (paginate if importCount > 100)
  let allThreadIds: string[] = [];
  let pageToken: string | undefined;

  while (allThreadIds.length < maxThreads) {
    const remaining = maxThreads - allThreadIds.length;
    const batchSize = Math.min(remaining, 100);

    try {
      const threadsResult = await gmail.users.threads.list({
        userId: 'me',
        maxResults: batchSize,
        q: 'in:inbox',
        pageToken,
      });

      const threads = threadsResult.data.threads ?? [];
      if (threads.length === 0) break;

      allThreadIds.push(...threads.map((t) => t.id!).filter(Boolean));
      pageToken = threadsResult.data.nextPageToken ?? undefined;
      if (!pageToken) break;
    } catch (err) {
      log.error('Failed to list Gmail threads', { error: String(err) });
      break;
    }
  }

  log.info(`Found ${allThreadIds.length} Gmail threads to import`, { organizationId });

  if (allThreadIds.length === 0) return;

  // Process threads in batches of 20
  const BATCH_SIZE = 20;
  let importedCount = 0;

  for (let i = 0; i < allThreadIds.length; i += BATCH_SIZE) {
    const batch = allThreadIds.slice(i, i + BATCH_SIZE);

    const threadDetails = await Promise.allSettled(
      batch.map((threadId) =>
        gmail.users.threads.get({
          userId: 'me',
          id: threadId,
          format: 'metadata',
          metadataHeaders: ['Subject', 'From', 'To', 'Date', 'Message-ID'],
        }),
      ),
    );

    for (const result of threadDetails) {
      if (result.status === 'rejected') continue;

      const thread = result.value.data;
      const threadId = thread.id;
      if (!threadId) continue;

      const messages = thread.messages ?? [];
      if (messages.length === 0) continue;

      // Extract chat info from first message
      const firstHeaders = messages[0]?.payload?.headers ?? [];
      const subject = firstHeaders.find((h) => h.name === 'Subject')?.value ?? '(no subject)';
      const from = firstHeaders.find((h) => h.name === 'From')?.value ?? '';

      // Parse sender: "Display Name <email>" or just "email"
      const fromMatch = from.match(/^(.+?)\s*<(.+?)>$/);
      const senderName = fromMatch ? fromMatch[1]!.replace(/^["']|["']$/g, '') : from;
      const senderEmail = fromMatch ? fromMatch[2]! : from;

      // Chat name: if sent by user, use subject; otherwise use sender name + subject
      const isSelfThread = senderEmail === userEmail;
      const chatName = isSelfThread ? subject : `${senderName} — ${subject}`;

      try {
        // Upsert chat (idempotent via unique constraint)
        const chat = await prisma.chat.upsert({
          where: {
            externalChatId_messenger_organizationId: {
              externalChatId: threadId,
              messenger: 'gmail',
              organizationId,
            },
          },
          create: {
            externalChatId: threadId,
            messenger: 'gmail',
            name: chatName,
            chatType: 'direct',
            organizationId,
            importedById: userId,
            syncStatus: 'syncing',
            messageCount: messages.length,
          },
          update: {
            syncStatus: 'syncing',
          },
        });

        // Create messages for each email in the thread
        const messageRecords = messages
          .filter((m) => m.id)
          .map((m) => {
            const headers = m.payload?.headers ?? [];
            const msgFrom = headers.find((h) => h.name === 'From')?.value ?? '';
            const msgFromMatch = msgFrom.match(/^(.+?)\s*<(.+?)>$/);
            const msgSenderName = msgFromMatch ? msgFromMatch[1]!.replace(/^["']|["']$/g, '') : msgFrom;
            const msgSenderEmail = msgFromMatch ? msgFromMatch[2]! : msgFrom;
            const dateStr = headers.find((h) => h.name === 'Date')?.value;
            const msgDate = dateStr ? new Date(dateStr) : new Date();
            const snippet = m.snippet ?? '';

            return {
              chatId: chat.id,
              externalMessageId: m.id!,
              senderName: msgSenderName || msgSenderEmail || 'Unknown',
              senderExternalId: msgSenderEmail,
              isSelf: msgSenderEmail === userEmail,
              text: snippet,
              createdAt: msgDate,
            };
          });

        if (messageRecords.length > 0) {
          await prisma.message.createMany({
            data: messageRecords,
            skipDuplicates: true,
          });
        }

        // Get latest message date for lastActivityAt
        const latestDate = messageRecords.reduce(
          (latest, m) => (m.createdAt > latest ? m.createdAt : latest),
          new Date(0),
        );

        // Mark chat as synced
        await prisma.chat.update({
          where: { id: chat.id },
          data: {
            syncStatus: 'synced',
            messageCount: messageRecords.length,
            lastActivityAt: latestDate > new Date(0) ? latestDate : new Date(),
          },
        });

        importedCount++;

        // Notify frontend about new/updated chat
        pubClient.publish('ws:events', JSON.stringify({
          event: 'chat_updated',
          room: `org:${organizationId}`,
          data: { chatId: chat.id },
        })).catch(() => {});
      } catch (err) {
        log.error(`Failed to import Gmail thread ${threadId}`, { error: String(err) });
      }
    }

    // Small delay between batches to avoid Gmail rate limits
    if (i + BATCH_SIZE < allThreadIds.length) {
      await sleep(1);
    }
  }

  // Invalidate chat list cache so frontend sees new chats immediately
  if (importedCount > 0) {
    let cursor = '0';
    const pattern = `cache:${organizationId}:chats:*`;
    do {
      const [nextCursor, keys] = await connection.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        await connection.del(...keys);
      }
    } while (cursor !== '0');
  }

  log.info(`Gmail auto-import complete: ${importedCount}/${allThreadIds.length} threads imported`, { organizationId });
}

// ─── Integration Initial Sync Processor ───
// Triggered right after an integration is connected. Pulls the full list of
// chats from the messenger and upserts a Chat row for each — messages
// themselves stay lazy (a "Load full history" button pulls them later).
// For Gmail we delegate to the existing processGmailAutoImport which already
// does thread-level import.

async function processInitialSync(job: Job<InitialSyncPayload>): Promise<void> {
  const { integrationId, organizationId, userId, messenger, importCount } = job.data;
  log.info('Processing integration:initial-sync', { integrationId, messenger });

  // Gmail has its own thread-based import path — reuse it.
  if (messenger === 'gmail') {
    emitIntegrationSyncStatus(organizationId, integrationId, 'integration_sync_progress', {
      messenger,
      status: 'syncing',
      done: 0,
      total: null,
    });
    await prisma.integration.update({
      where: { id: integrationId },
      data: { syncStatus: 'syncing', syncStartedAt: new Date(), syncError: null },
    });
    try {
      // Delegate to the existing Gmail auto-import.
      await processGmailAutoImport({
        data: { integrationId, organizationId, userId, importCount: importCount ?? 200 },
      } as Job<GmailAutoImportPayload>);
      await prisma.integration.update({
        where: { id: integrationId },
        data: { syncStatus: 'synced' },
      });
      emitIntegrationSyncStatus(organizationId, integrationId, 'integration_sync_complete', {
        messenger,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await prisma.integration.update({
        where: { id: integrationId },
        data: { syncStatus: 'failed', syncError: message },
      });
      emitIntegrationSyncStatus(organizationId, integrationId, 'integration_sync_failed', {
        messenger,
        error: message,
      });
    }
    return;
  }

  // Non-Gmail messengers: list chats + upsert.
  const integration = await prisma.integration.findUnique({
    where: { id: integrationId },
    select: { credentials: true },
  });

  if (!integration) {
    log.warn('Integration not found for initial sync', { integrationId });
    return;
  }

  await prisma.integration.update({
    where: { id: integrationId },
    data: {
      syncStatus: 'syncing',
      syncStartedAt: new Date(),
      syncCompletedChats: 0,
      syncTotalChats: null,
      syncError: null,
    },
  });

  emitIntegrationSyncStatus(organizationId, integrationId, 'integration_sync_progress', {
    messenger,
    status: 'syncing',
    done: 0,
    total: null,
  });

  let adapter;
  try {
    const credentials = decryptCredentials<Record<string, unknown>>(integration.credentials as string);
    adapter = await createAdapter(messenger, credentials, { organizationId });
    await adapter.connect();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to connect adapter for initial sync', { error: message });
    await prisma.integration.update({
      where: { id: integrationId },
      data: { syncStatus: 'failed', syncError: `Connect failed: ${message}` },
    });
    emitIntegrationSyncStatus(organizationId, integrationId, 'integration_sync_failed', {
      messenger,
      error: `Connect failed: ${message}`,
    });
    return;
  }

  try {
    const chats = await adapter.listChats();
    const total = chats.length;

    await prisma.integration.update({
      where: { id: integrationId },
      data: { syncTotalChats: total },
    });

    emitIntegrationSyncStatus(organizationId, integrationId, 'integration_sync_progress', {
      messenger,
      status: 'syncing',
      done: 0,
      total,
    });

    log.info(`Initial sync: ${total} chats to import`, { integrationId, messenger });

    let done = 0;
    const BATCH_SIZE = 25;

    for (let i = 0; i < chats.length; i += BATCH_SIZE) {
      const batch = chats.slice(i, i + BATCH_SIZE);

      for (const c of batch) {
        const chatType: 'direct' | 'group' | 'channel' =
          c.chatType === 'channel' ? 'channel' : c.chatType === 'group' ? 'group' : 'direct';

        await ensureChat({
          organizationId,
          importedById: userId,
          messenger,
          externalChatId: c.externalChatId,
          name: c.name || c.externalChatId,
          chatType,
        });
        done++;
      }

      await prisma.integration.update({
        where: { id: integrationId },
        data: { syncCompletedChats: done },
      });

      emitIntegrationSyncStatus(organizationId, integrationId, 'integration_sync_progress', {
        messenger,
        status: 'syncing',
        done,
        total,
        currentName: batch[batch.length - 1]?.name,
      });
    }

    await prisma.integration.update({
      where: { id: integrationId },
      data: { syncStatus: 'synced', syncCompletedChats: done },
    });

    // Queue message history sync for all newly imported chats
    const pendingChats = await prisma.chat.findMany({
      where: { organizationId, messenger, syncStatus: 'pending' },
      select: { id: true },
    });
    if (pendingChats.length > 0) {
      const syncQueue = new Queue('message-sync', { connection: bullConnection });
      const chatIds = pendingChats.map((c) => c.id);
      // Batch into groups of 10 to avoid overwhelming the adapter
      for (let i = 0; i < chatIds.length; i += 10) {
        await syncQueue.add('sync:chat-history', {
          chatIds: chatIds.slice(i, i + 10),
          integrationId,
          organizationId,
          messenger,
        } satisfies MessageSyncPayload);
      }
      await syncQueue.close();
      log.info(`Queued message history sync for ${chatIds.length} chats`, { integrationId });
    }

    // Invalidate chat list cache so the frontend picks up the new chats
    let cursor = '0';
    const pattern = `cache:${organizationId}:chats:*`;
    do {
      const [nextCursor, keys] = await connection.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        await connection.del(...keys);
      }
    } while (cursor !== '0');

    emitIntegrationSyncStatus(organizationId, integrationId, 'integration_sync_complete', {
      messenger,
      total,
    });

    log.info(`Initial sync complete for ${messenger}: ${done}/${total} chats imported`, {
      integrationId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Initial sync failed', { error: message });
    await prisma.integration.update({
      where: { id: integrationId },
      data: { syncStatus: 'failed', syncError: message },
    });
    emitIntegrationSyncStatus(organizationId, integrationId, 'integration_sync_failed', {
      messenger,
      error: message,
    });
  } finally {
    try { await adapter.disconnect(); } catch {}
  }
}

// ─── Gmail Watch Renewal Processor ───

async function processGmailWatchRenewal(): Promise<void> {
  const gmailPubSubTopic = process.env.GMAIL_PUBSUB_TOPIC;
  if (!gmailPubSubTopic) {
    log.info('GMAIL_PUBSUB_TOPIC not set, skipping watch renewal');
    return;
  }

  const integrations = await prisma.integration.findMany({
    where: { messenger: 'gmail', status: 'connected' },
    select: { id: true, credentials: true, settings: true },
  });

  log.info(`Renewing Gmail watch for ${integrations.length} integration(s)`);

  for (const integration of integrations) {
    try {
      const credentials = decryptCredentials<{
        clientId: string;
        clientSecret: string;
        refreshToken: string;
      }>(integration.credentials as string);

      const { google } = await import('googleapis');
      const oauth2Client = new google.auth.OAuth2(
        credentials.clientId,
        credentials.clientSecret,
      );
      oauth2Client.setCredentials({ refresh_token: credentials.refreshToken });

      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

      const watchResponse = await gmail.users.watch({
        userId: 'me',
        requestBody: {
          topicName: gmailPubSubTopic,
          labelIds: ['INBOX'],
        },
      });

      const historyId = watchResponse.data.historyId;
      if (historyId) {
        const metadata = (integration.settings ?? {}) as Record<string, unknown>;
        await prisma.integration.update({
          where: { id: integration.id },
          data: { settings: { ...metadata, lastHistoryId: historyId } },
        });
      }

      log.info(`Gmail watch renewed for integration ${integration.id}`);
    } catch (err) {
      log.error(`Failed to renew Gmail watch for integration ${integration.id}`, { error: String(err) });
    }
  }
}

// ─── Worker Setup ───

/**
 * Rows stranded in 'sending' mean a previous worker died between the delivery
 * attempt and the status write — the message may or may not have arrived.
 * They become terminal, non-retriable failures: the `unverified:` prefix is
 * what the retry route checks to refuse a re-send that could duplicate a
 * message in a real chat.
 */
export async function sweepStrandedSends(): Promise<number> {
  const swept = await prisma.broadcastChat.updateMany({
    where: { status: 'sending' },
    data: {
      status: 'failed',
      errorReason: 'unverified: worker restarted mid-send — the message may have been delivered, retry is blocked',
    },
  });
  if (swept.count > 0) {
    log.warn(`Swept ${swept.count} broadcast chat(s) stranded mid-send by a previous worker`, {});
  }
  return swept.count;
}

log.info('Worker service starting...');

await sweepStrandedSends();

const worker = new Worker<BroadcastSendPayload>(
  'broadcast',
  async (job) => {
    switch (job.name) {
      case 'broadcast:send':
        await processBroadcastSend(job);
        break;
      case 'broadcast:retry':
        await processBroadcastRetry(job);
        break;
      default:
        log.warn(`Unknown job name: ${job.name}`, { jobId: job.id });
    }
  },
  {
    connection: bullConnection,
    concurrency: 3,
    limiter: {
      max: 5,
      duration: 1000,
    },
  },
);

// ─── Message Sync Worker ───

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const messageSyncWorker = new Worker<any>(
  'message-sync',
  async (job) => {
    if (job.name === 'sync:chat-history') {
      await processChatHistorySync(job as Job<MessageSyncPayload>);
    } else if (job.name === 'sync:gmail-rehydrate') {
      await processGmailRehydrate(job as Job<GmailRehydratePayload>);
    } else if (job.name === 'gmail:auto-import') {
      await processGmailAutoImport(job as Job<GmailAutoImportPayload>);
    } else if (job.name === 'chats:discovery') {
      await runChatDiscovery();
    } else if (job.name === 'gmail:renew-watch') {
      await processGmailWatchRenewal();
    } else if (job.name === 'integration:initial-sync') {
      await processInitialSync(job as Job<InitialSyncPayload>);
    } else {
      log.warn(`Unknown message-sync job name: ${job.name}`, { jobId: job.id });
    }
  },
  {
    connection: bullConnection,
    concurrency: 2,
  },
);

messageSyncWorker.on('completed', (job) => {
  log.info(`Message sync job ${job.id} completed`);
});

messageSyncWorker.on('failed', (job, err) => {
  log.error(`Message sync job ${job?.id} failed`, { error: err.message });
});

messageSyncWorker.on('error', (err) => {
  log.error('Message sync worker error', { error: err.message });
});

log.info('Message sync worker ready, listening for jobs');

// ─── Worker Events ───

worker.on('completed', (job) => {
  log.info(`Job ${job.id} (${job.name}) completed`, {
    broadcastId: job.data.broadcastId,
  });
});

worker.on('failed', (job, err) => {
  log.error(`Job ${job?.id} (${job?.name}) failed`, {
    broadcastId: job?.data.broadcastId,
    error: err.message,
  });

  // If the job itself failed (not individual messages), update broadcast status
  if (job?.data.broadcastId) {
    prisma.broadcast.update({
      where: { id: job.data.broadcastId },
      data: { status: 'failed' },
    }).catch((updateErr) => {
      log.error('Failed to update broadcast status after job failure', {
        error: String(updateErr),
      });
    });

    emitBroadcastStatus(
      job.data.organizationId,
      job.data.broadcastId,
      'failed',
    );
  }
});

worker.on('error', (err) => {
  log.error('Worker error', { error: err.message });
});

log.info('Broadcast worker ready, listening for jobs');

// ─── Startup Recovery ───
// On startup, find any overdue scheduled broadcasts and enqueue them.
// This handles the case where the worker was down when a scheduled time arrived.

async function recoverOverdueScheduledBroadcasts(): Promise<void> {
  try {
    const broadcastQueue = new Queue('broadcast', { connection: bullConnection });

    const overdue = await prisma.broadcast.findMany({
      where: {
        status: 'scheduled',
        scheduledAt: { lte: new Date() },
      },
      select: { id: true, organizationId: true },
    });

    if (overdue.length === 0) return;

    log.info(`Recovering ${overdue.length} overdue scheduled broadcast(s)`);

    for (const b of overdue) {
      const jobId = `broadcast-recovery-${b.id}-${Date.now()}`;
      await broadcastQueue.add(
        'broadcast:send',
        { broadcastId: b.id, organizationId: b.organizationId },
        { jobId },
      );
      log.info(`Queued overdue broadcast ${b.id}`);
    }

    await broadcastQueue.close();
  } catch (err) {
    log.error('Failed to recover overdue broadcasts', { error: String(err) });
  }
}

// ─── Stuck 'sending' Broadcast Recovery ───
// A deploy can kill the worker mid-send. The boot sweep flips in-flight
// 'sending' rows to unverified failures, but the broadcast itself stays
// 'sending' and its untouched 'pending'/'retrying' rows would never go out —
// BullMQ's stalled-job redelivery gives up after one stall. Safe to re-enqueue:
// the send processor only picks up rows still in 'pending', so nothing already
// attempted can be sent twice.
async function recoverStuckSendingBroadcasts(): Promise<void> {
  try {
    const queue = new Queue('broadcast', { connection: bullConnection });

    const stuck = await prisma.broadcast.findMany({
      where: { status: { in: ['sending', 'canceling'] } },
      select: { id: true, organizationId: true, status: true },
    });
    if (stuck.length === 0) {
      await queue.close();
      return;
    }

    // Skip broadcasts that still have a live job — BullMQ's own stalled
    // redelivery may be about to resume them.
    const liveJobs = await queue.getJobs(['active', 'waiting', 'delayed', 'prioritized']);
    const liveIds = new Set(
      liveJobs
        .map((j) => (j?.data as { broadcastId?: string } | undefined)?.broadcastId)
        .filter(Boolean),
    );

    for (const b of stuck) {
      if (liveIds.has(b.id)) continue;

      // A 'canceling' broadcast whose worker died mid-cancel: finish the
      // cancel instead of resuming the send.
      if (b.status === 'canceling') {
        await prisma.broadcastChat.updateMany({
          where: { broadcastId: b.id, status: 'pending' },
          data: { status: 'skipped', errorReason: 'Broadcast canceled by user' },
        });
        await finalizeBroadcast(b.id, b.organizationId);
        log.info(`Finalized interrupted cancel for broadcast ${b.id}`);
        continue;
      }

      const counts = await prisma.broadcastChat.groupBy({
        by: ['status'],
        where: { broadcastId: b.id },
        _count: true,
      });
      const byStatus = new Map(counts.map((c) => [c.status, c._count]));
      const pending = byStatus.get('pending') ?? 0;
      const retrying = byStatus.get('retrying') ?? 0;

      if (pending > 0) {
        await queue.add(
          'broadcast:send',
          { broadcastId: b.id, organizationId: b.organizationId },
          { jobId: `broadcast-stuck-${b.id}-${Date.now()}` },
        );
        log.info(`Re-enqueued stuck 'sending' broadcast ${b.id} (${pending} pending chat(s))`);
      } else if (retrying > 0) {
        await queue.add(
          'broadcast:retry',
          { broadcastId: b.id, organizationId: b.organizationId },
          { jobId: `broadcast-stuck-retry-${b.id}-${Date.now()}` },
        );
        log.info(`Re-enqueued stuck retrying broadcast ${b.id} (${retrying} retrying chat(s))`);
      } else {
        // The worker died between the last send and finalize.
        await finalizeBroadcast(b.id, b.organizationId);
        log.info(`Finalized stuck broadcast ${b.id} (no pending work)`);
      }
    }

    await queue.close();
  } catch (err) {
    log.error('Failed to recover stuck sending broadcasts', { error: String(err) });
  }
}

// ─── Chat Sync Startup Recovery ───
// On startup, find chats with pending/syncing/failed sync status and queue sync jobs.

async function recoverPendingChatSyncs(): Promise<void> {
  try {
    const messageSyncQueue = new Queue('message-sync', { connection: bullConnection });

    // Find all chats that need syncing (grouped by org + messenger)
    const pendingChats = await prisma.chat.findMany({
      where: {
        syncStatus: { in: ['pending', 'syncing', 'failed'] },
        deletedAt: null,
      },
      select: { id: true, organizationId: true, messenger: true },
    });

    if (pendingChats.length === 0) {
      await messageSyncQueue.close();
      return;
    }

    log.info(`Recovering ${pendingChats.length} chat(s) needing history sync`);

    // Group by org + messenger to find matching integrations
    const groups = new Map<string, { orgId: string; messenger: string; chatIds: string[] }>();
    for (const chat of pendingChats) {
      const key = `${chat.organizationId}:${chat.messenger}`;
      if (!groups.has(key)) {
        groups.set(key, { orgId: chat.organizationId, messenger: chat.messenger, chatIds: [] });
      }
      groups.get(key)!.chatIds.push(chat.id);
    }

    for (const [, group] of groups) {
      // Find the connected integration for this org + messenger
      const integration = await prisma.integration.findFirst({
        where: {
          organizationId: group.orgId,
          messenger: group.messenger,
          status: 'connected',
        },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });

      if (!integration) {
        log.warn(`No connected integration for ${group.messenger} in org ${group.orgId}, skipping sync`);
        continue;
      }

      const jobId = `sync-recovery-${group.orgId}-${group.messenger}-${Date.now()}`;
      await messageSyncQueue.add(
        'sync:chat-history',
        {
          chatIds: group.chatIds,
          integrationId: integration.id,
          organizationId: group.orgId,
          messenger: group.messenger,
        },
        { jobId },
      );
      log.info(`Queued history sync for ${group.chatIds.length} ${group.messenger} chats in org ${group.orgId}`);
    }

    await messageSyncQueue.close();
  } catch (err) {
    log.error('Failed to recover pending chat syncs', { error: String(err) });
  }
}

// ─── Gmail Watch Renewal Schedule ───
// ─── Periodic chat discovery ───
// Every few hours, ask each connected messenger for its chat list and record
// how many chats were never imported. The web app shows these counts as the
// "new chats pending" banner. Gmail is skipped: email threads appear on their
// own and are not "chats to discover".

async function runChatDiscovery(): Promise<void> {
  const integrations = await prisma.integration.findMany({
    where: { status: 'connected', messenger: { not: 'gmail' } },
    orderBy: { createdAt: 'asc' },
  });

  // Group by org+messenger — Task 3/4 made more than one connected account
  // per org+messenger possible (an admin's shared connection plus one or
  // more users' personal ones), so a chat only one of them can reach must
  // still show up as "pending" rather than being missed because we only
  // ever scanned the first (oldest) connection.
  const groups = new Map<string, { organizationId: string; messenger: string; integrations: typeof integrations }>();
  for (const integration of integrations) {
    const key = integration.organizationId + ':' + integration.messenger;
    const group = groups.get(key) ?? { organizationId: integration.organizationId, messenger: integration.messenger, integrations: [] };
    group.integrations.push(integration);
    groups.set(key, group);
  }

  for (const { organizationId, messenger, integrations: groupIntegrations } of groups.values()) {
    try {
      const scannedMap = new Map<string, { externalChatId: string; name?: string }>();
      for (const integration of groupIntegrations) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let adapter: any;
        try {
          const credentials = decryptCredentials<Record<string, unknown>>(integration.credentials as string);
          adapter = await createAdapter(messenger, credentials, { organizationId });
          await adapter.connect();
          const scanned = await adapter.listChats();
          for (const c of scanned as Array<{ externalChatId: string; name?: string }>) {
            scannedMap.set(c.externalChatId, c);
          }
        } catch (err) {
          // One connection failing doesn't invalidate the others' sightings.
          log.warn(`Chat discovery: one ${messenger} connection failed to scan`, { organizationId, error: String(err) });
        } finally {
          try { await adapter?.disconnect(); } catch { /* ignore */ }
        }
      }

      const scanned = [...scannedMap.values()];
      const imported = await prisma.chat.findMany({
        where: { organizationId, messenger, deletedAt: null },
        select: { externalChatId: true },
      });
      const importedIds = new Set(imported.map((c) => c.externalChatId));
      const fresh = scanned.filter((c) => !importedIds.has(c.externalChatId));
      const newCount = fresh.length;

      // Keep DiscoveredChat in step so firstSeenAt stays stable for the UI.
      // Transactional: a concurrent manual scan must never observe (or
      // leave behind) a half-replaced set, which would reset firstSeenAt.
      await prisma.$transaction(async (tx) => {
        await tx.discoveredChat.deleteMany({
          where: {
            organizationId,
            messenger,
            externalChatId: { notIn: fresh.map((c) => c.externalChatId) },
          },
        });
        if (fresh.length > 0) {
          await tx.discoveredChat.createMany({
            data: fresh.map((c) => ({
              organizationId,
              messenger,
              externalChatId: c.externalChatId,
              name: c.name ?? null,
            })),
            skipDuplicates: true,
          });
        }
      });

      // Atomic per-messenger jsonb update — concurrent scans for different
      // messengers each touch only their own key instead of clobbering the
      // whole object (mirrors apps/api/src/lib/pending-imports.ts).
      if (newCount > 0) {
        const entry = JSON.stringify({ count: newCount, at: new Date().toISOString() });
        await prisma.$executeRaw`
          UPDATE "Organization"
          SET "pendingImports" = jsonb_set(COALESCE("pendingImports", '{}'::jsonb), ARRAY[${messenger}], ${entry}::jsonb, true)
          WHERE id = ${organizationId}
        `;
      } else {
        await prisma.$executeRaw`
          UPDATE "Organization"
          SET "pendingImports" = COALESCE("pendingImports", '{}'::jsonb) - ${messenger}
          WHERE id = ${organizationId}
        `;
      }
      log.info(`Chat discovery: ${messenger} has ${newCount} new chat(s)`, { organizationId });
    } catch (err) {
      // A failed scan proves nothing — leave the previous counts alone.
      log.warn(`Chat discovery failed for ${messenger}`, { organizationId, error: String(err) });
    }
  }
}

async function scheduleChatDiscovery(): Promise<void> {
  try {
    const queue = new Queue('message-sync', { connection: bullConnection });
    await queue.add(
      'chats:discovery',
      {},
      {
        jobId: 'chats-discovery-6h',
        repeat: { every: 6 * 60 * 60 * 1000 }, // every 6 hours
      },
    );
    await queue.close();
    log.info('Chat discovery scheduled (every 6h)');
  } catch (err) {
    log.error('Failed to schedule chat discovery', { error: String(err) });
  }
}

// Renew Gmail Pub/Sub watches daily (they expire after 7 days)

async function scheduleGmailWatchRenewal(): Promise<void> {
  try {
    const renewalQueue = new Queue('message-sync', { connection: bullConnection });
    await renewalQueue.add(
      'gmail:renew-watch',
      {},
      {
        jobId: 'gmail-renew-watch-daily',
        repeat: { every: 24 * 60 * 60 * 1000 }, // every 24 hours
      },
    );
    await renewalQueue.close();
    log.info('Gmail watch renewal scheduled (daily)');
  } catch (err) {
    log.error('Failed to schedule Gmail watch renewal', { error: String(err) });
  }
}

// Run recovery after a short delay to ensure worker is fully ready
setTimeout(() => {
  recoverOverdueScheduledBroadcasts().catch((err) => {
    log.error('Startup recovery error', { error: String(err) });
  });
  recoverStuckSendingBroadcasts().catch((err) => {
    log.error('Stuck sending recovery error', { error: String(err) });
  });
  recoverPendingChatSyncs().catch((err) => {
    log.error('Chat sync recovery error', { error: String(err) });
  });
  scheduleChatDiscovery().catch((err) => {
    log.error('chat discovery scheduling error', { error: String(err) });
  });
  scheduleGmailWatchRenewal().catch((err) => {
    log.error('Gmail watch schedule error', { error: String(err) });
  });
}, 5000);

// ─── Health check HTTP server ───
// Lightweight endpoint so orchestrators (Railway, k8s) can monitor worker health.

import { createServer } from 'node:http';

const HEALTH_PORT = parseInt(process.env.HEALTH_PORT ?? '3002', 10);

const healthServer = createServer(async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const redisOk = connection.status === 'ready';
    if (!redisOk) throw new Error('Redis not ready');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
  } catch (err) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'error', error: err instanceof Error ? err.message : 'Unknown' }));
  }
});

healthServer.listen(HEALTH_PORT, () => {
  log.info(`Worker health check listening on :${HEALTH_PORT}`);
});

// ─── Graceful Shutdown ───

async function shutdown(signal: string) {
  log.info(`Received ${signal}, shutting down gracefully`);

  // Close health check server and workers. worker.close() waits for active
  // jobs, but a broadcast batch can run for many minutes — far beyond the
  // platform's SIGTERM→SIGKILL grace — so bound the drain: whatever doesn't
  // finish is covered by the boot sweep + stuck-'sending' recovery.
  healthServer.close();
  const drain = Promise.allSettled([worker.close(), messageSyncWorker.close()]);
  const timedOut = await Promise.race([
    drain.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 25_000)),
  ]);
  log.info(timedOut ? 'Drain timed out after 25s — exiting anyway' : 'Workers closed');

  // Disconnect from databases
  await prisma.$disconnect().catch(() => {});
  await pubClient.quit().catch(() => {});
  await connection.quit().catch(() => {});

  log.info('All connections closed');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A single stray promise must not crash-loop the container mid-broadcast:
// log loudly and keep running — job-level state (sending sweep, recovery)
// keeps the data consistent either way.
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled promise rejection', { error: String(reason) });
});
process.on('uncaughtException', (err) => {
  log.error('Uncaught exception', { error: String(err), stack: err?.stack });
});
