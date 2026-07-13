import { Queue, type ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';

// Cast to BullMQ's ConnectionOptions: when npm installs a nested copy of
// ioredis under bullmq (different from the app's ioredis), the two `Redis`
// types stop matching even though the instance is runtime-compatible. The
// cast keeps the shared connection while satisfying the type checker on a
// non-deduped install (e.g. Railway's `npm i`).
const redisConnection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});
// Without a listener a Redis blip is an unhandled 'error' event → process crash.
redisConnection.on('error', (err) => {
  console.error('[queue] Redis error:', err?.message ?? String(err));
});
const connection = redisConnection as unknown as ConnectionOptions;

export const broadcastQueue = new Queue('broadcast', {
  connection,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});

export const messageSyncQueue = new Queue('message-sync', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 1000 },
  },
});
