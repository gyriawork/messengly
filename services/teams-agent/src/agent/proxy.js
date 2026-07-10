/**
 * Outbound proxy for the Playwright browser.
 *
 * Microsoft blocks teams.live.com from datacenter IPs (Railway, most cloud
 * hosts). Routing the browser through a residential/ISP proxy makes Teams see
 * a normal IP. Configured via a single env var so nothing is hardcoded:
 *
 *   AGENT_PROXY_URL=http://user:pass@host:port       (HTTP/HTTPS proxy)
 *   AGENT_PROXY_URL=socks5://user:pass@host:port     (SOCKS5 proxy)
 *
 * Unset → no proxy (direct connection, e.g. when running locally).
 */

const logger = require('../util/logger');

/**
 * @returns {{ server: string, username?: string, password?: string } | undefined}
 *   Playwright launch `proxy` config, or undefined when no proxy is configured.
 */
function getProxyConfig() {
  const raw = (process.env.AGENT_PROXY_URL || '').trim();
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    const cfg = { server: `${u.protocol}//${u.host}` };
    if (u.username) cfg.username = decodeURIComponent(u.username);
    if (u.password) cfg.password = decodeURIComponent(u.password);
    return cfg;
  } catch (err) {
    logger.warn({ err: err.message }, 'Invalid AGENT_PROXY_URL — ignoring, connecting directly');
    return undefined;
  }
}

module.exports = { getProxyConfig };
