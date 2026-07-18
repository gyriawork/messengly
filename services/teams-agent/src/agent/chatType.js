/**
 * Teams chat-type detection — the ONE place this decision is made.
 *
 * Pure function, no DOM/Playwright access, so it's unit-testable without a
 * browser. sidebar.js only collects raw signals per row; this interprets them.
 *
 * Signal priority, based on inspecting a live 347-chat sidebar (see commit
 * history for the recon): Teams tags every chat row's `aria-labelledby` with
 * either `one-on-one-chat-support-text` or `chat-group-support-text`, and it
 * was 100% consistent — including for two-company "X & Y Integration" style
 * names that read like groups but are actually 1:1s under the hood. Avatar
 * image count was tried first and discarded: every row showed exactly one
 * avatar image regardless of type, so it carries zero discriminating power in
 * practice and is kept only as a defensive secondary signal that can push
 * towards "group" (stacked/composite avatars), never towards "direct".
 *
 * Returns null when no signal fires — callers must never guess. A null here
 * becomes chatType 'unknown' in the DB, rendered as "—" in the UI; it is
 * never silently defaulted to 'direct'.
 *
 * @param {{ ariaMarker?: 'one-on-one'|'group'|null, avatarImgCount?: number, hasGroupAvatar?: boolean, name?: string }} signals
 * @returns {'direct'|'group'|'channel'|null}
 */
function detectChatType(signals = {}) {
  const { ariaMarker, avatarImgCount = 0, hasGroupAvatar = false, name = '' } = signals;

  if (ariaMarker === 'one-on-one') return 'direct';
  if (ariaMarker === 'group') return 'group';

  // Secondary: avatar signal, positive-only (never asserts "direct").
  if (hasGroupAvatar || avatarImgCount > 1) return 'group';

  // Tertiary: name heuristic, only when neither DOM signal fired.
  if (name.startsWith('#')) return 'channel';
  if (name.includes(',') || name.includes(' и ')) return 'group';

  return null;
}

module.exports = { detectChatType };
