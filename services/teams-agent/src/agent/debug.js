/**
 * Debug snapshot helper — captures a screenshot + metadata when a send step
 * fails. Files go under DATA_DIR/debug/<bucket>_<timestamp>/ so operators can
 * inspect what the browser looked like at the moment of failure.
 *
 * Best-effort only: never throws.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../util/logger');
const config = require('../config');

const DEBUG_DIR = path.join(config.DATA_DIR, 'debug');

try { fs.mkdirSync(DEBUG_DIR, { recursive: true }); } catch { /* ignore */ }

/**
 * @param {import('playwright').Page} page
 * @param {string|null} requestId — correlates with Messengly's broadcast logs
 * @param {string} chatLabel
 * @param {string} step — find_chat, paste_text, attach, send, verify_feed
 * @param {Error|null} error
 * @returns {Promise<string|null>} absolute directory path, or null on failure
 */
async function captureDebugSnapshot(page, requestId, chatLabel, step, error) {
  try {
    const bucket = requestId ? String(requestId).replace(/[^\w-]/g, '') : 'ad-hoc';
    const dir = path.join(DEBUG_DIR, `${bucket}_${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });

    const pngPath = path.join(dir, `${step}.png`);
    await page.screenshot({ path: pngPath, fullPage: false }).catch((err) => {
      logger.warn({ err: err.message }, 'debug: screenshot failed');
    });

    const url = await Promise.resolve(page.url()).catch(() => 'unknown');
    const meta = {
      requestId,
      chatLabel,
      step,
      error: error ? { name: error.name, message: error.message, stack: error.stack } : null,
      url,
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    logger.info({ dir, chatLabel, step, requestId }, 'debug snapshot captured');
    return dir;
  } catch (err) {
    logger.warn({ err: err.message }, 'debug snapshot itself failed');
    return null;
  }
}

module.exports = { captureDebugSnapshot, DEBUG_DIR };
