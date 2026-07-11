/**
 * Turns technical failure text into something a person can act on.
 * Server messages that are already short and human pass through untouched;
 * stack-trace-looking strings never reach the user.
 */

const RULES: Array<[RegExp, string]> = [
  [/session.{0,10}expired|SESSION_EXPIRED/i, 'The messenger session has expired. Reconnect it in Settings and try again.'],
  [/rate.?limit|too many requests|429/i, 'The messenger is rate-limiting us. Give it a minute and try again.'],
  [/failed to fetch|network|ECONNREFUSED|ETIMEDOUT|unreachable|socket hang up/i, 'Can’t reach the server. Check your connection and try again.'],
  [/timeout|timed out/i, 'That took too long. Try again.'],
  [/adapter connection failed/i, 'Couldn’t connect to the messenger. Check the integration in Settings.'],
  [/unauthorized|401/i, 'Your session ended. Sign in again.'],
];

const LOOKS_TECHNICAL = /[{}[\]\\]|Error:|TypeError|ReferenceError|\bat\s+\w+.*:\d+|prisma|ENO[A-Z]+/;

export function humanizeError(err: unknown, fallback = 'Something went wrong. Try again.'): string {
  const raw =
    err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  for (const [re, msg] of RULES) {
    if (re.test(raw)) return msg;
  }
  if (raw && raw.length <= 140 && !LOOKS_TECHNICAL.test(raw)) return raw;
  return fallback;
}
