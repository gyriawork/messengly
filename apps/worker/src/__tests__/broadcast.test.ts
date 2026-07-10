import { describe, it, expect, vi, beforeEach, beforeAll, type Mock } from 'vitest';
import { Worker, Queue } from 'bullmq';
import prisma from '../lib/prisma.js';
import { createAdapter } from '../integrations/factory.js';
import type { MessengerAdapter } from '../integrations/base.js';

// ─── Helpers ───

function mockJob(name: string, data: Record<string, unknown>) {
  return {
    id: `test-job-${Date.now()}`,
    name,
    data,
    attemptsMade: 0,
    progress: vi.fn(),
    log: vi.fn(),
    updateProgress: vi.fn(),
  };
}

function makeBroadcastChat(overrides: {
  id?: string;
  chatId?: string;
  externalChatId?: string;
  messenger?: string;
  retryCount?: number;
  status?: string;
}) {
  const id = overrides.id ?? `bc-${Math.random().toString(36).slice(2, 8)}`;
  const chatId = overrides.chatId ?? `chat-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    broadcastId: 'broadcast-1',
    chatId,
    status: overrides.status ?? 'pending',
    retryCount: overrides.retryCount ?? 0,
    sentAt: null,
    errorReason: null,
    chat: {
      id: chatId,
      externalChatId: overrides.externalChatId ?? `ext-${chatId}`,
      messenger: overrides.messenger ?? 'telegram',
    },
  };
}

function makeSuccessAdapter(): MessengerAdapter {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    listChats: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn().mockResolvedValue({ externalMessageId: 'ext-msg-1' }),
    editMessage: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockReturnValue('connected'),
  };
}

function makeFailingAdapter(error: Error): MessengerAdapter {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    listChats: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn().mockRejectedValue(error),
    editMessage: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockReturnValue('connected'),
  };
}

// ─── Capture processor callback from Worker constructor ───

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let broadcastProcessor: (job: any) => Promise<void>;

beforeAll(async () => {
  // The Worker mock is set up in setup.ts. We need to capture the
  // processor callback when index.ts creates `new Worker('broadcast', fn, ...)`.
  // Override the Worker mock to capture the callback.
  (Worker as unknown as Mock).mockImplementation(
    (queueName: string, processor: (...args: unknown[]) => unknown) => {
      if (queueName === 'broadcast') {
        broadcastProcessor = processor as typeof broadcastProcessor;
      }
      return {
        on: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
      };
    },
  );

  (Queue as unknown as Mock).mockImplementation(() => ({
    add: vi.fn().mockResolvedValue({ id: 'mock-job-id' }),
    close: vi.fn().mockResolvedValue(undefined),
  }));

  // Import the module — this triggers all top-level code and creates the workers
  await import('../index.js');
});

// ─── Per-test setup ───

function stubDefaultBroadcast(overrides?: Record<string, unknown>) {
  (prisma.broadcast.findFirst as Mock).mockResolvedValue({
    id: 'broadcast-1',
    organizationId: 'org-1',
    status: 'sending',
    messageText: 'Hello World',
    scheduledAt: null,
    ...overrides,
  });
}

beforeEach(() => {
  // Reset data mocks but not module-level mocks (ioredis, bullmq)
  vi.mocked(prisma.broadcast.findFirst).mockReset();
  vi.mocked(prisma.broadcast.findMany).mockReset();
  vi.mocked(prisma.broadcast.update).mockReset();
  vi.mocked(prisma.broadcastChat.findMany).mockReset();
  vi.mocked(prisma.broadcastChat.update).mockReset();
  vi.mocked(prisma.broadcastChat.updateMany).mockReset();
  vi.mocked(prisma.antibanSettings.findUnique).mockReset();
  vi.mocked(prisma.integration.findFirst).mockReset();
  vi.mocked(createAdapter as Mock).mockReset();

  // Default: no custom antiban (use built-in defaults)
  (prisma.antibanSettings.findUnique as Mock).mockResolvedValue(null);

  // Default integration
  (prisma.integration.findFirst as Mock).mockResolvedValue({
    id: 'int-1',
    messenger: 'telegram',
    organizationId: 'org-1',
    status: 'connected',
    credentials: 'encrypted-creds',
  });

  // Default: broadcast.update succeeds
  (prisma.broadcast.update as Mock).mockResolvedValue({});
  (prisma.broadcastChat.update as Mock).mockResolvedValue({});
  (prisma.broadcastChat.updateMany as Mock).mockResolvedValue({ count: 0 });
});

// ═══════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════

describe('Broadcast Worker', () => {
  // ──────────────────────────────────────────
  // processBroadcastSend
  // ──────────────────────────────────────────

  describe('processBroadcastSend', () => {
    it('should group chats by messenger and send via correct adapters', async () => {
      stubDefaultBroadcast({ status: 'scheduled' });

      const telegramChat = makeBroadcastChat({ messenger: 'telegram', externalChatId: 'tg-1' });
      const slackChat = makeBroadcastChat({ messenger: 'slack', externalChatId: 'sl-1' });

      // pendingChats query
      (prisma.broadcastChat.findMany as Mock).mockResolvedValueOnce([telegramChat, slackChat]);

      const tgAdapter = makeSuccessAdapter();
      const slackAdapter = makeSuccessAdapter();

      (createAdapter as Mock)
        .mockResolvedValueOnce(tgAdapter)
        .mockResolvedValueOnce(slackAdapter);

      // finalizeBroadcast query
      (prisma.broadcastChat.findMany as Mock).mockResolvedValueOnce([
        { status: 'sent' },
        { status: 'sent' },
      ]);

      const job = mockJob('broadcast:send', { broadcastId: 'broadcast-1', organizationId: 'org-1' });
      await broadcastProcessor(job);

      expect(tgAdapter.connect).toHaveBeenCalled();
      expect(slackAdapter.connect).toHaveBeenCalled();
      expect(tgAdapter.sendMessage).toHaveBeenCalledWith('tg-1', 'Hello World');
      expect(slackAdapter.sendMessage).toHaveBeenCalledWith('sl-1', 'Hello World');
    });

    it('should transition scheduled broadcast to sending status', async () => {
      stubDefaultBroadcast({ status: 'scheduled' });
      (prisma.broadcastChat.findMany as Mock)
        .mockResolvedValueOnce([]) // pendingChats
        .mockResolvedValueOnce([]); // finalizeBroadcast

      const job = mockJob('broadcast:send', { broadcastId: 'broadcast-1', organizationId: 'org-1' });
      await broadcastProcessor(job);

      expect(prisma.broadcast.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'broadcast-1' },
          data: expect.objectContaining({ status: 'sending' }),
        }),
      );
    });

    it('should also transition draft broadcast to sending status', async () => {
      stubDefaultBroadcast({ status: 'draft' });
      (prisma.broadcastChat.findMany as Mock)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const job = mockJob('broadcast:send', { broadcastId: 'broadcast-1', organizationId: 'org-1' });
      await broadcastProcessor(job);

      expect(prisma.broadcast.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'sending' }),
        }),
      );
    });

    it('should skip broadcast in unexpected status (e.g. "sent")', async () => {
      stubDefaultBroadcast({ status: 'sent' });

      const job = mockJob('broadcast:send', { broadcastId: 'broadcast-1', organizationId: 'org-1' });
      await broadcastProcessor(job);

      expect(prisma.broadcastChat.findMany).not.toHaveBeenCalled();
    });

    it('should skip when broadcast is not found', async () => {
      (prisma.broadcast.findFirst as Mock).mockResolvedValue(null);

      const job = mockJob('broadcast:send', { broadcastId: 'nonexistent', organizationId: 'org-1' });
      await broadcastProcessor(job);

      expect(prisma.broadcastChat.findMany).not.toHaveBeenCalled();
    });

    it('should mark chats as sent on adapter success', async () => {
      stubDefaultBroadcast();

      const chat1 = makeBroadcastChat({ id: 'bc-1', messenger: 'telegram' });
      (prisma.broadcastChat.findMany as Mock)
        .mockResolvedValueOnce([chat1]) // pendingChats
        .mockResolvedValueOnce([{ status: 'sent' }]); // finalizeBroadcast

      const adapter = makeSuccessAdapter();
      (createAdapter as Mock).mockResolvedValue(adapter);

      const job = mockJob('broadcast:send', { broadcastId: 'broadcast-1', organizationId: 'org-1' });
      await broadcastProcessor(job);

      expect(prisma.broadcastChat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'bc-1' },
          data: expect.objectContaining({
            status: 'sent',
            errorReason: null,
          }),
        }),
      );
    });

    it('should mark the chat as sending before the delivery attempt', async () => {
      stubDefaultBroadcast();

      const chat1 = makeBroadcastChat({ id: 'bc-idem', messenger: 'telegram' });
      (prisma.broadcastChat.findMany as Mock)
        .mockResolvedValueOnce([chat1])
        .mockResolvedValueOnce([{ status: 'sent' }]);

      const adapter = makeSuccessAdapter();
      (createAdapter as Mock).mockResolvedValue(adapter);

      const job = mockJob('broadcast:send', { broadcastId: 'broadcast-1', organizationId: 'org-1' });
      await broadcastProcessor(job);

      // The 'sending' write must land BEFORE the delivery attempt: it is the
      // crash marker that prevents a blind re-send after a worker restart.
      const updateCalls = (prisma.broadcastChat.update as Mock).mock.calls;
      const sendingIdx = updateCalls.findIndex((c) => c[0]?.data?.status === 'sending' && c[0]?.where?.id === 'bc-idem');
      const sentIdx = updateCalls.findIndex((c) => c[0]?.data?.status === 'sent' && c[0]?.where?.id === 'bc-idem');
      expect(sendingIdx).toBeGreaterThanOrEqual(0);
      expect(sentIdx).toBeGreaterThan(sendingIdx);

      const sendingOrder = (prisma.broadcastChat.update as Mock).mock.invocationCallOrder[sendingIdx]!;
      const sendMessageOrder = (adapter.sendMessage as Mock).mock.invocationCallOrder[0]!;
      expect(sendingOrder).toBeLessThan(sendMessageOrder);
    });

    it('sweepStrandedSends turns stranded sending rows into unverified failures', async () => {
      const mod = await import('../index.js');
      (prisma.broadcastChat.updateMany as Mock).mockResolvedValueOnce({ count: 2 });

      const swept = await mod.sweepStrandedSends();

      expect(swept).toBe(2);
      expect(prisma.broadcastChat.updateMany).toHaveBeenCalledWith({
        where: { status: 'sending' },
        data: {
          status: 'failed',
          errorReason: expect.stringMatching(/^unverified: /),
        },
      });
    });

    it('should skip inactive chats up front without attempting delivery', async () => {
      stubDefaultBroadcast();

      const active = makeBroadcastChat({ id: 'bc-active', messenger: 'telegram' });
      const inactive = makeBroadcastChat({ id: 'bc-inactive', messenger: 'telegram' });
      (prisma.broadcastChat.findMany as Mock)
        .mockResolvedValueOnce([active, inactive]) // pendingChats
        .mockResolvedValueOnce([{ status: 'sent' }, { status: 'skipped' }]); // finalizeBroadcast

      // The reachability check reports the second chat as inactive.
      (prisma.chat.findMany as Mock).mockResolvedValueOnce([
        { id: active.chatId, status: 'active' },
        { id: inactive.chatId, status: 'inactive' },
      ]);

      const adapter = makeSuccessAdapter();
      (createAdapter as Mock).mockResolvedValue(adapter);

      const job = mockJob('broadcast:send', { broadcastId: 'broadcast-1', organizationId: 'org-1' });
      await broadcastProcessor(job);

      expect(prisma.broadcastChat.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['bc-inactive'] } },
          data: expect.objectContaining({ status: 'skipped' }),
        }),
      );
      // Delivery was attempted only for the reachable chat.
      expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
      expect(adapter.sendMessage).toHaveBeenCalledWith(active.chat.externalChatId, expect.any(String), expect.anything());
    });

    it('should mark chats as failed when adapter sendMessage throws', async () => {
      stubDefaultBroadcast();

      const chat1 = makeBroadcastChat({ id: 'bc-fail-1', messenger: 'telegram' });
      (prisma.broadcastChat.findMany as Mock)
        .mockResolvedValueOnce([chat1])
        .mockResolvedValueOnce([{ status: 'failed' }]);

      const adapter = makeFailingAdapter(new Error('Telegram API rate limit'));
      (createAdapter as Mock).mockResolvedValue(adapter);

      const job = mockJob('broadcast:send', { broadcastId: 'broadcast-1', organizationId: 'org-1' });
      await broadcastProcessor(job);

      expect(prisma.broadcastChat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'bc-fail-1' },
          data: expect.objectContaining({
            status: 'failed',
            errorReason: 'Telegram API rate limit',
          }),
        }),
      );
    });

    it('should mark all chats as failed when adapter connection fails', async () => {
      stubDefaultBroadcast();

      const chat1 = makeBroadcastChat({ id: 'bc-c1', messenger: 'telegram' });
      const chat2 = makeBroadcastChat({ id: 'bc-c2', messenger: 'telegram' });
      (prisma.broadcastChat.findMany as Mock)
        .mockResolvedValueOnce([chat1, chat2])
        .mockResolvedValueOnce([{ status: 'failed' }, { status: 'failed' }]);

      const brokenAdapter: MessengerAdapter = {
        connect: vi.fn().mockRejectedValue(new Error('Connection refused')),
        disconnect: vi.fn(),
        listChats: vi.fn(),
        sendMessage: vi.fn(),
        editMessage: vi.fn(),
        deleteMessage: vi.fn(),
        getStatus: vi.fn().mockReturnValue('disconnected'),
      };
      (createAdapter as Mock).mockResolvedValue(brokenAdapter);

      const job = mockJob('broadcast:send', { broadcastId: 'broadcast-1', organizationId: 'org-1' });
      await broadcastProcessor(job);

      expect(prisma.broadcastChat.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['bc-c1', 'bc-c2'] } },
          data: expect.objectContaining({
            status: 'failed',
            errorReason: expect.stringContaining('Connection refused'),
          }),
        }),
      );
      // sendMessage should never have been called
      expect(brokenAdapter.sendMessage).not.toHaveBeenCalled();
    });

    it('should mark all chats as failed when no integration exists', async () => {
      stubDefaultBroadcast();

      const chat1 = makeBroadcastChat({ id: 'bc-noint', messenger: 'telegram' });
      (prisma.broadcastChat.findMany as Mock)
        .mockResolvedValueOnce([chat1])
        .mockResolvedValueOnce([{ status: 'failed' }]);
      (prisma.integration.findFirst as Mock).mockResolvedValue(null);

      const job = mockJob('broadcast:send', { broadcastId: 'broadcast-1', organizationId: 'org-1' });
      await broadcastProcessor(job);

      expect(prisma.broadcastChat.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'failed',
            errorReason: expect.stringContaining('No connected integration'),
          }),
        }),
      );
    });

    it('should stop sending when daily limit is reached and mark remaining as pending', async () => {
      stubDefaultBroadcast();

      // Custom antiban with very low daily limit
      (prisma.antibanSettings.findUnique as Mock).mockResolvedValue({
        messagesPerBatch: 100,
        delayBetweenMessages: 0,
        delayBetweenBatches: 0,
        maxMessagesPerHour: 1000,
        maxMessagesPerDay: 2,
        autoRetryEnabled: true,
        maxRetryAttempts: 3,
        retryWindowHours: 6,
      });

      const chats = Array.from({ length: 5 }, (_, i) =>
        makeBroadcastChat({ id: `bc-limit-${i}`, messenger: 'telegram' }),
      );
      (prisma.broadcastChat.findMany as Mock)
        .mockResolvedValueOnce(chats)
        .mockResolvedValueOnce([
          { status: 'sent' },
          { status: 'sent' },
          { status: 'pending' },
          { status: 'pending' },
          { status: 'pending' },
        ]);

      const adapter = makeSuccessAdapter();
      (createAdapter as Mock).mockResolvedValue(adapter);

      const job = mockJob('broadcast:send', { broadcastId: 'broadcast-1', organizationId: 'org-1' });
      await broadcastProcessor(job);

      // Only 2 messages sent before daily limit
      expect(adapter.sendMessage).toHaveBeenCalledTimes(2);

      // Remaining 3 marked as pending
      expect(prisma.broadcastChat.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['bc-limit-2', 'bc-limit-3', 'bc-limit-4'] } },
          data: expect.objectContaining({
            status: 'pending',
            errorReason: expect.stringContaining('Daily limit'),
          }),
        }),
      );
    });

    it('should finalize as "sent" when all chats succeed', async () => {
      stubDefaultBroadcast();

      const chat1 = makeBroadcastChat({ messenger: 'telegram' });
      (prisma.broadcastChat.findMany as Mock)
        .mockResolvedValueOnce([chat1])
        .mockResolvedValueOnce([{ status: 'sent' }]);

      const adapter = makeSuccessAdapter();
      (createAdapter as Mock).mockResolvedValue(adapter);

      const job = mockJob('broadcast:send', { broadcastId: 'broadcast-1', organizationId: 'org-1' });
      await broadcastProcessor(job);

      const updateCalls = (prisma.broadcast.update as Mock).mock.calls;
      const finalizeCall = updateCalls.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (c: any[]) => c[0]?.data?.deliveryRate === 1,
      );
      expect(finalizeCall).toBeTruthy();
    });

    it('should finalize as "partially_failed" when some chats fail', async () => {
      stubDefaultBroadcast();

      const chat1 = makeBroadcastChat({ id: 'bc-ok', messenger: 'telegram', externalChatId: 'tg-ok' });
      const chat2 = makeBroadcastChat({ id: 'bc-bad', messenger: 'telegram', externalChatId: 'tg-bad' });
      (prisma.broadcastChat.findMany as Mock)
        .mockResolvedValueOnce([chat1, chat2])
        .mockResolvedValueOnce([{ status: 'sent' }, { status: 'failed' }]);

      const adapter = makeSuccessAdapter();
      (adapter.sendMessage as Mock)
        .mockResolvedValueOnce({ externalMessageId: 'ext-1' })
        .mockRejectedValueOnce(new Error('User blocked'));
      (createAdapter as Mock).mockResolvedValue(adapter);

      const job = mockJob('broadcast:send', { broadcastId: 'broadcast-1', organizationId: 'org-1' });
      await broadcastProcessor(job);

      const updateCalls = (prisma.broadcast.update as Mock).mock.calls;
      const finalizeCall = updateCalls.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (c: any[]) => c[0]?.data?.status === 'partially_failed',
      );
      expect(finalizeCall).toBeTruthy();
    });

    it('should use custom antiban settings when stored in the database', async () => {
      stubDefaultBroadcast();

      (prisma.antibanSettings.findUnique as Mock).mockResolvedValue({
        messagesPerBatch: 1,
        delayBetweenMessages: 0,
        delayBetweenBatches: 0,
        maxMessagesPerHour: 999,
        maxMessagesPerDay: 999,
        autoRetryEnabled: false,
        maxRetryAttempts: 5,
        retryWindowHours: 12,
      });

      const chats = Array.from({ length: 3 }, (_, i) =>
        makeBroadcastChat({ id: `bc-ab-${i}`, messenger: 'telegram' }),
      );
      (prisma.broadcastChat.findMany as Mock)
        .mockResolvedValueOnce(chats)
        .mockResolvedValueOnce(chats.map(() => ({ status: 'sent' })));

      const adapter = makeSuccessAdapter();
      (createAdapter as Mock).mockResolvedValue(adapter);

      const job = mockJob('broadcast:send', { broadcastId: 'broadcast-1', organizationId: 'org-1' });
      await broadcastProcessor(job);

      expect(adapter.sendMessage).toHaveBeenCalledTimes(3);
    });
  });

  // ──────────────────────────────────────────
  // processBroadcastRetry
  // ──────────────────────────────────────────

  describe('processBroadcastRetry', () => {
    it('should mark chats as retry_exhausted when retryCount >= maxRetryAttempts', async () => {
      stubDefaultBroadcast();

      const exhaustedChat = makeBroadcastChat({
        id: 'bc-exhausted',
        messenger: 'telegram',
        retryCount: 3, // equals default maxRetryAttempts
        status: 'retrying',
      });

      (prisma.broadcastChat.findMany as Mock)
        .mockResolvedValueOnce([exhaustedChat])
        .mockResolvedValueOnce([{ status: 'retry_exhausted' }]);

      const job = mockJob('broadcast:retry', { broadcastId: 'broadcast-1', organizationId: 'org-1' });
      await broadcastProcessor(job);

      expect(prisma.broadcastChat.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['bc-exhausted'] } },
          data: { status: 'retry_exhausted' },
        }),
      );
    });

    it('should retry chats with retryCount < maxRetryAttempts', async () => {
      stubDefaultBroadcast();

      const retriableChat = makeBroadcastChat({
        id: 'bc-retry-ok',
        messenger: 'telegram',
        retryCount: 1,
        status: 'retrying',
      });

      (prisma.broadcastChat.findMany as Mock)
        .mockResolvedValueOnce([retriableChat])
        .mockResolvedValueOnce([{ status: 'sent' }]);

      const adapter = makeSuccessAdapter();
      (createAdapter as Mock).mockResolvedValue(adapter);

      const job = mockJob('broadcast:retry', { broadcastId: 'broadcast-1', organizationId: 'org-1' });
      await broadcastProcessor(job);

      expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('should split chats into retriable and exhausted groups', async () => {
      stubDefaultBroadcast();

      const retriable = makeBroadcastChat({
        id: 'bc-r1',
        messenger: 'telegram',
        retryCount: 1,
        status: 'retrying',
      });
      const exhausted = makeBroadcastChat({
        id: 'bc-e1',
        messenger: 'telegram',
        retryCount: 3,
        status: 'retrying',
      });

      (prisma.broadcastChat.findMany as Mock)
        .mockResolvedValueOnce([retriable, exhausted])
        .mockResolvedValueOnce([{ status: 'sent' }, { status: 'retry_exhausted' }]);

      const adapter = makeSuccessAdapter();
      (createAdapter as Mock).mockResolvedValue(adapter);

      const job = mockJob('broadcast:retry', { broadcastId: 'broadcast-1', organizationId: 'org-1' });
      await broadcastProcessor(job);

      // exhausted should be marked
      expect(prisma.broadcastChat.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['bc-e1'] } },
          data: { status: 'retry_exhausted' },
        }),
      );
      // retriable should have been sent
      expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('should skip when broadcast not found on retry', async () => {
      (prisma.broadcast.findFirst as Mock).mockResolvedValue(null);

      const job = mockJob('broadcast:retry', { broadcastId: 'gone', organizationId: 'org-1' });
      await broadcastProcessor(job);

      expect(prisma.broadcastChat.findMany).not.toHaveBeenCalled();
    });

    it('should finalize without sending when no retrying chats remain', async () => {
      stubDefaultBroadcast();
      (prisma.broadcastChat.findMany as Mock)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ status: 'sent' }]);

      const job = mockJob('broadcast:retry', { broadcastId: 'broadcast-1', organizationId: 'org-1' });
      await broadcastProcessor(job);

      expect(createAdapter).not.toHaveBeenCalled();
    });

    it('should increment retryCount on failed retry attempt', async () => {
      stubDefaultBroadcast();

      const chat = makeBroadcastChat({
        id: 'bc-retry-fail',
        messenger: 'telegram',
        retryCount: 1,
        status: 'retrying',
      });
      (prisma.broadcastChat.findMany as Mock)
        .mockResolvedValueOnce([chat])
        .mockResolvedValueOnce([{ status: 'failed' }]);

      const adapter = makeFailingAdapter(new Error('Still failing'));
      (createAdapter as Mock).mockResolvedValue(adapter);

      const job = mockJob('broadcast:retry', { broadcastId: 'broadcast-1', organizationId: 'org-1' });
      await broadcastProcessor(job);

      expect(prisma.broadcastChat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'bc-retry-fail' },
          data: expect.objectContaining({
            status: 'failed',
            retryCount: 2, // 1 + 1 because isRetry=true
          }),
        }),
      );
    });

    it('should use custom maxRetryAttempts from stored antiban settings', async () => {
      stubDefaultBroadcast();

      // Custom maxRetryAttempts = 5
      (prisma.antibanSettings.findUnique as Mock).mockResolvedValue({
        messagesPerBatch: 10,
        delayBetweenMessages: 0,
        delayBetweenBatches: 0,
        maxMessagesPerHour: 100,
        maxMessagesPerDay: 1000,
        autoRetryEnabled: true,
        maxRetryAttempts: 5,
        retryWindowHours: 12,
      });

      // retryCount=4 is still < 5, so should be retriable
      const chat = makeBroadcastChat({
        id: 'bc-high-retry',
        messenger: 'telegram',
        retryCount: 4,
        status: 'retrying',
      });
      (prisma.broadcastChat.findMany as Mock)
        .mockResolvedValueOnce([chat])
        .mockResolvedValueOnce([{ status: 'sent' }]);

      const adapter = makeSuccessAdapter();
      (createAdapter as Mock).mockResolvedValue(adapter);

      const job = mockJob('broadcast:retry', { broadcastId: 'broadcast-1', organizationId: 'org-1' });
      await broadcastProcessor(job);

      // Should have sent, not marked as exhausted
      expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
      expect(prisma.broadcastChat.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: 'retry_exhausted' },
        }),
      );
    });
  });

  // ──────────────────────────────────────────
  // finalizeBroadcast (tested indirectly)
  // ──────────────────────────────────────────

  describe('finalizeBroadcast', () => {
    it('should set status "failed" when zero chats succeeded', async () => {
      stubDefaultBroadcast();
      (prisma.broadcastChat.findMany as Mock)
        .mockResolvedValueOnce([]) // pendingChats
        .mockResolvedValueOnce([{ status: 'failed' }, { status: 'retry_exhausted' }]);

      const job = mockJob('broadcast:send', { broadcastId: 'broadcast-1', organizationId: 'org-1' });
      await broadcastProcessor(job);

      const updateCalls = (prisma.broadcast.update as Mock).mock.calls;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const finalizeCall = updateCalls.find((c: any[]) => c[0]?.data?.status === 'failed');
      expect(finalizeCall).toBeTruthy();
    });

    it('should keep status "sending" when some chats are still pending', async () => {
      stubDefaultBroadcast();
      (prisma.broadcastChat.findMany as Mock)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ status: 'sent' }, { status: 'pending' }]);

      const job = mockJob('broadcast:send', { broadcastId: 'broadcast-1', organizationId: 'org-1' });
      await broadcastProcessor(job);

      const updateCalls = (prisma.broadcast.update as Mock).mock.calls;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const finalizeCall = updateCalls.find((c: any[]) => c[0]?.data?.status === 'sending');
      expect(finalizeCall).toBeTruthy();
    });

    it('should calculate correct deliveryRate (3/4 = 0.75)', async () => {
      stubDefaultBroadcast();
      (prisma.broadcastChat.findMany as Mock)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { status: 'sent' },
          { status: 'sent' },
          { status: 'sent' },
          { status: 'failed' },
        ]);

      const job = mockJob('broadcast:send', { broadcastId: 'broadcast-1', organizationId: 'org-1' });
      await broadcastProcessor(job);

      const updateCalls = (prisma.broadcast.update as Mock).mock.calls;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const finalizeCall = updateCalls.find((c: any[]) => c[0]?.data?.deliveryRate === 0.75);
      expect(finalizeCall).toBeTruthy();
    });
  });

  // ──────────────────────────────────────────
  // Edge cases
  // ──────────────────────────────────────────

  describe('edge cases', () => {
    it('should handle unknown job names gracefully without throwing', async () => {
      const job = mockJob('unknown:job', { broadcastId: 'x', organizationId: 'org-1' });
      await expect(broadcastProcessor(job)).resolves.toBeUndefined();
    });

    it('should use conservative defaults for unknown messenger types', async () => {
      stubDefaultBroadcast();

      const chat = makeBroadcastChat({ messenger: 'signal', externalChatId: 'sig-1' });
      (prisma.broadcastChat.findMany as Mock)
        .mockResolvedValueOnce([chat])
        .mockResolvedValueOnce([{ status: 'failed' }]);

      // No integration for 'signal'
      (prisma.integration.findFirst as Mock).mockResolvedValue(null);

      const job = mockJob('broadcast:send', { broadcastId: 'broadcast-1', organizationId: 'org-1' });
      await broadcastProcessor(job);

      expect(prisma.broadcastChat.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'failed' }),
        }),
      );
    });

    it('should not increment retryCount on first send (isRetry=false)', async () => {
      stubDefaultBroadcast();

      const chat = makeBroadcastChat({
        id: 'bc-first-fail',
        messenger: 'telegram',
        retryCount: 0,
      });
      (prisma.broadcastChat.findMany as Mock)
        .mockResolvedValueOnce([chat])
        .mockResolvedValueOnce([{ status: 'failed' }]);

      const adapter = makeFailingAdapter(new Error('Fail on first send'));
      (createAdapter as Mock).mockResolvedValue(adapter);

      const job = mockJob('broadcast:send', { broadcastId: 'broadcast-1', organizationId: 'org-1' });
      await broadcastProcessor(job);

      // retryCount should stay 0 because isRetry is false on first send
      expect(prisma.broadcastChat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'bc-first-fail' },
          data: expect.objectContaining({
            status: 'failed',
            retryCount: 0, // 0 + 0 because isRetry=false
          }),
        }),
      );
    });
  });
});
