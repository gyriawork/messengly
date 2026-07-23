/**
 * Playwright browser manager — multi-session.
 *
 * One shared Chromium process, one BrowserContext per Teams session
 * ("sessionKey"). Every function defaults its key to 'default' — the
 * legacy single-session path — so callers that never pass a key get
 * byte-identical behavior to the pre-multi-session agent.
 *
 * Live sessions are capped at MAX_LIVE_SESSIONS with LRU eviction: state is
 * saved to disk before a context is dropped, so an evicted session picks up
 * exactly where it left off the next time ensurePage() is called for it.
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const logger = require('../util/logger');
const config = require('../config');
const { getProxyConfig } = require('./proxy');
const { disableWebAuthn } = require('./webauthn');
const { sessionPathFor } = require('./sessionPaths');
const lock = require('./lock');

const MAX_LIVE_SESSIONS = parseInt(process.env.TEAMS_MAX_LIVE_SESSIONS || '3', 10);

let browser = null;
/** @type {Map<string, { context: import('playwright').BrowserContext, page: import('playwright').Page, lastUsedAt: number }>} */
const sessions = new Map();

// ── Idle-close bookkeeping ──
// Chromium was never torn down while idle: a single scan at 3am kept a full
// browser (+ Teams renderer) resident all day, and it slowly leaked. We now
// close it after IDLE_CLOSE_MS of inactivity and relaunch on the next request.
let lastActivityAt = Date.now();
let idleReaperTimer = null;
let idleClosing = false;
// Set while WE close the browser on purpose (idle-close / shutdown) so the
// 'disconnected' handler doesn't log it as an unexpected crash.
let intentionalClose = false;

/** Mark browser activity so the idle reaper doesn't close a browser in use. */
function touch() {
  lastActivityAt = Date.now();
}

function hasSession(key = 'default') {
  return fs.existsSync(sessionPathFor(key));
}

async function launchBrowser() {
  if (browser) return;

  logger.info('Launching Playwright browser...');
  const proxy = getProxyConfig();
  if (proxy) logger.info({ server: proxy.server }, 'Launching browser via proxy');
  browser = await chromium.launch({
    headless: process.env.HEADED !== 'true',
    args: [
      '--disable-blink-features=AutomationControlled',
      // Railway's default /dev/shm is only 64MB; without this a busy Teams
      // renderer can crash (and drop an in-flight send). Writes to /tmp instead.
      '--disable-dev-shm-usage',
      // Headless Teams needs no GPU — drops the GPU helper process (~30-60MB).
      '--disable-gpu',
    ],
    ...(proxy ? { proxy } : {}),
  });

  // Every live session's context dies with the browser process — clear them
  // all so the next ensurePage() call for any key relaunches from scratch.
  browser.on('disconnected', () => {
    if (intentionalClose) return; // idle-close / shutdown already handle state
    logger.warn('Browser disconnected unexpectedly — resetting state');
    browser = null;
    sessions.clear();
  });

  startIdleReaper();
  logger.info('Browser launched');
}

async function persistState(key, context) {
  const sessionPath = sessionPathFor(key);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });

  const prevPath = sessionPath + '.prev';
  if (fs.existsSync(sessionPath)) {
    fs.copyFileSync(sessionPath, prevPath);
  }

  const state = await context.storageState();
  fs.writeFileSync(sessionPath, JSON.stringify(state, null, 2));
  logger.info({ key }, 'Session saved');
}

/** Close one session's context/page. Saves its state first unless told not to. */
async function closeSession(key, opts = {}) {
  const { save = true } = opts;
  const entry = sessions.get(key);
  if (!entry) return;
  sessions.delete(key);
  if (save) {
    await persistState(key, entry.context).catch((err) =>
      logger.error({ key, err: err.message }, 'Failed to save session before closing'));
  }
  await entry.page?.close().catch(() => {});
  await entry.context?.close().catch(() => {});
}

/** Evict the least-recently-used session (other than `excludeKey`) to stay under the cap. */
async function evictLruIfNeeded(excludeKey) {
  if (sessions.size < MAX_LIVE_SESSIONS) return;

  let lruKey = null;
  let lruAt = Infinity;
  for (const [key, entry] of sessions) {
    if (key === excludeKey) continue;
    if (entry.lastUsedAt < lruAt) {
      lruAt = entry.lastUsedAt;
      lruKey = key;
    }
  }
  if (!lruKey) return;

  logger.info({ evicted: lruKey, maxLiveSessions: MAX_LIVE_SESSIONS }, 'Session cap reached — evicting least-recently-used session');
  await closeSession(lruKey, { save: true });
}

/** Launch on demand, then return that session's page. */
async function ensurePage(key = 'default') {
  touch();
  const existing = sessions.get(key);
  if (existing) {
    existing.lastUsedAt = Date.now();
    return existing.page;
  }

  await launchBrowser();
  await evictLruIfNeeded(key);

  const sessionPath = sessionPathFor(key);
  const sessionExists = fs.existsSync(sessionPath);
  if (!sessionExists) {
    logger.warn(`No session at ${sessionPath} (key=${key}) — log in through the remote browser first`);
  }

  const contextOpts = {
    locale: 'ru-RU',
    permissions: ['clipboard-read', 'clipboard-write'],
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  };
  if (sessionExists) contextOpts.storageState = sessionPath;

  const context = await browser.newContext(contextOpts);
  context.setDefaultTimeout(15_000);
  // Same WebAuthn hiding as the login browser — a mid-scan re-auth prompt
  // must fall back to in-page methods, never a native passkey dialog.
  await disableWebAuthn(context);

  const page = await context.newPage();
  page.setDefaultNavigationTimeout(60_000);

  sessions.set(key, { context, page, lastUsedAt: Date.now() });
  // Mark completion too: launching Chromium cold can take a few seconds, so
  // refresh the idle clock now that the page is actually ready to use.
  touch();
  logger.info({ key }, 'Session page ready');
  return page;
}

function getPage(key = 'default') {
  touch();
  const entry = sessions.get(key);
  if (!entry) {
    throw new Error(`Browser not launched for session "${key}" — call ensurePage() first`);
  }
  entry.lastUsedAt = Date.now();
  return entry.page;
}

function getContext(key = 'default') {
  touch();
  return sessions.get(key)?.context ?? null;
}

async function saveSession(key = 'default') {
  const entry = sessions.get(key);
  if (!entry) return;
  await persistState(key, entry.context);
}

/** Close everything — at process shutdown or on idle. Saves every live session first. */
async function close(opts = {}) {
  const { saveSession: doSave = true } = opts;
  const b = browser;
  if (!b) return;

  intentionalClose = true;
  try {
    for (const key of [...sessions.keys()]) {
      await closeSession(key, { save: doSave });
    }
    browser = null;
    await b.close().catch(() => {});
    logger.info({ saved: doSave }, 'Browser closed');
  } finally {
    intentionalClose = false;
  }
}

/**
 * Close the shared browser after a stretch of inactivity so its memory (which
 * also slowly leaks) isn't held 24/7 between broadcasts. State is persisted
 * first, so the next ensurePage() relaunches transparently from the saved
 * session file (~3-6s cold start). Never fires while any session lock is held
 * or queued, so it can't interrupt a scan or a send.
 */
async function reapIfIdle() {
  if (!browser || idleClosing) return;
  if (Date.now() - lastActivityAt < config.IDLE_CLOSE_MS) return;
  if (lock.snapshot().some((s) => s.locked || s.queueDepth > 0)) return;

  idleClosing = true;
  try {
    logger.info(
      { idleForMs: Date.now() - lastActivityAt, liveSessions: sessions.size },
      'Idle timeout reached — closing browser to free memory',
    );
    await close({ saveSession: true });
  } catch (err) {
    logger.error({ err: err.message }, 'Idle-close failed');
  } finally {
    idleClosing = false;
  }
}

/** Start the once-per-interval idle reaper (idempotent; unref'd so it never blocks exit). */
function startIdleReaper() {
  if (idleReaperTimer || config.IDLE_CLOSE_MS <= 0) return;
  idleReaperTimer = setInterval(() => { reapIfIdle().catch(() => {}); }, config.IDLE_CHECK_INTERVAL_MS);
  if (typeof idleReaperTimer.unref === 'function') idleReaperTimer.unref();
}

function stopIdleReaper() {
  if (idleReaperTimer) {
    clearInterval(idleReaperTimer);
    idleReaperTimer = null;
  }
}

/**
 * Drop one session's context (without touching its saved file) so the next
 * ensurePage(key) picks up freshly-saved cookies. Call this after a NEW
 * session is persisted for that key — otherwise a context launched earlier
 * (possibly logged-out) keeps being reused and every scan/send fails to find
 * the chat list.
 */
async function refreshSession(key = 'default') {
  if (!sessions.has(key)) return;
  logger.info({ key }, 'Dropping session context to reload the new session file');
  await closeSession(key, { save: false });
}

/** Delete one session's persisted file(s) and drop its context. */
async function destroySession(key = 'default') {
  await closeSession(key, { save: false });
  const sessionPath = sessionPathFor(key);
  for (const p of [sessionPath, sessionPath + '.prev']) {
    try { fs.existsSync(p) && fs.unlinkSync(p); } catch { /* ignore */ }
  }
  logger.info({ key }, 'Session destroyed');
}

/** Every session key with a live context right now — used to aggregate /health. */
function listLiveSessionKeys() {
  return [...sessions.keys()];
}

// Signal handling lives in src/index.js — it owns the shutdown order (stop
// accepting requests, then tear the browser down). Registering a second handler
// here would race it and exit before the server finished closing.

module.exports = {
  ensurePage, getPage, getContext,
  saveSession, close, refreshSession, destroySession,
  hasSession, listLiveSessionKeys,
  startIdleReaper, stopIdleReaper,
  SESSION_PATH: config.SESSION_PATH,
};
