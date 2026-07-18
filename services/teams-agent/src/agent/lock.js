/**
 * In-process mutex for Playwright operations, one per session key.
 *
 * There is one browser context per Teams session, so every operation on a
 * given session (scan, send) must serialize through that session's lock.
 * Every exported function defaults its key to 'default' — the legacy
 * single-session path — so the three existing single-argument call sites
 * (scanChats.js, status.js, routes/messages.js) keep compiling unchanged.
 *
 * Ported from meetsbroadcast with one change: the acquire timeout defaults to
 * 10 minutes instead of 60 seconds. Messengly's broadcast worker runs with
 * `concurrency: 3`, so two broadcasts that both target Teams chats will queue
 * here. A 60s timeout would fail the second one for no reason.
 */

const config = require('../config');
const logger = require('../util/logger');

/** @type {Map<string, { locked: boolean, queue: Array<() => void> }>} */
const locks = new Map();

function stateFor(key) {
  let state = locks.get(key);
  if (!state) {
    state = { locked: false, queue: [] };
    locks.set(key, state);
  }
  return state;
}

/**
 * @param {number} [timeoutMs]
 * @param {string} [key]
 * @returns {Promise<void>} resolves once the lock is held by the caller
 */
function acquire(timeoutMs = config.LOCK_TIMEOUT_MS, key = 'default') {
  const state = stateFor(key);
  return new Promise((resolve, reject) => {
    const entry = () => {
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      const idx = state.queue.indexOf(entry);
      if (idx !== -1) state.queue.splice(idx, 1);
      reject(new Error(`Lock acquisition timed out after ${timeoutMs}ms (key=${key}, queue depth ${state.queue.length})`));
    }, timeoutMs);

    if (!state.locked) {
      state.locked = true;
      clearTimeout(timer);
      resolve();
      return;
    }

    state.queue.push(entry);
    logger.debug({ key, queueDepth: state.queue.length }, 'agent lock: queued');
  });
}

function release(key = 'default') {
  const state = stateFor(key);
  const next = state.queue.shift();
  if (next) {
    next();
  } else {
    state.locked = false;
  }
}

function isLocked(key = 'default') {
  return stateFor(key).locked;
}

function queueDepth(key = 'default') {
  return stateFor(key).queue.length;
}

/** Run `fn` while holding the session's lock, releasing it even if `fn` throws. */
async function withLock(fn, timeoutMs, key = 'default') {
  await acquire(timeoutMs, key);
  try {
    return await fn();
  } finally {
    release(key);
  }
}

/** Aggregate view across every session that has ever taken this lock — for /health. */
function snapshot() {
  return [...locks.entries()].map(([key, state]) => ({
    key,
    locked: state.locked,
    queueDepth: state.queue.length,
  }));
}

module.exports = { acquire, release, isLocked, queueDepth, withLock, snapshot };
