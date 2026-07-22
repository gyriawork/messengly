import type IORedis from 'ioredis';

// Per-account (integrationId) rate limiting shared across all workers/replicas.
// State lives in Redis, not worker-process memory, so quotas correctly span
// multiple broadcasts, retries, concurrent jobs, and worker restarts — the
// thing that actually gets banned is the account, so that is what we key on.

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const ZSET_TTL_MS = 90_000_000; // ~25h — older entries age out of the day window

// Sliding-window reservation over ONE sorted set per integration (the day
// window is a superset of the hour window, so one ZSET serves both). Reserve
// BEFORE the send so check+consume is atomic across every worker — no TOCTOU.
// A reserved slot whose send later fails is NOT refunded: over-counting is the
// SAFE direction (never under-throttles), and the slot ages out on its own.
const RESERVE_LUA = `
local now = tonumber(ARGV[1])
local hourMs = tonumber(ARGV[2])
local dayMs = tonumber(ARGV[3])
local maxHour = tonumber(ARGV[4])
local maxDay = tonumber(ARGV[5])
local member = ARGV[6]
local ttlMs = tonumber(ARGV[7])
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - dayMs)
local dayCount = redis.call('ZCARD', KEYS[1])
if dayCount >= maxDay then
  local o = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  local wait = 0
  if o[2] then wait = (tonumber(o[2]) + dayMs) - now end
  return {'day', wait}
end
local hourCount = redis.call('ZCOUNT', KEYS[1], now - hourMs, now)
if hourCount >= maxHour then
  local h = redis.call('ZRANGEBYSCORE', KEYS[1], now - hourMs, '+inf', 'WITHSCORES', 'LIMIT', 0, 1)
  local wait = 1000
  if h[2] then wait = (tonumber(h[2]) + hourMs) - now end
  return {'hour', wait}
end
redis.call('ZADD', KEYS[1], now, member)
redis.call('PEXPIRE', KEYS[1], ttlMs)
return {'ok', 0}
`;

export type ReserveStatus = 'ok' | 'hour' | 'day';
export interface ReserveResult { status: ReserveStatus; waitMs: number }

/** Reserve one send-slot for an account, or report how long to wait. */
export async function reserveSend(
  redis: IORedis,
  integrationId: string,
  limits: { maxHour: number; maxDay: number },
  member: string,
): Promise<ReserveResult> {
  try {
    const now = Date.now();
    const key = `antiban:sends:${integrationId}`;
    const res = (await redis.eval(
      RESERVE_LUA,
      1,
      key,
      String(now),
      String(HOUR_MS),
      String(DAY_MS),
      String(limits.maxHour),
      String(limits.maxDay),
      `${now}:${member}`, // unique member so ZADD never dedups and undercounts
      String(ZSET_TTL_MS),
    )) as [string, number];
    return { status: res[0] as ReserveStatus, waitMs: Number(res[1]) || 0 };
  } catch {
    // Fail open — never block a real send on a Redis hiccup (the per-run pacing
    // delays still apply). Matches the codebase's fail-open cache policy.
    return { status: 'ok', waitMs: 0 };
  }
}

// ─── Per-account lock: only one broadcast sends through an account at a time ──

function lockKey(integrationId: string): string {
  return `antiban:lock:${integrationId}`;
}

/** Try to take the account lock. Returns false if another run already holds it. */
export async function acquireAccountLock(
  redis: IORedis,
  integrationId: string,
  token: string,
  ttlMs = 600_000,
): Promise<boolean> {
  try {
    const r = await redis.set(lockKey(integrationId), token, 'PX', ttlMs, 'NX');
    return r === 'OK';
  } catch {
    return true; // fail open — don't strand a broadcast on a Redis hiccup
  }
}

const CAS_RENEW = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`;
const CAS_RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;

/** Extend our own lock (no-op if someone else holds it). */
export async function renewAccountLock(redis: IORedis, integrationId: string, token: string, ttlMs = 600_000): Promise<void> {
  try { await redis.eval(CAS_RENEW, 1, lockKey(integrationId), token, String(ttlMs)); } catch { /* ignore */ }
}

/** Release our own lock — never deletes another run's lock (compare-and-swap). */
export async function releaseAccountLock(redis: IORedis, integrationId: string, token: string): Promise<void> {
  try { await redis.eval(CAS_RELEASE, 1, lockKey(integrationId), token); } catch { /* ignore */ }
}
