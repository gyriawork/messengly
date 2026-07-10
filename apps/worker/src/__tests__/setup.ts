import { vi } from 'vitest';

// ─── Stub environment variables before any module loads ───
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.CREDENTIALS_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.NODE_ENV = 'test';

// ─── Mock ioredis ───
vi.mock('ioredis', () => {
  const MockRedis = vi.fn().mockImplementation(() => ({
    publish: vi.fn().mockResolvedValue(1),
    subscribe: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue('OK'),
    disconnect: vi.fn(),
    status: 'ready',
  }));
  return { default: MockRedis };
});

// ─── Mock BullMQ ───
vi.mock('bullmq', () => {
  const MockWorker = vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  }));

  const MockQueue = vi.fn().mockImplementation(() => ({
    add: vi.fn().mockResolvedValue({ id: 'mock-job-id' }),
    close: vi.fn().mockResolvedValue(undefined),
  }));

  return { Worker: MockWorker, Queue: MockQueue };
});

// ─── Mock prisma ───
vi.mock('../lib/prisma.js', () => {
  return {
    default: {
      broadcast: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
        update: vi.fn(),
      },
      broadcastChat: {
        findMany: vi.fn(),
        update: vi.fn(),
        // The startup sweep reads .count at module import — must resolve.
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      integration: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
      },
      antibanSettings: {
        findUnique: vi.fn(),
      },
      chat: {
        findUnique: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
        update: vi.fn(),
      },
      message: {
        findMany: vi.fn(),
        createMany: vi.fn(),
        count: vi.fn(),
        findFirst: vi.fn(),
      },
      $disconnect: vi.fn(),
    },
  };
});

// ─── Mock crypto ───
vi.mock('../lib/crypto.js', () => ({
  decrypt: vi.fn().mockReturnValue('{}'),
  decryptCredentials: vi.fn().mockReturnValue({ apiId: 123, apiHash: 'abc' }),
}));

// ─── Mock adapter factory ───
vi.mock('../integrations/factory.js', () => ({
  createAdapter: vi.fn(),
}));

// Silence console output during tests
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});
