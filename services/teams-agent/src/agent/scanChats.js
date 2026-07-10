/**
 * Scan the Teams sidebar for chats.
 *
 * Ported from meetsbroadcast, with the DB reconciliation stripped out: this
 * agent is stateless about chats. It returns them and Messengly decides what to
 * import into its own `Chat` model.
 *
 * The other change is identity: meetsbroadcast returned names only. We return
 * the stable `threadId` too, because Messengly keys chats on `externalChatId`.
 */

const logger = require('../util/logger');
const { ensurePage } = require('./browser');
const { checkSession } = require('./checkSession');
const { collectAllChats } = require('./sidebar');
const lock = require('./lock');

/**
 * Heuristic chat type. Teams' DOM does not tell us whether a conversation is
 * 1:1 or a group, so we guess from the display name exactly as meetsbroadcast
 * does. Unknown maps to `direct`, which is Messengly's default chat type.
 *
 * This only affects display. The attachment strategy is decided at send time by
 * probing for a file picker, not by this guess.
 */
function guessType(name) {
  if (name.startsWith('#')) return 'channel';
  if (name.includes(',') || name.includes(' и ')) return 'group';
  return 'direct';
}

/**
 * @returns {Promise<Array<{ threadId: string, name: string, type: string }>>}
 */
async function scanChats() {
  return lock.withLock(async () => {
    logger.info('Starting chat scan...');
    const page = await ensurePage();
    await checkSession(page);

    const chats = await collectAllChats(page);
    logger.info({ count: chats.length }, 'Collected chats from sidebar');

    return chats
      .filter((c) => c.id && c.name)
      .map((c) => ({ threadId: c.id, name: c.name, type: guessType(c.name) }));
  });
}

module.exports = { scanChats, guessType };
