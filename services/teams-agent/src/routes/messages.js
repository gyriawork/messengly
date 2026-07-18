/**
 * Message sending.
 *
 * One endpoint, one message. Messengly's worker owns broadcast pacing, batching
 * and retry policy; this service only knows how to put one message into one chat
 * and tell the truth about whether it arrived.
 */

const express = require('express');
const logger = require('../util/logger');
const config = require('../config');
const browser = require('../agent/browser');
const lock = require('../agent/lock');
const attachments = require('../agent/attachments');
const status = require('../agent/status');
const { SessionExpiredError } = require('../agent/checkSession');
const { sendMessage, ChatNotFoundError, AttachmentError } = require('../agent/sendMessage');
const { normalizeEmojiInHtml, normalizeEmojiInText } = require('../util/normalizeEmoji');

const router = express.Router();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Random pause before every send, on top of Messengly's own anti-ban delays.
 * Messengly paces deterministically; randomization is what actually defeats
 * rate-limit heuristics.
 *
 * Applied BEFORE the browser mutex is taken, so a sleeping request never blocks
 * another broadcast from using the browser.
 */
async function jitter() {
  const { SEND_JITTER_MIN_MS: min, SEND_JITTER_MAX_MS: max } = config;
  if (max <= 0) return;
  const ms = min + Math.floor(Math.random() * Math.max(1, max - min));
  logger.debug({ ms }, 'send jitter');
  await sleep(ms);
}

/**
 * POST /messages
 * Body: { threadId, html?, text, attachments?: [{url, filename, mimeType}], requestId?, sessionKey? }
 */
router.post('/', async (req, res, next) => {
  const { threadId, html, text, attachments: files = [], requestId = null, sessionKey = 'default' } = req.body || {};

  if (!threadId || typeof threadId !== 'string') {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'threadId is required' } });
  }
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'text is required' } });
  }

  // Teams renders Unicode emoji natively but turns :shortcode: images into huge
  // attachment cards, so normalize before the HTML ever reaches the compose box.
  const plain = normalizeEmojiInText(text);
  const richHtml = normalizeEmojiInHtml(html || escapeHtml(text));

  let staged = [];
  try {
    staged = await attachments.stageAll(files);
  } catch (err) {
    return res.status(422).json({ error: { code: 'ATTACHMENT_DOWNLOAD_FAILED', message: err.message } });
  }

  try {
    await jitter();

    const result = await lock.withLock(async () => {
      await browser.ensurePage(sessionKey);
      return sendMessage({ threadId, html: richHtml, plain, attachments: staged, requestId, sessionKey });
    }, undefined, sessionKey);

    if (result.success) {
      return res.json({ ok: true, messageId: `teams:${threadId}:${Date.now()}` });
    }

    // The message may or may not have gone out. `retriable` distinguishes the two,
    // and Messengly must not retry when it is false — that would duplicate.
    return res.json({ ok: false, reason: result.error, retriable: result.retriable !== false });
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      status.invalidate();
      return res.status(409).json({ error: { code: 'SESSION_EXPIRED', message: err.message } });
    }
    if (err instanceof ChatNotFoundError) {
      return res.status(404).json({ error: { code: 'CHAT_NOT_FOUND', message: err.message } });
    }
    if (err instanceof AttachmentError) {
      return res.status(422).json({ error: { code: 'ATTACHMENT_UNSUPPORTED', message: err.message, fileName: err.fileName } });
    }
    return next(err);
  } finally {
    await attachments.cleanup(staged);
  }
});

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

module.exports = router;
