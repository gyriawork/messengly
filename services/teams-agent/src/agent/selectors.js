/**
 * Centralized Playwright selectors for Teams Web (personal account).
 *
 * Validated against teams.live.com/v2/ on 2026-07-03.
 * Personal MS accounts use teams.live.com (not teams.microsoft.com).
 *
 * If Microsoft changes a data-tid, update ONLY this file.
 * Every other module imports from here.
 */

const S = {
  // --- Space picker (post-login interstitial) ---
  spacePicker:   'text="Личное"',

  // --- Sidebar / chat list ---
  // The chat list is a role="tree" under data-tid="simple-collab-dnd-rail". Chat
  // rows are treeitems marked data-item-type="chat"; each carries a stable
  // conversation id in data-fui-tree-item-value (after the last "|") and its name
  // in #title-chat-list-item_<id>. Identity/name/click logic lives in sidebar.js.
  sidebar:       '[data-tid="simple-collab-dnd-rail"]',
  chatItem:      '[data-tid="simple-collab-dnd-rail"] [role="treeitem"][data-item-type="chat"]',

  // --- Chat-type detection ---
  // Primary signal, confirmed against a live 347-chat sidebar: every row's
  // aria-labelledby includes one of these two tokens, and Teams sets it
  // correctly regardless of what the display name looks like (many 2-company
  // "X & Y Integration" names turned out to be group chats, not 1:1s — name
  // guessing alone gets this wrong). Avatar image count was tried first and
  // discarded: every row showed exactly 1 image/2 avatar nodes whether the
  // chat was 1:1 or group, so it carries no discriminating signal here.
  ariaOneOnOneMarker: 'one-on-one-chat-support-text',
  ariaGroupMarker:    'chat-group-support-text',
  // Kept as a secondary/defensive signal in case a future Teams rollout ever
  // renders a distinguishable stacked avatar — chatType.js only lets this
  // ADD confidence toward "group", never assert "direct".
  avatarNode:    '[data-tid*="vatar"], [class*="avatar"], [class*="Avatar"]',

  // --- Chat view header ---
  // Multiple candidates — Teams sometimes uses h1/h2 depending on chat type/rollout.
  chatHeader:    '[data-tid="chat-title"] h2, [data-tid="chat-title"] h1, [data-tid="chat-title"] [role="heading"], [data-tid="chat-title"]',
  chatTitle:     '[data-tid="chat-title"]',

  // --- Compose area ---
  compose:       '[data-tid="chat-pane-compose-message-footer"] [role="textbox"], [data-tid="chat-pane-compose-message-footer"] [contenteditable="true"]',
  composeFooter: '[data-tid="chat-pane-compose-message-footer"]',

  // --- Send button ---
  sendButton:    '[data-tid="sendMessageCommands-send"]',   // aria-label="Отправить (Ctrl+Enter)"

  // --- Attach ---
  attachFiles:   '[data-tid="sendMessageCommands-FilePicker"]',              // aria-label="Вложить файлы"
  attachMedia:   '[data-tid="sendMessageCommands-FilePickerWithImageIcon"]', // aria-label="Вложить мультимедиа"
  attachInput:   'input[type="file"]',

  // --- Message feed ---
  messageList:    '[data-tid="message-pane-list-viewport"]',
  messageBody:    '[data-tid="message-pane-body"]',
  messageBubble:  '[data-tid="chat-pane-message"]',
  messageItem:    '[data-tid="chat-pane-item"]',
  messageAuthor:  '[data-tid="message-author-name"]',
};

// Teams URL for personal accounts
S.TEAMS_URL = 'https://teams.live.com/v2/';

module.exports = S;
