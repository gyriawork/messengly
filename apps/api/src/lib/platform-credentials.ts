// ─── Platform Credentials Resolver ───
// Resolves the messenger-app credentials (API keys, OAuth client secrets)
// used to talk to a given messenger's platform API.
// Resolution order: org-level OrgMessengerConfig -> global PlatformConfig
// -> env vars -> null. The org row lets each organization run its own
// Telegram/Slack app (Task 4); existing orgs are backfilled from the global
// PlatformConfig at migration time (see 20260718000001_v22_foundations), so
// omitting organizationId keeps today's global-only resolution unchanged.
// Results cached in-memory with 60s TTL, keyed by messenger+org.

import prisma from './prisma.js';
import { decryptCredentials } from './crypto.js';
import { MESSENGER_ENV_VARS } from './platform-constants.js';
import type { Messenger } from './platform-constants.js';

interface CacheEntry {
  data: Record<string, string> | null;
  source: 'organization' | 'database' | 'env' | 'none_required' | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 60_000;

export interface PlatformCredentialsResult {
  credentials: Record<string, string> | null;
  source: 'organization' | 'database' | 'env' | 'none_required' | null;
}

/**
 * Resolve messenger-app credentials, optionally scoped to an organization.
 * 1. Check in-memory cache
 * 2. Org-level OrgMessengerConfig (if organizationId given) -> decrypt
 * 3. Global PlatformConfig -> decrypt
 * 4. Fallback to env vars
 * 5. Return null if not configured
 */
export async function getPlatformCredentials(
  messenger: string,
  organizationId?: string,
): Promise<PlatformCredentialsResult> {
  // WhatsApp needs no platform credentials
  const envMap = MESSENGER_ENV_VARS[messenger as Messenger] ?? {};
  if (messenger === 'whatsapp' || Object.keys(envMap).length === 0) {
    return { credentials: null, source: 'none_required' };
  }

  const cacheKey = organizationId ? `${messenger}:${organizationId}` : messenger;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { credentials: cached.data, source: cached.source };
  }

  if (organizationId) {
    const orgConfig = await prisma.orgMessengerConfig.findUnique({
      where: { organizationId_messenger: { organizationId, messenger } },
    });
    if (orgConfig && orgConfig.enabled) {
      const decrypted = decryptCredentials<Record<string, string>>(orgConfig.credentials as string);
      const entry: CacheEntry = { data: decrypted, source: 'organization', expiresAt: Date.now() + TTL_MS };
      cache.set(cacheKey, entry);
      return { credentials: decrypted, source: 'organization' };
    }
  }

  const config = await prisma.platformConfig.findUnique({
    where: { messenger },
  });

  if (config && config.enabled) {
    const decrypted = decryptCredentials<Record<string, string>>(config.credentials as string);
    const entry: CacheEntry = { data: decrypted, source: 'database', expiresAt: Date.now() + TTL_MS };
    cache.set(cacheKey, entry);
    return { credentials: decrypted, source: 'database' };
  }

  // Fallback to env vars
  const fromEnv: Record<string, string> = {};
  let allFound = true;
  for (const [field, envVar] of Object.entries(envMap)) {
    const val = process.env[envVar];
    if (val) {
      fromEnv[field] = val;
    } else {
      allFound = false;
    }
  }

  if (allFound) {
    const entry: CacheEntry = { data: fromEnv, source: 'env', expiresAt: Date.now() + TTL_MS };
    cache.set(cacheKey, entry);
    return { credentials: fromEnv, source: 'env' };
  }

  // Not configured
  const entry: CacheEntry = { data: null, source: null, expiresAt: Date.now() + TTL_MS };
  cache.set(cacheKey, entry);
  return { credentials: null, source: null };
}

/** Invalidate cache for a specific messenger (+ optional org) or everything. */
export function invalidatePlatformCache(messenger?: string, organizationId?: string): void {
  if (messenger && organizationId) {
    cache.delete(`${messenger}:${organizationId}`);
  } else if (messenger) {
    cache.delete(messenger);
    // Also drop any org-scoped entries for this messenger.
    for (const key of cache.keys()) {
      if (key.startsWith(`${messenger}:`)) cache.delete(key);
    }
  } else {
    cache.clear();
  }
}
