/**
 * In-process mutex for Playwright operations.
 *
 * There is exactly one browser and one page, so every agent operation (scan,
 * send) must serialize through this lock.
 *
 * Ported from meetsbroadcast with one change: the acquire timeout defaults to
 * 10 minutes instead of 60 seconds. Messengly's broadcast worker runs with
 * `concurrency: 3`, so two broadcasts that both target Teams chats will queue
 * here. A 60s timeout would fail the second one for no reason.
 */

const config = require('../config');
const logger = require('../util/logger');

let locked = false;
const queue = [];

/**
 * @param {number} [timeoutMs]
 * @returns {Promise<void>} resolves once the lock is held by the caller
 */
function acquire(timeoutMs = config.LOCK_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const entry = () => {
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      const idx = queue.indexOf(entry);
      if (idx !== -1) queue.splice(idx, 1);
      reject(new Error(`Lock acquisition timed out after ${timeoutMs}ms (queue depth ${queue.length})`));
    }, timeoutMs);

    if (!locked) {
      locked = true;
      clearTimeout(timer);
      resolve();
      return;
    }

    queue.push(entry);
    logger.debug({ queueDepth: queue.length }, 'agent lock: queued');
  });
}

function release() {
  const next = queue.shift();
  if (next) {
    next();
  } else {
    locked = false;
  }
}

function isLocked() {
  return locked;
}

function queueDepth() {
  return queue.length;
}

/** Run `fn` while holding the lock, releasing it even if `fn` throws. */
async function withLock(fn, timeoutMs) {
  await acquire(timeoutMs);
  try {
    return await fn();
  } finally {
    release();
  }
}

module.exports = { acquire, release, isLocked, queueDepth, withLock };
