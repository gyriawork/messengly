/**
 * Shared-secret auth. The agent is a private service reachable only by
 * Messengly's API and worker; it never faces a browser directly.
 */

const crypto = require('crypto');
const config = require('../config');

/** Constant-time compare so the key can't be guessed byte-by-byte via timing. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function requireApiKey(req, res, next) {
  if (!config.API_KEY) {
    // Guarded at boot: the process refuses to start without a key in production.
    return next();
  }
  const provided = req.get('X-Api-Key') || '';
  if (!provided || !safeEqual(provided, config.API_KEY)) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing X-Api-Key' } });
  }
  return next();
}

module.exports = { requireApiKey };
