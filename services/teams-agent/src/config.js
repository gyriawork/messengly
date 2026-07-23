/**
 * Environment configuration for the Teams agent.
 *
 * The agent is a private service: Messengly's API and worker talk to it over
 * HTTP with a shared API key. It is never exposed to browsers directly.
 */

const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../data');

module.exports = {
  PORT: parseInt(process.env.PORT || '3004', 10),
  HOST: process.env.HOST || '0.0.0.0',

  DATA_DIR,
  STATE_DIR: path.join(DATA_DIR, 'state'),
  SESSION_PATH: process.env.SESSION_PATH || path.join(DATA_DIR, 'state', 'session.json'),

  /** Shared secret. When unset the agent refuses to start outside development. */
  API_KEY: process.env.TEAMS_AGENT_API_KEY || '',

  /**
   * Random delay applied before each send, on top of Messengly's own anti-ban
   * pacing. Messengly has no randomization, and randomization is what actually
   * defeats rate-limit heuristics. Applied BEFORE acquiring the browser mutex so
   * a sleeping request never blocks another broadcast.
   */
  SEND_JITTER_MIN_MS: parseInt(process.env.TEAMS_SEND_JITTER_MIN_MS || '3000', 10),
  SEND_JITTER_MAX_MS: parseInt(process.env.TEAMS_SEND_JITTER_MAX_MS || '10000', 10),

  /** Max time a request will wait for the single browser. Broadcasts queue here. */
  LOCK_TIMEOUT_MS: parseInt(process.env.TEAMS_LOCK_TIMEOUT_MS || '600000', 10),

  /**
   * Idle-close: after this long with no scan/send/status activity, the shared
   * Chromium (and every live Teams context) is closed to free memory; the next
   * request relaunches it transparently from the saved session file. Set to 0 to
   * disable. This is the main guard against the browser sitting resident — and
   * slowly leaking — 24/7 between broadcasts. The reaper only fires when no
   * session lock is held or queued, so it never interrupts an in-flight send.
   */
  IDLE_CLOSE_MS: parseInt(process.env.TEAMS_IDLE_CLOSE_MS || '600000', 10),
  IDLE_CHECK_INTERVAL_MS: parseInt(process.env.TEAMS_IDLE_CHECK_INTERVAL_MS || '60000', 10),

  /** Cap on downloaded attachment size (bytes). */
  MAX_ATTACHMENT_BYTES: parseInt(process.env.TEAMS_MAX_ATTACHMENT_BYTES || String(30 * 1024 * 1024), 10),
};
