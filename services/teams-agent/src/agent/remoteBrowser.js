/**
 * Remote browser session for interactive Teams login.
 *
 * Streams JPEG screenshots and accepts click/keyboard input from the frontend,
 * so a human can complete MFA, passwordless email codes, "stay signed in" and
 * the space picker with their own eyes and hands. There is no programmatic login
 * that survives all of those.
 *
 * Deliberately isolated from the browser.js singleton used for scan/send, so an
 * in-progress login never disturbs a running broadcast.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const logger = require('../util/logger');
const S = require('./selectors');
const { getProxyConfig } = require('./proxy');
const { disableWebAuthn } = require('./webauthn');
const { sessionPathFor } = require('./sessionPaths');

const VIEWPORT = { width: 1600, height: 900 };
const INACTIVITY_TIMEOUT = 10 * 60 * 1000; // 10 minutes (MFA flow can be slow)

const ALLOWED_KEYS = new Set([
  'Enter', 'Tab', 'Backspace', 'Escape', 'Delete', 'Home', 'End',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);

const LOGIN_CHECK_INTERVAL = 2000;          // check login state at most once per 2s
const MIN_SESSION_AGE_BEFORE_SAVE = 5000;   // don't try to save in the first 5s
const REQUIRED_CONSECUTIVE_CONFIRMATIONS = 2; // N consecutive detections before saving

let session = {
  active: false,
  stopping: false,
  browser: null,
  context: null,
  page: null,
  lastInteraction: null,
  timeoutTimer: null,
  startedAt: null,
  lastLoginCheck: 0,
  consecutiveLoggedIn: 0,
  /** Our own 'disconnected' handler, so cleanup() can remove exactly it. */
  onDisconnected: null,
  /** Which Teams session this login will be saved into (see sessionPaths.js). */
  sessionKey: 'default',
  /** The operator (Messengly user id) driving the current login. Used to keep
   *  a second operator from hijacking the shared browser (B2). */
  driver: null,
};

function touchActivity() {
  session.lastInteraction = Date.now();
  clearTimeout(session.timeoutTimer);
  session.timeoutTimer = setTimeout(() => {
    logger.warn('Remote browser: inactivity timeout, closing');
    stop();
  }, INACTIVITY_TIMEOUT);
}

async function start(sessionKey = 'default', driver = null) {
  // Self-heal / ownership check when a browser already exists (B2).
  if (session.active || session.stopping || session.browser) {
    const stillAlive = !!(session.browser && typeof session.browser.isConnected === 'function' && session.browser.isConnected());
    if (!stillAlive) {
      logger.warn('Remote browser: stale state detected, forcing cleanup before start');
      try { await cleanup(); } catch (e) { logger.warn({ err: e.message }, 'Stale cleanup failed'); }
    } else if (driver && session.driver && driver === session.driver) {
      // The SAME operator is reclaiming their own orphaned login — safe to
      // tear it down and restart for them.
      logger.info('Remote browser: same operator reclaiming their session');
      try { await cleanup(); } catch (e) { logger.warn({ err: e.message }, 'Reclaim cleanup failed'); }
    } else {
      // A DIFFERENT operator must not hijack the live browser (they'd see the
      // first operator's Microsoft login screen). Reject with a friendly code.
      const busy = new Error('Another Teams login is in progress. Please wait a moment and try again.');
      busy.code = 'REMOTE_LOGIN_BUSY';
      throw busy;
    }
  }

  session.stopping = false;
  session.active = true;
  session.startedAt = Date.now();
  session.lastLoginCheck = 0;
  session.consecutiveLoggedIn = 0;
  session.sessionKey = sessionKey;
  session.driver = driver;

  try {
    const proxy = getProxyConfig();
    if (proxy) logger.info({ server: proxy.server }, 'Remote browser: launching via proxy');
    session.browser = await chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled'],
      ...(proxy ? { proxy } : {}),
    });

    session.context = await session.browser.newContext({
      viewport: VIEWPORT,
      locale: 'ru-RU',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    });

    // Passkey/FIDO 2FA opens a NATIVE browser dialog that the screenshot
    // stream can't show or click. Hiding WebAuthn makes Microsoft offer the
    // in-page alternatives (password / authenticator / email code) instead.
    await disableWebAuthn(session.context);

    session.page = await session.context.newPage();

    session.onDisconnected = () => {
      logger.warn({ wasStopping: session.stopping }, 'Remote browser: disconnected (crash, OOM, or normal close)');
      resetState();
    };
    session.browser.on('disconnected', session.onDisconnected);

    logger.info('Remote browser: navigating to Teams');
    await session.page.goto(S.TEAMS_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    touchActivity();
    return { viewport: VIEWPORT };
  } catch (err) {
    logger.error(err, 'Remote browser: failed to start');
    await cleanup();
    throw err;
  }
}

async function screenshot() {
  assertActive();
  touchActivity();
  // Retry once on transient Playwright errors (mid-navigation, protocol glitches
  // on login.live.com redirect chains). Only a true browser crash re-throws.
  try {
    return await session.page.screenshot({ type: 'jpeg', quality: 65 });
  } catch (err) {
    const isTransient = /Protocol error|TargetClosedError|navigating|waiting for fonts/i.test(err.message);
    if (!isTransient) throw err;
    await new Promise((r) => setTimeout(r, 200));
    if (!session.active || !session.page || !session.browser?.isConnected?.()) {
      throw err;
    }
    logger.debug({ err: err.message }, 'Screenshot: transient error, retrying once');
    return session.page.screenshot({ type: 'jpeg', quality: 65 });
  }
}

/** Tag an error so the HTTP layer can map it to a status code. */
function coded(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function click(x, y) {
  assertActive();
  if (x < 0 || x > VIEWPORT.width || y < 0 || y > VIEWPORT.height) {
    throw coded(`Coordinates out of bounds (viewport is ${VIEWPORT.width}x${VIEWPORT.height})`, 'OUT_OF_BOUNDS');
  }
  await session.page.mouse.click(x, y);
  touchActivity();
}

async function type(text) {
  assertActive();
  if (!text || typeof text !== 'string' || text.length > 500) {
    throw coded('text must be a non-empty string of at most 500 characters', 'INVALID_TEXT');
  }
  await session.page.keyboard.type(text, { delay: 50 });
  touchActivity();
}

async function pressKey(key) {
  assertActive();
  if (!ALLOWED_KEYS.has(key)) {
    throw coded(`Key not allowed: ${key}`, 'KEY_NOT_ALLOWED');
  }
  await session.page.keyboard.press(key);
  touchActivity();
}

function persistStorageState(state) {
  const sessionPath = sessionPathFor(session.sessionKey);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  if (fs.existsSync(sessionPath)) {
    fs.copyFileSync(sessionPath, sessionPath + '.prev');
  }
  fs.writeFileSync(sessionPath, JSON.stringify(state, null, 2));
}

/**
 * Called on every screenshot poll. Auto-saves the session once the user is
 * genuinely logged in, behind three guards against false positives.
 */
async function checkAndSaveSession() {
  if (!session.active || !session.page) return { loggedIn: false };

  // Guard 1: don't check in the first 5 seconds — Teams hasn't even loaded
  const age = Date.now() - (session.startedAt || 0);
  if (age < MIN_SESSION_AGE_BEFORE_SAVE) return { loggedIn: false };

  // Guard 2: throttle — at most once every 2 seconds
  const now = Date.now();
  if (now - session.lastLoginCheck < LOGIN_CHECK_INTERVAL) return { loggedIn: false };
  session.lastLoginCheck = now;

  try {
    const url = session.page.url();

    // Strict URL check: on teams.live.com, not on a login/oauth/consent page
    const isOnTeams = /^https:\/\/teams\.live\.com\//.test(url);
    const isOnLogin = /login\.(microsoft|live)\.com/.test(url)
      || url.includes('/oauth')
      || url.includes('/consent')
      || url.includes('/signin');
    if (!isOnTeams || isOnLogin) {
      session.consecutiveLoggedIn = 0;
      return { loggedIn: false };
    }

    // The sidebar must be visible — Teams is loaded
    const sidebar = session.page.locator(S.sidebar).first();
    const visible = await sidebar.isVisible({ timeout: 1000 }).catch(() => false);
    if (!visible) {
      session.consecutiveLoggedIn = 0;
      return { loggedIn: false };
    }

    // The URL must be stable (not mid-redirect)
    const urlAfter = session.page.url();
    if (urlAfter !== url) {
      session.consecutiveLoggedIn = 0;
      return { loggedIn: false };
    }

    // Guard 3: require N consecutive confirmations before committing
    session.consecutiveLoggedIn += 1;
    logger.info({ url, consecutive: session.consecutiveLoggedIn, required: REQUIRED_CONSECUTIVE_CONFIRMATIONS },
      'Remote browser: logged-in state detected');
    if (session.consecutiveLoggedIn < REQUIRED_CONSECUTIVE_CONFIRMATIONS) {
      return { loggedIn: false };
    }

    persistStorageState(await session.context.storageState());
    logger.info({ url }, 'Remote browser: session saved (confirmed)');
    return { loggedIn: true };
  } catch (err) {
    logger.error(err, 'Remote browser: checkAndSaveSession failed');
    return { loggedIn: false };
  }
}

// Text Teams shows when the session booted but chat auth failed (half-booted /
// expired session). Presence of any of these = NOT ready to save.
const CHAT_UNAVAILABLE_RE =
  /Необходимо войти повторно|Чаты временно недоступны|chats are temporarily unavailable|sign in again|You need to sign in again/i;

/**
 * Readiness check run inside the live page. Deliberately selector-independent:
 * the only reliable negative signal is Teams' own "chats unavailable / sign in
 * again" banner, which appears exactly in the broken half-booted state and is
 * absent when the chat list is live. Also returns a data-tid inventory, which is
 * how you keep selectors.js current when Microsoft reworks the UI.
 */
async function inspectChatReadiness() {
  try {
    return await session.page.evaluate(() => {
      const bodyText = document.body.innerText || '';
      const tids = [...new Set(
        [...document.querySelectorAll('[data-tid]')].map((e) => e.getAttribute('data-tid'))
      )];
      const has = (sel) => !!document.querySelector(sel);
      return {
        bodyText: bodyText.replace(/\s+/g, ' ').slice(0, 200),
        tidCount: tids.length,
        tids,
        composer: has('[contenteditable="true"][role="textbox"], [data-tid*="ckeditor"], [data-tid*="messageBody"]'),
        chatListItems: document.querySelectorAll(
          '[data-tid="chat-list-item"], [role="tree"] [role="treeitem"], [role="listbox"] [role="option"]'
        ).length,
      };
    });
  } catch (e) {
    return { error: String(e), tidCount: -1, tids: [] };
  }
}

/**
 * Manual session save, triggered by the "Save session" button. Refuses to
 * persist a half-booted session, so we never store one that cannot read chats.
 */
async function saveSession() {
  assertActive();
  const url = session.page.url();
  const isOnTeams = /^https:\/\/teams\.live\.com\//.test(url);
  const isOnLogin = /login\.(microsoft|live)\.com/.test(url)
    || url.includes('/oauth')
    || url.includes('/consent')
    || url.includes('/signin')
    || url.includes('/gather'); // marketing page for signed-out users
  if (!isOnTeams || isOnLogin) {
    const err = new Error('The browser is not on Teams yet — finish logging in first');
    err.code = 'NOT_ON_TEAMS';
    throw err;
  }

  const readiness = await inspectChatReadiness();
  logger.info(
    { tidCount: readiness.tidCount, composer: readiness.composer, chatListItems: readiness.chatListItems },
    'Remote browser: DOM inventory at save time'
  );
  if (CHAT_UNAVAILABLE_RE.test(readiness.bodyText)) {
    throw coded('Signed in, but chats are not authorized yet. Wait until your chat list appears, then save.', 'CHAT_NOT_READY');
  }
  // Positive proof required. meetsbroadcast only checked for the "sign in again"
  // banner, but the signed-out marketing page at teams.live.com/v2/ shows no
  // banner and no chats — so an unauthenticated session would be happily saved,
  // leaving Messengly convinced the integration is connected while every send
  // fails. Demand that the chat list actually rendered.
  if (!readiness.chatListItems) {
    throw coded('No chat list on the page yet — wait until your chats appear, then save.', 'CHAT_NOT_READY');
  }

  persistStorageState(await session.context.storageState());
  logger.info({ url }, 'Remote browser: session saved manually (chat readiness verified)');
  return { url };
}

async function stop(opts = {}) {
  const { force = false } = opts;
  if (!force && (session.stopping || !session.active)) return;
  session.stopping = true;
  await cleanup();
}

async function cleanup() {
  clearTimeout(session.timeoutTimer);
  session.timeoutTimer = null;
  const b = session.browser;
  // Close the browser BEFORE resetState() — guarantee a full Chromium teardown
  // before clearing the flags, otherwise a parallel start() could launch a second
  // Chromium while the first is still dying in the background.
  if (b) {
    const t0 = Date.now();
    try {
      // Remove ONLY our handler. `removeAllListeners('disconnected')` would also
      // strip Playwright's own internal once-listener — the one that resolves the
      // promise `browser.close()` awaits. Chromium would still die, but close()
      // would hang forever and the HTTP request would never get a response.
      if (session.onDisconnected) b.off('disconnected', session.onDisconnected);
      await b.close();
      logger.info({ ms: Date.now() - t0 }, 'Remote browser: closed');
    } catch (err) {
      logger.warn({ err: err.message, ms: Date.now() - t0 }, 'Remote browser close failed');
    }
  }
  resetState();
}

function resetState() {
  session.active = false;
  session.stopping = false;
  session.browser = null;
  session.context = null;
  session.page = null;
  session.lastInteraction = null;
  session.startedAt = null;
  session.lastLoginCheck = 0;
  session.consecutiveLoggedIn = 0;
  session.onDisconnected = null;
  session.sessionKey = 'default';
  clearTimeout(session.timeoutTimer);
  session.timeoutTimer = null;
}

function isActive() {
  return session.active && !session.stopping;
}

/** Which session key the current (or most recent) remote login targets. */
function activeSessionKey() {
  return session.sessionKey;
}

function assertActive() {
  if (!session.active || session.stopping || !session.page) {
    throw coded('No active remote session — start one first', 'NO_REMOTE_SESSION');
  }
}

module.exports = {
  start, screenshot, click, type, pressKey,
  checkAndSaveSession, saveSession, stop, isActive, activeSessionKey, VIEWPORT,
};
