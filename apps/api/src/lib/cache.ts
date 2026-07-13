import IORedis from 'ioredis';

const redis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379');

/**
 * Get cached JSON value by key. Returns null on miss.
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const raw = await redis.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Set cached JSON value with TTL in seconds.
 */
export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
}

/**
 * Invalidate all cache keys matching a pattern (e.g. "cache:orgId:chats:*").
 * Uses SCAN to avoid blocking Redis.
 */
export async function cacheInvalidate(pattern: string): Promise<void> {
  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = nextCursor;
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } while (cursor !== '0');
}

/**
 * Build a cache key from parts.
 */
export function cacheKey(...parts: string[]): string {
  return `cache:${parts.join(':')}`;
}

// ─── Small counter/flag helpers (used for login brute-force protection) ───

/** Increment a counter, (re)setting its TTL each time. Returns the new value. */
export async function redisIncr(key: string, ttlSeconds: number): Promise<number> {
  const value = await redis.incr(key);
  await redis.expire(key, ttlSeconds);
  return value;
}

/** Seconds left on a key's TTL, or -1 if it has no expiry / -2 if it is gone. */
export async function redisTtl(key: string): Promise<number> {
  return redis.ttl(key);
}

/** Set a flag key with a TTL (value is irrelevant; existence is the signal). */
export async function redisSetFlag(key: string, ttlSeconds: number): Promise<void> {
  await redis.set(key, '1', 'EX', ttlSeconds);
}

/** True if the key exists. */
export async function redisExists(key: string): Promise<boolean> {
  return (await redis.exists(key)) === 1;
}

/** Delete one or more keys. */
export async function redisDel(...keys: string[]): Promise<void> {
  if (keys.length > 0) await redis.del(...keys);
}
