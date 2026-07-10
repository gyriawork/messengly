/**
 * Session status, cached.
 *
 * `active`  — the browser reached the Teams chat list
 * `expired` — Teams redirected us to a login page
 * `unknown` — no session file has ever been saved
 *
 * A real check drives a browser navigation, which costs seconds, so callers get
 * a cached verdict unless they force a re-check.
 */

const logger = require('../util/logger');
const S = require('./selectors');
const browser = require('./browser');
const lock = require('./lock');
const { checkSession, SessionExpiredError } = require('./checkSession');

const CACHE_TTL_MS = 60_000;

/**
 * `checkSession` is lenient: when Teams loads but the sidebar never renders it
 * only warns, because scan/send will fail loudly a moment later anyway. That is
 * not good enough here — Messengly's adapter treats `active` as "connected", so
 * a half-booted or signed-out session must report `expired` instead.
 */
async function chatListRendered(page) {
  return page.locator(S.sidebar).first().isVisible({ timeout: 5_000 }).catch(() => false);
}

let cached = { status: 'unknown', lastCheckAt: null };

/**
 * @param {boolean} force — bypass the cache and drive a real navigation
 * @returns {Promise<{ status: 'active'|'expired'|'unknown', lastCheckAt: string|null }>}
 */
async function getStatus({ force = false } = {}) {
  if (!browser.hasSession()) {
    cached = { status: 'unknown', lastCheckAt: new Date().toISOString() };
    return cached;
  }

  const fresh = cached.lastCheckAt && Date.now() - Date.parse(cached.lastCheckAt) < CACHE_TTL_MS;
  if (!force && fresh && cached.status !== 'unknown') return cached;

  try {
    const ready = await lock.withLock(async () => {
      const page = await browser.ensurePage();
      await checkSession(page);
      return chatListRendered(page);
    });
    cached = {
      status: ready ? 'active' : 'expired',
      lastCheckAt: new Date().toISOString(),
    };
    if (!ready) logger.warn('Teams loaded but the chat list never rendered — treating session as expired');
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      cached = { status: 'expired', lastCheckAt: new Date().toISOString() };
    } else {
      logger.error({ err: err.message }, 'Session status check failed');
      throw err;
    }
  }

  return cached;
}

/** Called after a new session is saved, so the next read re-checks. */
function invalidate() {
  cached = { status: 'unknown', lastCheckAt: null };
}

module.exports = { getStatus, invalidate };
