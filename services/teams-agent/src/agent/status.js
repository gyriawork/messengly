/**
 * Session status, cached per session key.
 *
 * `active`  — the browser reached the Teams chat list
 * `expired` — Teams redirected us to a login page
 * `unknown` — no session file has ever been saved
 *
 * A real check drives a browser navigation, which costs seconds, so callers get
 * a cached verdict unless they force a re-check. Every exported function
 * defaults its key to 'default', so the legacy single-session call sites are
 * unaffected.
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

/** @type {Map<string, { status: 'active'|'expired'|'unknown', lastCheckAt: string|null }>} */
const cache = new Map();

function cachedFor(key) {
  return cache.get(key) ?? { status: 'unknown', lastCheckAt: null };
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.force] — bypass the cache and drive a real navigation
 * @param {string} [opts.key]
 * @returns {Promise<{ status: 'active'|'expired'|'unknown', lastCheckAt: string|null }>}
 */
async function getStatus({ force = false, key = 'default' } = {}) {
  if (!browser.hasSession(key)) {
    const unknown = { status: 'unknown', lastCheckAt: new Date().toISOString() };
    cache.set(key, unknown);
    return unknown;
  }

  const cached = cachedFor(key);
  const fresh = cached.lastCheckAt && Date.now() - Date.parse(cached.lastCheckAt) < CACHE_TTL_MS;
  if (!force && fresh && cached.status !== 'unknown') return cached;

  let result;
  try {
    const ready = await lock.withLock(async () => {
      const page = await browser.ensurePage(key);
      await checkSession(page);
      if (await chatListRendered(page)) return true;

      // The page can be stuck after an interrupted load: checkSession skips
      // navigation when the URL already points at Teams, so a half-loaded
      // page would stay "expired" forever. Force ONE hard reload before
      // declaring the session dead.
      logger.info({ key }, 'Chat list not rendered — forcing a reload before the verdict');
      await page.goto(S.TEAMS_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
      const url = page.url();
      if (url.includes('login.microsoftonline.com') || url.includes('login.live.com')) return false;
      // waitFor actually waits (isVisible returns immediately) — give the
      // freshly reloaded app time to boot its chat list.
      return page
        .locator(S.sidebar)
        .first()
        .waitFor({ state: 'visible', timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
    }, undefined, key);
    result = {
      status: ready ? 'active' : 'expired',
      lastCheckAt: new Date().toISOString(),
    };
    if (!ready) logger.warn({ key }, 'Teams loaded but the chat list never rendered — treating session as expired');
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      result = { status: 'expired', lastCheckAt: new Date().toISOString() };
    } else {
      logger.error({ key, err: err.message }, 'Session status check failed');
      throw err;
    }
  }

  cache.set(key, result);
  return result;
}

/** Called after a new session is saved, so the next read re-checks. */
function invalidate(key = 'default') {
  cache.set(key, { status: 'unknown', lastCheckAt: null });
}

module.exports = { getStatus, invalidate };
