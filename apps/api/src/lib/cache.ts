import IORedis from 'ioredis';

const redis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379');

// Without a listener a Redis blip becomes an unhandled 'error' event and can
// take the whole process down.
redis.on('error', (err) => {
  console.error('[cache] Redis error:', err?.message ?? String(err));
});

/**
 * Every helper here is fail-open: the cache and the login counters are
 * optimizations/protections layered over Postgres, so a Redis outage must
 * degrade them (cache miss, no lockout) — never turn reads into 500s.
 */
async function failOpen<T>(fallback: T, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

/**
 * Get cached JSON value by key. Returns null on miss.
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  return failOpen(null as T | null, async () => {
    const raw = await redis.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  });
}

/**
 * Set cached JSON value with TTL in seconds.
 */
export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  await failOpen(undefined, async () => {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  });
}

/**
 * Invalidate all cache keys matching a pattern (e.g. "cache:orgId:chats:*").
 * Uses SCAN to avoid blocking Redis.
 */
export async function cacheInvalidate(pattern: string): Promise<void> {
  await failOpen(undefined, async () => {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== '0');
  });
}

/**
 * Build a cache key from parts.
 */
export function cacheKey(...parts: string[]): string {
  return `cache:${parts.join(':')}`;
}

// ─── Small counter/flag helpers (used for login brute-force protection) ───
// Fail-open too: during a Redis outage logins must still work; the lockout
// protection is temporarily degraded (the per-IP rate limit still applies).

/** Increment a counter, (re)setting its TTL each time. Returns the new value. */
export async function redisIncr(key: string, ttlSeconds: number): Promise<number> {
  return failOpen(0, async () => {
    const value = await redis.incr(key);
    await redis.expire(key, ttlSeconds);
    return value;
  });
}

/** Seconds left on a key's TTL, or -1 if it has no expiry / -2 if it is gone. */
export async function redisTtl(key: string): Promise<number> {
  return failOpen(-2, () => redis.ttl(key));
}

/** Set a flag key with a TTL (value is irrelevant; existence is the signal). */
export async function redisSetFlag(key: string, ttlSeconds: number): Promise<void> {
  await failOpen(undefined, async () => {
    await redis.set(key, '1', 'EX', ttlSeconds);
  });
}

/** True if the key exists. */
export async function redisExists(key: string): Promise<boolean> {
  return failOpen(false, async () => (await redis.exists(key)) === 1);
}

/** Delete one or more keys. */
export async function redisDel(...keys: string[]): Promise<void> {
  await failOpen(undefined, async () => {
    if (keys.length > 0) await redis.del(...keys);
  });
}
