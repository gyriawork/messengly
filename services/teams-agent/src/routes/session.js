/**
 * Session lifecycle: status, the streamed remote-browser login, export, destroy.
 *
 * The remote-login endpoints are a direct port of meetsbroadcast's
 * `routes/session.js`. The operator's browser polls `/remote/screenshot` and
 * posts clicks and keystrokes back; the human handles MFA.
 */

const express = require('express');
const fs = require('fs');
const logger = require('../util/logger');
const browser = require('../agent/browser');
const remote = require('../agent/remoteBrowser');
const status = require('../agent/status');

const router = express.Router();

/**
 * Errors raised by the remote browser carry a `code`. Anything a caller can fix
 * by sending a different request is a 4xx; everything else falls through to the
 * generic 500 handler.
 */
const ERROR_STATUS = {
  OUT_OF_BOUNDS: 400,
  INVALID_TEXT: 400,
  KEY_NOT_ALLOWED: 400,
  NO_REMOTE_SESSION: 409,
  REMOTE_ALREADY_ACTIVE: 409,
  NOT_ON_TEAMS: 409,
  CHAT_NOT_READY: 409,
};

/** Express error mapper: turn a coded agent error into a typed HTTP response. */
function handle(err, res, next) {
  const statusCode = ERROR_STATUS[err.code];
  if (!statusCode) return next(err);
  return res.status(statusCode).json({ error: { code: err.code, message: err.message } });
}

/** After any new session is persisted, drop that session's context so it reloads cookies. */
async function adoptNewSession(key) {
  status.invalidate(key);
  await browser.refreshSession(key);
}

/** `?session=<key>` on any of these routes, default 'default' — see agent/sessionPaths.js. */
function sessionKeyFrom(req) {
  const raw = req.query && typeof req.query.session === 'string' ? req.query.session.trim() : '';
  return raw || 'default';
}

// ─── Status ───────────────────────────────────────────────────────────────────

router.get('/status', async (req, res, next) => {
  try {
    res.json(await status.getStatus({ key: sessionKeyFrom(req) }));
  } catch (err) { next(err); }
});

router.post('/check', async (req, res, next) => {
  try {
    res.json(await status.getStatus({ force: true, key: sessionKeyFrom(req) }));
  } catch (err) { next(err); }
});

// ─── Remote browser login ─────────────────────────────────────────────────────
// The remote browser itself stays "one login at a time" globally — see
// remoteBrowser.js. Which Teams session a login will be SAVED into is fixed by
// the ?session= key passed at /remote/start; every later step in the flow
// (screenshot's auto-save, /remote/save) reads it back via
// remote.activeSessionKey() instead of trusting the poller's query string.

router.post('/remote/start', async (req, res, next) => {
  try {
    const { viewport } = await remote.start(sessionKeyFrom(req));
    res.json({ started: true, viewport });
  } catch (err) {
    if (/already active/i.test(err.message)) err.code = 'REMOTE_ALREADY_ACTIVE';
    handle(err, res, next);
  }
});

/**
 * Returns a JPEG frame. Also auto-saves the session the moment the operator is
 * genuinely logged in — `loggedIn` is surfaced via a response header so the
 * frontend can close the modal without a second request.
 */
router.get('/remote/screenshot', async (req, res, next) => {
  try {
    const buf = await remote.screenshot();
    const { loggedIn } = await remote.checkAndSaveSession();
    if (loggedIn) {
      const key = remote.activeSessionKey();
      await adoptNewSession(key);
      logger.info({ key }, 'Remote login detected and session adopted');
    }
    res.set('X-Logged-In', loggedIn ? 'true' : 'false');
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'no-store');
    res.send(buf);
  } catch (err) { handle(err, res, next); }
});

router.post('/remote/click', async (req, res, next) => {
  try {
    const { x, y } = req.body || {};
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'x and y must be numbers' } });
    }
    await remote.click(x, y);
    res.json({ ok: true });
  } catch (err) { handle(err, res, next); }
});

router.post('/remote/type', async (req, res, next) => {
  try {
    await remote.type((req.body || {}).text);
    res.json({ ok: true });
  } catch (err) { handle(err, res, next); }
});

router.post('/remote/key', async (req, res, next) => {
  try {
    await remote.pressKey((req.body || {}).key);
    res.json({ ok: true });
  } catch (err) { handle(err, res, next); }
});

router.post('/remote/save', async (req, res, next) => {
  try {
    const { url } = await remote.saveSession();
    await adoptNewSession(remote.activeSessionKey());
    res.json({ saved: true, url });
  } catch (err) { handle(err, res, next); }
});

router.post('/remote/stop', async (req, res, next) => {
  try {
    await remote.stop({ force: true });
    res.json({ stopped: true });
  } catch (err) { handle(err, res, next); }
});

// ─── Export / destroy ─────────────────────────────────────────────────────────

/**
 * Backup hatch. The session lives on this service's volume, which is not covered
 * by Messengly's database backups — and re-creating it costs a manual MFA login.
 */
router.get('/export', (req, res) => {
  if (!browser.hasSession()) {
    return res.status(404).json({ error: { code: 'NO_SESSION', message: 'No session has been saved yet' } });
  }
  res.set('Content-Type', 'application/json');
  res.set('Content-Disposition', 'attachment; filename="teams-session.json"');
  fs.createReadStream(browser.SESSION_PATH).pipe(res);
});

router.post('/destroy', async (req, res, next) => {
  try {
    const key = sessionKeyFrom(req);
    // A remote login in progress for THIS key would otherwise keep writing to
    // the file we're about to delete once the operator saves.
    if (remote.isActive() && remote.activeSessionKey() === key) {
      await remote.stop({ force: true });
    }
    await browser.destroySession(key);
    status.invalidate(key);
    res.json({ destroyed: true });
  } catch (err) { next(err); }
});

module.exports = router;
