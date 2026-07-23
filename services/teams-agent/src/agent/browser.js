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

const MAX_LIVE_SESSIONS = parseInt(process.env.TEAMS_MAX_LIVE_SESSIONS || '3', 10);

let browser = null;
/** @type {Map<string, { context: import('playwright').BrowserContext, page: import('playwright').Page, lastUsedAt: number }>} */
const sessions = new Map();

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
    args: ['--disable-blink-features=AutomationControlled'],
    ...(proxy ? { proxy } : {}),
  });

  // Every live session's context dies with the browser process — clear them
  // all so the next ensurePage() call for any key relaunches from scratch.
  browser.on('disconnected', () => {
    logger.warn('Browser disconnected unexpectedly — resetting state');
    browser = null;
    sessions.clear();
  });

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
  logger.info({ key }, 'Session page ready');
  return page;
}

function getPage(key = 'default') {
  const entry = sessions.get(key);
  if (!entry) {
    throw new Error(`Browser not launched for session "${key}" — call ensurePage() first`);
  }
  entry.lastUsedAt = Date.now();
  return entry.page;
}

function getContext(key = 'default') {
  return sessions.get(key)?.context ?? null;
}

async function saveSession(key = 'default') {
  const entry = sessions.get(key);
  if (!entry) return;
  await persistState(key, entry.context);
}

/** Close everything — used only at process shutdown. Saves every live session first. */
async function close(opts = {}) {
  const { saveSession: doSave = true } = opts;
  const b = browser;
  if (!b) return;

  for (const key of [...sessions.keys()]) {
    await closeSession(key, { save: doSave });
  }
  browser = null;
  await b.close().catch(() => {});
  logger.info({ saved: doSave }, 'Browser closed');
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
  SESSION_PATH: config.SESSION_PATH,
};
