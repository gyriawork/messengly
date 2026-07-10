/**
 * Chat-list (left rail) helpers for the Teams web UI.
 *
 * The chat list is a role="tree" (data-tid="simple-collab-dnd-rail"). Each chat
 * row is a treeitem with data-item-type="chat" and a STABLE conversation id:
 *   - data-fui-tree-item-value = "...|<threadId>"  (threadId after last "|")
 *   - the name lives in element  #title-chat-list-item_<threadId>
 *
 * A favourited chat appears twice (once under "Избранное", once under "Чаты")
 * with the SAME threadId — so we dedupe by id. Clicking is done by id, not by
 * DOM index, which is immune to the favourites duplication and to list
 * reordering between reads.
 *
 * Unlike meetsbroadcast, which identified chats by display name, this agent
 * exposes the threadId as the chat's identity. Messengly stores it as
 * `Chat.externalChatId`, so renaming a chat no longer breaks anything.
 */

const S = require('./selectors');

const MAX_SCROLL_ROUNDS = 50;
const MAX_STABLE_ROUNDS = 3;

/**
 * Read chats from the sidebar, deduped by conversation id, in DOM order.
 * @returns {Promise<Array<{ id: string, name: string }>>}
 */
async function readChats(page) {
  const rows = await page.evaluate((sel) => {
    const parseId = (row) => {
      const v = row.getAttribute('data-fui-tree-item-value') || '';
      const afterPipe = v.split('|').pop() || '';
      if (/@thread|@unq|:orgid|:notes|19:|8:/i.test(afterPipe)) return afterPipe.trim();
      // fallback: data-tabster observed name
      try {
        const t = JSON.parse(row.getAttribute('data-tabster') || '{}');
        const n = t?.observed?.names?.[0];
        if (n) return String(n).trim();
      } catch { /* ignore */ }
      return '';
    };
    const nameOf = (row, id) => {
      // Preferred: the dedicated title element referenced by aria-labelledby
      if (id) {
        const titleEl = document.getElementById('title-chat-list-item_' + id);
        if (titleEl) {
          const t = (titleEl.textContent || '').replace(/\s+/g, ' ').trim();
          if (t) return t;
        }
      }
      // Fallback: first text <span> that is not a timestamp and not in an avatar
      for (const span of row.querySelectorAll('span')) {
        if (span.closest('time')) continue;
        if (span.closest('[data-tid*="vatar"], [class*="avatar"], [class*="Avatar"]')) continue;
        const own = [...span.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        if (!own) continue;
        const text = span.textContent.replace(/\s+/g, ' ').trim();
        if (text) return text;
      }
      return (row.innerText || '').split('\n')[0].replace(/\s+/g, ' ').trim();
    };
    return [...document.querySelectorAll(sel)].map((row) => {
      const id = parseId(row);
      return { id, name: nameOf(row, id) };
    });
  }, S.chatItem);

  // Dedupe by id (a favourited chat appears in "Избранное" AND "Чаты").
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const key = r.id || ('name:' + r.name);
    if (!r.name || seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/** Scroll the sidebar back to the top. Best-effort. */
async function scrollSidebarToTop(page) {
  try {
    const sidebar = page.locator(S.sidebar).first();
    await sidebar.evaluate((el) => { el.scrollTop = 0; });
    await page.waitForTimeout(300);
  } catch { /* best effort */ }
}

/**
 * Click a chat row by its conversation id. Returns true if clicked.
 * Immune to favourites duplication (all dupes share the id → first wins).
 */
async function clickChatById(page, id) {
  const row = page.locator(`${S.chatItem}[data-fui-tree-item-value$="${id}"]`).first();
  if (await row.count().catch(() => 0) === 0) return false;
  await row.click();
  return true;
}

/**
 * Scroll the (virtualized) sidebar until the row carrying `threadId` is in the
 * DOM. Teams only renders visible rows, so a chat further down the list simply
 * does not exist until we scroll to it.
 *
 * @returns {Promise<{ found: boolean, name?: string }>}
 */
async function findChatById(page, threadId) {
  const sidebar = page.locator(S.sidebar).first();
  await sidebar.waitFor({ state: 'visible', timeout: 10_000 });
  await scrollSidebarToTop(page);

  let prevCount = 0;
  let stableRounds = 0;

  for (let round = 0; round < MAX_SCROLL_ROUNDS; round++) {
    const chats = await readChats(page);
    const hit = chats.find((c) => c.id === threadId);
    if (hit) return { found: true, name: hit.name };

    if (chats.length === prevCount) {
      stableRounds++;
      if (stableRounds >= MAX_STABLE_ROUNDS) return { found: false };
    } else {
      stableRounds = 0;
      prevCount = chats.length;
    }

    try {
      await sidebar.evaluate((el) => el.scrollBy(0, 600));
    } catch { break; }
    await page.waitForTimeout(400);
  }

  return { found: false };
}

/**
 * Scroll the whole sidebar and collect every chat, deduped by threadId.
 * @returns {Promise<Array<{ id: string, name: string }>>}
 */
async function collectAllChats(page) {
  const sidebar = page.locator(S.sidebar).first();
  await sidebar.waitFor({ state: 'visible', timeout: 30_000 });
  await scrollSidebarToTop(page);

  const byId = new Map();
  let prevCount = 0;
  let stableRounds = 0;

  for (let round = 0; round < MAX_SCROLL_ROUNDS; round++) {
    for (const chat of await readChats(page)) {
      const key = chat.id || ('name:' + chat.name);
      if (!byId.has(key)) byId.set(key, chat);
    }

    if (byId.size === prevCount) {
      stableRounds++;
      if (stableRounds >= MAX_STABLE_ROUNDS) break;
    } else {
      stableRounds = 0;
      prevCount = byId.size;
    }

    try {
      await sidebar.evaluate((el) => el.scrollBy(0, 600));
    } catch { break; }
    await page.waitForTimeout(1000);
  }

  return [...byId.values()];
}

module.exports = { readChats, clickChatById, findChatById, collectAllChats, scrollSidebarToTop };
