/**
 * Singleton Playwright browser manager.
 * Launches Chromium with the session from session.json and provides a single
 * reusable page for all operations (scan, send).
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const logger = require('../util/logger');
const config = require('../config');
const { getProxyConfig } = require('./proxy');

const SESSION_PATH = config.SESSION_PATH;

let browser = null;
let context = null;
let page = null;

function hasSession() {
  return fs.existsSync(SESSION_PATH);
}

async function launch() {
  if (browser) return;

  logger.info('Launching Playwright browser...');

  const sessionExists = hasSession();
  if (!sessionExists) {
    logger.warn(`No session at ${SESSION_PATH} — log in through the remote browser first`);
  }

  const proxy = getProxyConfig();
  if (proxy) logger.info({ server: proxy.server }, 'Launching browser via proxy');
  browser = await chromium.launch({
    headless: process.env.HEADED !== 'true',
    args: ['--disable-blink-features=AutomationControlled'],
    ...(proxy ? { proxy } : {}),
  });

  const contextOpts = {
    locale: 'ru-RU',
    permissions: ['clipboard-read', 'clipboard-write'],
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  };

  if (sessionExists) {
    contextOpts.storageState = SESSION_PATH;
  }

  context = await browser.newContext(contextOpts);
  context.setDefaultTimeout(15_000);

  page = await context.newPage();
  page.setDefaultNavigationTimeout(60_000);

  // Auto-reset on unexpected browser disconnect
  browser.on('disconnected', () => {
    logger.warn('Browser disconnected unexpectedly — resetting state');
    browser = null;
    context = null;
    page = null;
  });

  logger.info('Browser launched, page ready');
}

/** Launch on demand, then return the shared page. */
async function ensurePage() {
  if (!page) await launch();
  return page;
}

function getPage() {
  if (!page) {
    throw new Error('Browser not launched — call launch() first');
  }
  return page;
}

function getContext() {
  return context;
}

async function saveSession() {
  if (!context) return;

  fs.mkdirSync(path.dirname(SESSION_PATH), { recursive: true });

  const prevPath = SESSION_PATH + '.prev';
  if (fs.existsSync(SESSION_PATH)) {
    fs.copyFileSync(SESSION_PATH, prevPath);
  }

  const state = await context.storageState();
  fs.writeFileSync(SESSION_PATH, JSON.stringify(state, null, 2));
  logger.info('Session saved');
}

async function close(opts = {}) {
  const { saveSession: doSave = true } = opts;
  const b = browser;
  if (b) {
    // Save session BEFORE clearing module-level vars (saveSession() reads `context`)
    if (doSave) {
      await saveSession().catch((err) => logger.error(err, 'Failed to save session on close'));
    }
    browser = null;
    context = null;
    page = null;
    await b.close().catch(() => {});
    logger.info({ saved: doSave }, 'Browser closed');
  }
}

/**
 * Drop the singleton browser (without overwriting the session file) so the next
 * launch() picks up freshly-saved cookies. Call this after a NEW Teams session
 * is persisted — otherwise a browser launched earlier (possibly logged-out)
 * keeps being reused and every scan/broadcast fails to find the chat list.
 */
async function refreshSession() {
  if (!browser) return;
  logger.info('Dropping singleton browser to reload the new session');
  await close({ saveSession: false });
}

/** Delete the persisted session and drop the browser. */
async function destroySession() {
  await close({ saveSession: false });
  for (const p of [SESSION_PATH, SESSION_PATH + '.prev']) {
    try { fs.existsSync(p) && fs.unlinkSync(p); } catch { /* ignore */ }
  }
  logger.info('Session destroyed');
}

// Signal handling lives in src/index.js — it owns the shutdown order (stop
// accepting requests, then tear the browser down). Registering a second handler
// here would race it and exit before the server finished closing.

module.exports = {
  launch, ensurePage, getPage, getContext,
  saveSession, close, refreshSession, destroySession,
  hasSession, SESSION_PATH,
};
