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
const { detectChatType } = require('./chatType');
const lock = require('./lock');

/**
 * @returns {Promise<Array<{ threadId: string, name: string, type: 'direct'|'group'|'channel'|null }>>}
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
      .map((c) => ({ threadId: c.id, name: c.name, type: detectChatType(c) }));
  });
}

module.exports = { scanChats };
