/**
 * Session validation — detects if the Teams session has expired.
 * After page.goto(), checks if we were redirected to a Microsoft login page.
 */

const logger = require('../util/logger');
const S = require('./selectors');

class SessionExpiredError extends Error {
  constructor(message = 'Teams session expired — re-login required') {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

/**
 * Navigate to Teams and verify the session is valid.
 * Handles the space picker if it appears.
 * Throws SessionExpiredError if redirected to login.
 */
async function checkSession(page) {
  const url = page.url();

  // If already on Teams, just verify we're not on a login page
  if (url.includes('teams.live.com')) {
    return true;
  }

  await page.goto(S.TEAMS_URL, { waitUntil: 'domcontentloaded' });

  const currentUrl = page.url();
  if (currentUrl.includes('login.microsoftonline.com') || currentUrl.includes('login.live.com')) {
    logger.error('Session expired — redirected to login page');
    throw new SessionExpiredError();
  }

  // Handle the space picker (personal accounts show "Личное" / org picker)
  try {
    const picker = page.locator(S.spacePicker).first();
    await picker.waitFor({ state: 'visible', timeout: 5_000 });
    logger.info('Space picker found — clicking "Личное"');
    await picker.click();
    await page.waitForTimeout(3000);
  } catch {
    // No space picker — already past it
  }

  // Wait for the sidebar to confirm we're logged in
  try {
    await page.locator(S.sidebar).first().waitFor({ state: 'visible', timeout: 30_000 });
  } catch {
    const afterUrl = page.url();
    if (afterUrl.includes('login.microsoftonline.com') || afterUrl.includes('login.live.com')) {
      throw new SessionExpiredError();
    }
    logger.warn('Sidebar not visible after navigation, but not on login page');
  }

  return true;
}

module.exports = { checkSession, SessionExpiredError };
