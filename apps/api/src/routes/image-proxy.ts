// ─── Image Proxy Route ───
// Fetches remote images on behalf of the browser and streams them back.
// Used for Gmail email bodies to:
//   1. Hide the viewer's IP from tracking pixels
//   2. Avoid Mixed Content warnings (HTTPS-only responses)
//   3. Cache remote images in Redis for 30 days
//
// Security model:
//   - Every request MUST carry a valid HMAC signature (`sig` query param)
//     computed by the worker at email ingest time using JWT_SECRET.
//     This prevents the endpoint from being used as an open proxy — only
//     URLs that already live in a stored, sanitised email body are fetchable.
//     Browser <img> tags can't send Authorization headers, so signed URLs
//     replace per-user auth here.
//   - DNS is resolved and every returned address is checked against private /
//     loopback / link-local / ULA / multicast / reserved ranges (SSRF).
//   - Redirects are walked manually (max 3 hops), re-validating each target.
//   - Response size is enforced while streaming — no full-body buffering.
//   - Strict MIME allowlist, no SVG (XML-based → XSS surface).

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { cacheGet, cacheSet, cacheKey } from '../lib/cache.js';

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/pjpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
]);
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB
const CACHE_TTL = 60 * 60 * 24 * 30; // 30 days
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

interface CachedImage {
  mime: string;
  data: string; // base64
}

/**
 * Compute the canonical HMAC for an image URL.
 * Worker and API must use identical logic.
 */
function signImageUrl(rawUrl: string): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET not set');
  return createHmac('sha256', secret).update(`image-proxy:v1:${rawUrl}`).digest('hex');
}

function verifySignature(rawUrl: string, sig: string): boolean {
  const expected = signImageUrl(rawUrl);
  if (expected.length !== sig.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Check whether a resolved IP address falls in a range we must not
 * connect to: loopback, private, link-local, ULA, multicast, reserved.
 */
function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return true; // unrecognised = block

  if (family === 4) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts as [number, number, number, number];
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 192 && b === 0) return true; // 192.0.0/24 IETF, 192.0.2/24 docs
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a === 198 && b === 51) return true; // docs
    if (a === 203 && b === 0) return true; // docs
    if (a >= 224 && a <= 239) return true; // multicast
    if (a >= 240) return true; // reserved / broadcast
    return false;
  }

  // IPv6: normalise to lowercase without zone
  const v6 = ip.toLowerCase().split('%')[0] ?? '';
  if (v6 === '::' || v6 === '::1') return true;
  if (v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb')) return true; // fe80::/10 link-local
  if (v6.startsWith('fc') || v6.startsWith('fd')) return true; // fc00::/7 ULA
  if (v6.startsWith('ff')) return true; // multicast
  // IPv4-mapped ::ffff:a.b.c.d → re-check the embedded v4
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped && mapped[1]) return isBlockedIp(mapped[1]);
  return false;
}

/**
 * Resolve a hostname and reject if any returned address is blocked.
 * Also passes through literal IPs (no DNS needed, still validated).
 */
async function validateHost(hostname: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  // If hostname is a literal IP, validate directly.
  if (isIP(hostname) !== 0) {
    return isBlockedIp(hostname) ? { ok: false, reason: 'blocked IP literal' } : { ok: true };
  }

  // Reject obviously-local names before DNS to avoid waste.
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.internal') || lower.endsWith('.local')) {
    return { ok: false, reason: 'blocked hostname' };
  }

  try {
    const results = await dnsLookup(hostname, { all: true, verbatim: true });
    if (results.length === 0) return { ok: false, reason: 'no DNS records' };
    for (const r of results) {
      if (isBlockedIp(r.address)) {
        return { ok: false, reason: `blocked resolved IP ${r.address}` };
      }
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'DNS resolution failed' };
  }
}

/**
 * Fetch with manual redirect walking + per-hop host revalidation.
 * Returns the final Response (whose body has NOT yet been read).
 */
async function safeFetch(
  initialUrl: string,
  signal: AbortSignal,
  log: FastifyRequest['log'],
): Promise<{ ok: true; response: Response } | { ok: false; code: number; error: string }> {
  let currentUrl = initialUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch {
      return { ok: false, code: 400, error: 'invalid url' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, code: 400, error: 'only http/https allowed' };
    }
    const hostCheck = await validateHost(parsed.hostname);
    if (!hostCheck.ok) {
      log.warn({ url: currentUrl, reason: hostCheck.reason }, 'image-proxy host blocked');
      return { ok: false, code: 403, error: 'host not allowed' };
    }

    let res: Response;
    try {
      res = await fetch(currentUrl, {
        redirect: 'manual',
        signal,
        headers: {
          'User-Agent': 'Messengly-ImageProxy/1.0',
          Accept: 'image/png,image/jpeg,image/gif,image/webp,image/avif',
        },
      });
    } catch (err) {
      log.warn({ url: currentUrl, err: String(err) }, 'image-proxy fetch failed');
      return { ok: false, code: 502, error: 'upstream fetch failed' };
    }

    // Handle redirect hops
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      // Drain/discard body
      await res.body?.cancel().catch(() => {});
      if (!loc) return { ok: false, code: 502, error: 'redirect without location' };
      // Resolve relative Location
      try {
        currentUrl = new URL(loc, currentUrl).toString();
      } catch {
        return { ok: false, code: 502, error: 'invalid redirect target' };
      }
      continue;
    }

    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, code: 502, error: `upstream returned ${res.status}` };
    }
    return { ok: true, response: res };
  }
  return { ok: false, code: 508, error: 'too many redirects' };
}

/**
 * Stream the response body into a buffer, aborting if it exceeds MAX_SIZE.
 */
async function readBodyWithLimit(res: Response): Promise<{ ok: true; buf: Buffer } | { ok: false }> {
  // Cheap preflight: reject if upstream declares a too-large Content-Length.
  const contentLength = res.headers.get('content-length');
  if (contentLength) {
    const n = Number(contentLength);
    if (Number.isFinite(n) && n > MAX_SIZE) return { ok: false };
  }

  const reader = res.body?.getReader();
  if (!reader) return { ok: false };

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_SIZE) {
      await reader.cancel().catch(() => {});
      return { ok: false };
    }
    chunks.push(value);
  }
  return { ok: true, buf: Buffer.concat(chunks) };
}

export default async function imageProxyRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/image-proxy',
    {
      // Rate limit override: emails can embed dozens of images, so the
      // global 100/min ceiling is too tight. Since every request carries a
      // valid HMAC signature issued by the worker, open-proxy abuse is
      // already prevented — this limit only protects against fetch-amp DoS.
      config: {
        rateLimit: {
          max: 600,
          timeWindow: '1 minute',
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { url, sig } = request.query as { url?: string; sig?: string };

      if (!url || typeof url !== 'string') {
        return reply.code(400).send({ error: 'missing url parameter' });
      }
      if (!sig || typeof sig !== 'string' || !/^[0-9a-f]{64}$/.test(sig)) {
        return reply.code(400).send({ error: 'missing or malformed sig' });
      }
      if (!verifySignature(url, sig)) {
        return reply.code(403).send({ error: 'invalid signature' });
      }

      // Redis cache check
      const key = cacheKey('img-proxy', Buffer.from(url).toString('base64url'));
      const cached = await cacheGet<CachedImage>(key);
      if (cached) {
        return reply
          .header('Content-Type', cached.mime)
          .header('Cache-Control', 'public, max-age=2592000, immutable')
          .header('X-Content-Type-Options', 'nosniff')
          .header('Content-Security-Policy', "default-src 'none'")
          .header('X-Cache', 'HIT')
          .send(Buffer.from(cached.data, 'base64'));
      }

      // Fetch with SSRF protections + manual redirect walking
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const fetchResult = await safeFetch(url, controller.signal, request.log);
      if (!fetchResult.ok) {
        clearTimeout(timeout);
        return reply.code(fetchResult.code).send({ error: fetchResult.error });
      }
      const res = fetchResult.response;

      // Validate MIME BEFORE reading body
      const mime = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      if (!ALLOWED_MIME.has(mime)) {
        clearTimeout(timeout);
        await res.body?.cancel().catch(() => {});
        return reply.code(415).send({ error: 'unsupported media type' });
      }

      // Stream body with hard size cap
      const bodyResult = await readBodyWithLimit(res);
      clearTimeout(timeout);
      if (!bodyResult.ok) {
        return reply.code(413).send({ error: 'image too large or unreadable' });
      }
      const buf = bodyResult.buf;

      // Cache (best-effort; don't block response on Redis errors)
      cacheSet(key, { mime, data: buf.toString('base64') }, CACHE_TTL).catch((err) => {
        request.log.warn({ err: String(err) }, 'image-proxy cache set failed');
      });

      return reply
        .header('Content-Type', mime)
        .header('Cache-Control', 'public, max-age=2592000, immutable')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'")
        .header('X-Cache', 'MISS')
        .send(buf);
    },
  );
}
