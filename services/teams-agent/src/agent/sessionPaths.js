/**
 * Resolves a session key to its storageState file path.
 *
 * 'default' keeps the original single-session path — the one Teams login that
 * already exists on this service's volume needs zero migration. Every other
 * key (a per-user personal connection, see browser.js) gets its own file
 * under DATA_DIR/state/sessions/.
 */

const path = require('path');
const config = require('../config');

function sessionPathFor(key = 'default') {
  if (key === 'default') return config.SESSION_PATH;
  return path.join(config.STATE_DIR, 'sessions', `${key}.json`);
}

module.exports = { sessionPathFor };
