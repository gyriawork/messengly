/**
 * Normalize Slack/Discord-style `:emoji_name:` shortcodes in message HTML
 * to real Unicode emoji characters BEFORE we paste into Teams.
 *
 * Why: rich-text editors (and clipboard paste from Slack) leave behind
 *   <img alt=":slot_machine:" src="https://a.slack-edge.com/...">
 * When this HTML lands in Teams compose via Cmd+V, Teams sees an external
 * image URL and uploads it as an attachment card — producing a huge gray
 * tile per emoji. Teams DOES render Unicode emoji natively inline, so the fix
 * is to convert img-shortcodes → Unicode.
 *
 * Unknown shortcodes are left as-is (kept as `:name:` text) so the user notices
 * and can fix the template, rather than having them silently dropped.
 */

const emoji = require('node-emoji');

/**
 * @param {string} html
 * @returns {string} normalized HTML
 */
function normalizeEmojiInHtml(html) {
  if (!html || typeof html !== 'string') return html;

  // 1. Replace <img ... alt=":name:" ...> tags.
  let out = html.replace(
    /<img\b[^>]*\balt\s*=\s*["']:([a-zA-Z0-9_+-]+):["'][^>]*>/gi,
    (match, name) => {
      const char = emoji.get(`:${name}:`);
      return char ? char : `:${name}:`; // fallback = plain shortcode text
    }
  );

  // 2. If the img was wrapped in a span with no other content (common Slack
  //    paste pattern), unwrap the span so the Unicode char doesn't stay inside
  //    a noisy <span style="...">. Repeat to catch nested wrappers.
  for (let i = 0; i < 3; i++) {
    const before = out;
    out = out.replace(
      /<span\b[^>]*>\s*([^<>\s][^<]*?)\s*<\/span>/gi,
      (match, inner) => {
        if (inner.length <= 8 && !/[<>]/.test(inner)) return inner;
        return match;
      }
    );
    if (out === before) break;
  }

  // 3. Replace bare text shortcodes (`:rocket:` outside tags). Split on tags so
  //    we never substitute inside href/src attributes.
  out = out.replace(/(>|^)([^<]*)/g, (match, prefix, text) => {
    const normalized = text.replace(/:([a-zA-Z0-9_+-]+):/g, (m, name) => {
      const char = emoji.get(`:${name}:`);
      return char ? char : m;
    });
    return prefix + normalized;
  });

  return out;
}

/** Mirror for plain text — same shortcode replacement. */
function normalizeEmojiInText(text) {
  if (!text || typeof text !== 'string') return text;
  return text.replace(/:([a-zA-Z0-9_+-]+):/g, (m, name) => {
    const char = emoji.get(`:${name}:`);
    return char ? char : m;
  });
}

module.exports = { normalizeEmojiInHtml, normalizeEmojiInText };
