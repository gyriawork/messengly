/**
 * Send a message to a Teams chat.
 *
 *  1. Find the chat in the sidebar by threadId (scroll until it renders)
 *  2. Click it + verify the header (non-fatal)
 *  3. Focus the compose textbox
 *  4. Paste HTML via the clipboard API
 *  5. For each attachment: file picker OR clipboard paste → verify chip in compose
 *  6. Dispatch Send, gated on the compose box emptying
 *  7. Verify the message actually left
 *
 * Ported from meetsbroadcast. The one behavioural change is identity: chats are
 * addressed by their stable `threadId`, not by display name, because Messengly
 * keys chats on `externalChatId`. Everything about pasting, attaching and — above
 * all — verification is preserved exactly.
 *
 * Verification is honest: if the message never left, or an attachment didn't make
 * it in, the call reports failure rather than lying about a successful send.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const logger = require('../util/logger');
const S = require('./selectors');
const { getPage } = require('./browser');
const { checkSession } = require('./checkSession');
const { clickChatById, findChatById } = require('./sidebar');
const { captureDebugSnapshot } = require('./debug');

const PASTE_KEY = os.platform() === 'darwin' ? 'Meta+v' : 'Control+v';

class ChatNotFoundError extends Error {
  constructor(threadId) {
    super(`Chat not found in sidebar: ${threadId}`);
    this.name = 'ChatNotFoundError';
    this.threadId = threadId;
  }
}

/**
 * Thrown when an attachment couldn't be reliably attached to the compose box.
 * Never retried — re-running the same UI flow won't fix a missing file picker.
 */
class AttachmentError extends Error {
  constructor(message, fileName) {
    super(message);
    this.name = 'AttachmentError';
    this.fileName = fileName;
  }
}

/** Per-step structured logger. */
function startStep(stepName, chatLabel, requestId) {
  const start = Date.now();
  return {
    ok(extra = {}) {
      logger.info({ step: stepName, chatLabel, requestId, durationMs: Date.now() - start, success: true, ...extra }, '[send]');
    },
    fail(err, extra = {}) {
      logger.error({ step: stepName, chatLabel, requestId, durationMs: Date.now() - start, success: false, error: err?.message || String(err), ...extra }, '[send]');
    },
  };
}

/**
 * @param {object} args
 * @param {string} args.threadId       Stable Teams conversation id
 * @param {string} args.html           Rich-text body
 * @param {string} args.plain          Plain-text fallback (also the verify marker)
 * @param {Array<{path: string, fileName: string, mimeType: string}>} [args.attachments]
 *   Already downloaded to disk by attachments.stageAll()
 * @param {string} [args.requestId]    Correlates debug snapshots with Messengly logs
 * @param {string} [args.sessionKey]   Which Teams session to send through (default: 'default')
 * @returns {Promise<{success: boolean, error?: string, retriable?: boolean}>}
 */
async function sendMessage({ threadId, html, plain, attachments = [], requestId = null, sessionKey = 'default' }) {
  const page = getPage(sessionKey);
  const chatLabel = threadId;

  // Step 0: ensure the session is valid (throws SessionExpiredError)
  await checkSession(page);

  // Step 1: find and open the chat, by id
  let step = startStep('find_chat', chatLabel, requestId);
  try {
    const { found } = await findChatById(page, threadId);
    if (!found) throw new ChatNotFoundError(threadId);
    const clicked = await clickChatById(page, threadId);
    if (!clicked) throw new ChatNotFoundError(threadId);
    step.ok();
  } catch (err) {
    step.fail(err);
    await captureDebugSnapshot(page, requestId, chatLabel, 'find_chat', err);
    throw err;
  }

  // Step 2: verify the chat header (non-fatal — navigation already succeeded)
  step = startStep('verify_header', chatLabel, requestId);
  try {
    const header = page.locator(S.chatHeader).first();
    await header.waitFor({ state: 'visible', timeout: 3_000 });
    step.ok({ header: (await header.textContent().catch(() => ''))?.trim()?.slice(0, 60) });
  } catch (err) {
    step.fail(err);
  }

  // Step 3: focus the compose box
  step = startStep('focus_compose', chatLabel, requestId);
  const compose = page.locator(S.compose).first();
  try {
    await compose.waitFor({ state: 'visible', timeout: 10_000 });
    await compose.click();
    step.ok();
  } catch (err) {
    step.fail(err);
    await captureDebugSnapshot(page, requestId, chatLabel, 'focus_compose', err);
    throw err;
  }

  // Step 4: paste HTML via the clipboard
  step = startStep('paste_text', chatLabel, requestId);
  try {
    await pasteHtmlToCompose(page, compose, html, plain);
    step.ok();
  } catch (err) {
    step.fail(err);
    await captureDebugSnapshot(page, requestId, chatLabel, 'paste_text', err);
    throw err;
  }

  // Step 5: attach files, verifying each one individually
  const attachmentNames = [];
  for (const file of attachments) {
    attachmentNames.push(file.fileName);
    step = startStep('attach', chatLabel, requestId);
    try {
      await attachFile(page, file, chatLabel, requestId);
      const ok = await verifyAttachmentInCompose(page, file.fileName, chatLabel, requestId);
      if (!ok) {
        throw new AttachmentError(`Attachment "${file.fileName}" did not appear in compose after upload`, file.fileName);
      }
      step.ok({ fileName: file.fileName });
    } catch (err) {
      step.fail(err, { fileName: file.fileName });
      await captureDebugSnapshot(page, requestId, chatLabel, 'attach', err);
      throw err;
    }
  }

  // Step 6: dispatch. With an attachment Teams spends a moment finalizing the
  // file (generating a share link), during which a single Send click is a no-op
  // and the message just sits in compose. So we send, wait for compose to clear,
  // and retry via Ctrl+Enter if it doesn't. The compose-empty gate before each
  // retry is what prevents a double-send.
  step = startStep('send', chatLabel, requestId);
  try {
    const composeText = await compose.innerText().catch(() => '');
    if (!composeText || !composeText.trim()) {
      throw new Error('Compose is empty before Send — text paste failed silently');
    }

    // Teams ships both `sendMessageCommands-` and `newMessageCommands-` prefixes.
    const sendSelectors = [
      S.sendButton,
      '[data-tid="sendMessageCommands-send"]',
      '[data-tid="newMessageCommands-send"]',
      'button[name="send"]',
      'button[aria-label*="Отправить"]',
      'button[aria-label*="Send"]',
    ];
    let sendBtn = null;
    for (const sel of sendSelectors) {
      const candidate = page.locator(sel).first();
      if (await candidate.isVisible({ timeout: 1500 }).catch(() => false)) {
        sendBtn = candidate;
        logger.info({ chatLabel, requestId, selector: sel }, '[send] send button matched');
        break;
      }
    }

    const composeEmpty = async () => {
      const t = await compose.innerText().catch(() => null);
      return t !== null && t.replace(/\u200B/g, '').trim() === '';
    };

    let dispatched = false;
    const MAX_DISPATCH = 4;
    for (let a = 0; a < MAX_DISPATCH && !dispatched; a++) {
      if (a === 0 && sendBtn) {
        const disabled = await sendBtn.getAttribute('aria-disabled').catch(() => null);
        if (disabled !== 'true' && disabled !== '') {
          await sendBtn.click().catch(() => {});
        } else {
          await compose.click();
          await compose.press('Control+Enter');
        }
      } else {
        // Retry via keyboard — reliable and unaffected by button state.
        await compose.click();
        await page.waitForTimeout(200);
        await compose.press('Control+Enter');
      }
      // Wait for compose to clear (the message actually left). The first attempt
      // gets a longer window so a slow-but-successful dispatch isn't double-sent.
      const polls = a === 0 ? 16 : 12; // 8s then 6s
      for (let i = 0; i < polls; i++) {
        if (await composeEmpty()) { dispatched = true; break; }
        await page.waitForTimeout(500);
      }
      if (!dispatched) {
        logger.warn({ chatLabel, requestId, attempt: a }, '[send] compose still not empty after dispatch — retrying');
      }
    }
    step.ok({ dispatched });
  } catch (err) {
    step.fail(err);
    await captureDebugSnapshot(page, requestId, chatLabel, 'send', err);
    throw err;
  }

  // Step 7: verify the message arrived
  step = startStep('verify_feed', chatLabel, requestId);
  const result = await verifyMessage(page, compose, plain, attachmentNames);
  if (result.ok) {
    step.ok({ attachmentCount: attachmentNames.length });
    return { success: true };
  }
  step.fail(new Error(result.reason));
  await captureDebugSnapshot(page, requestId, chatLabel, 'verify_feed', new Error(result.reason));
  // `countIncreased: true` means the message DID leave but we couldn't strictly
  // re-match the bubble. Report retriable:false so the caller never retries —
  // that would produce a duplicate message in a real chat.
  return {
    success: false,
    error: result.reason,
    retriable: !result.countIncreased,
  };
}

/**
 * Paste rich-text HTML into compose using ClipboardItem + a real Cmd+V/Ctrl+V.
 * Falls back to keyboard.type(plain) if paste leaves compose empty.
 *
 * IMPORTANT: clears compose first (Ctrl+A → Delete). Without this, a retry after
 * a false-negative verify pastes ON TOP of the previous text — the user sees the
 * same message twice in one bubble.
 */
async function pasteHtmlToCompose(page, compose, html, plain) {
  await compose.click();
  const SELECT_ALL = os.platform() === 'darwin' ? 'Meta+a' : 'Control+a';
  await compose.press(SELECT_ALL);
  await page.waitForTimeout(80);
  await compose.press('Delete');
  await page.waitForTimeout(80);

  await page.evaluate(
    async ({ html, plain }) => {
      const blob = new Blob([html], { type: 'text/html' });
      const plainBlob = new Blob([plain], { type: 'text/plain' });
      const item = new ClipboardItem({ 'text/html': blob, 'text/plain': plainBlob });
      await navigator.clipboard.write([item]);
    },
    { html, plain }
  );
  await compose.press(PASTE_KEY);
  await page.waitForTimeout(700);

  const composeText = await compose.innerText().catch(() => '');
  if (!composeText || !composeText.trim()) {
    await compose.click();
    await page.keyboard.type(plain, { delay: 10 });
    await page.waitForTimeout(300);
    const after = await compose.innerText().catch(() => '');
    if (!after || !after.trim()) {
      throw new Error('Compose box stayed empty after paste AND keyboard type');
    }
  }
}

/**
 * Attach a single file.
 *   - Images always go through clipboard paste: FilePicker uploads them as a
 *     file card, paste renders them inline as a picture in the chat.
 *   - Everything else needs the FilePicker button — present only in 1:1 chats;
 *     the clipboard cannot carry non-image data in a web context.
 *
 * Caller MUST call verifyAttachmentInCompose() afterwards; this only attempts
 * the upload, it does not verify success.
 */
async function attachFile(page, file, chatLabel, requestId) {
  const log = (msg, extra = {}) => logger.info({ chatLabel, requestId, ...extra }, '[attach] ' + msg);

  try {
    await page.locator(S.composeFooter).first().waitFor({ state: 'visible', timeout: 10_000 });
  } catch { /* proceed anyway */ }

  if ((file.mimeType || '').startsWith('image/')) {
    log('image attachment — pasting to render inline', { fileName: file.fileName });
    await pasteAttachmentToCompose(page, file, log);
    return;
  }

  const attachSelectors = [
    S.attachFiles,
    '[data-tid="sendMessageCommands-FilePicker"]',
    '[data-tid="sendMessageCommands-FilePickerWithImageIcon"]',
    'button[aria-label*="Вложить файлы"]',
    'button[aria-label*="Attach files"]',
    'button[aria-label*="Прикрепить"]',
    'button[name="FilePicker"]',
    'button[name="FilePickerWithImageIcon"]',
  ];
  let attachBtn = null;
  for (const sel of attachSelectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
      attachBtn = btn;
      log('FilePicker found, using button flow', { selector: sel });
      break;
    }
  }

  if (attachBtn) {
    const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 25_000 }).catch(() => null);
    // Clicking the paperclip ALWAYS opens a menu whose first item is "Upload from
    // this device". The menu can be slow on the first (cold) chat, so wait
    // generously and retry the click once rather than assuming a direct chooser.
    const menuItem = page.getByText(/Отправить с этого устройства|Upload from this device|Upload from device/i).first();
    let menuClicked = false;
    for (let attempt = 0; attempt < 2 && !menuClicked; attempt++) {
      await attachBtn.click();
      try {
        await menuItem.waitFor({ state: 'visible', timeout: 8_000 });
        await menuItem.click();
        menuClicked = true;
        log('menu item "Upload from this device" clicked', { attempt });
      } catch {
        log('menu not visible yet, retrying attach click', { attempt });
        await page.waitForTimeout(600);
      }
    }
    if (!menuClicked) log('menu never appeared — awaiting direct chooser as fallback');
    const chooser = await fileChooserPromise;
    if (chooser) {
      log('filechooser fired, setting files');
      await chooser.setFiles(file.path);
      await page.waitForTimeout(2000);
      return;
    }
    log('FilePicker flow did not yield chooser — falling back to clipboard paste');
  } else {
    log('FilePicker not present (likely group chat) — using clipboard paste');
  }

  await pasteAttachmentToCompose(page, file, log);
}

/**
 * Paste a file as a ClipboardItem and Cmd+V/Ctrl+V into compose.
 *
 * IMPORTANT: Chromium's Clipboard API only supports `image/png` for write() —
 * JPEG/GIF/WebP must be canvas-converted to PNG first. Non-image files cannot be
 * pasted at all, so group chats simply cannot receive them.
 */
async function pasteAttachmentToCompose(page, file, log) {
  const buffer = fs.readFileSync(file.path);
  const mime = file.mimeType;
  const isImage = mime.startsWith('image/');

  if (!isImage) {
    throw new AttachmentError(
      `File "${file.fileName}" (${mime}) cannot be sent to this chat. Teams group chats ` +
      `expose no file picker, and clipboard paste only supports images. Send this file to ` +
      `a 1-on-1 chat, or use an image format.`,
      file.fileName
    );
  }

  const base64 = buffer.toString('base64');
  log('paste: writing ClipboardItem (via canvas→png)', { fileName: file.fileName, mime, sizeKB: Math.round(buffer.length / 1024) });

  await page.evaluate(async ({ base64, mime }) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const srcBlob = new Blob([bytes], { type: mime });

    let pngBlob;
    if (mime === 'image/png') {
      pngBlob = srcBlob;
    } else {
      const img = new Image();
      const url = URL.createObjectURL(srcBlob);
      try {
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = () => reject(new Error('Image decode failed'));
          img.src = url;
        });
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        pngBlob = await new Promise((resolve, reject) => {
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null'))), 'image/png');
        });
      } finally {
        URL.revokeObjectURL(url);
      }
    }

    const item = new ClipboardItem({ 'image/png': pngBlob });
    await navigator.clipboard.write([item]);
  }, { base64, mime });

  // Real keyboard event — isTrusted=true, so Teams handles it
  const compose = page.locator(S.compose).first();
  await compose.click();
  await compose.press(PASTE_KEY);
  log('paste: Cmd/Ctrl+V dispatched, waiting for Teams to process the upload');
  await page.waitForTimeout(2500);
}

/**
 * Verify the attachment chip appeared in compose AFTER upload. Without this,
 * Send would happily fire on a text-only compose and Teams would deliver the
 * message with no attachment at all.
 */
async function verifyAttachmentInCompose(page, fileName, chatLabel, requestId) {
  const log = (msg, extra = {}) => logger.info({ chatLabel, requestId, fileName, ...extra }, '[verify-attach] ' + msg);
  const baseName = path.parse(fileName).name;

  const chipSelectors = [
    `[aria-label*="${fileName}"]`,
    `[aria-label*="${baseName}"]`,
    `[data-tid*="attachment"]`,
    `[data-tid*="upload-item"]`,
    `[data-tid*="file-card"]`,
    `[data-tid*="card-attachment"]`,
    `img[alt*="${baseName}"]`,
    `figure img`, // pasted images often render as <figure><img/>
  ];

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    for (const sel of chipSelectors) {
      const found = await page.locator(S.composeFooter).locator(sel).first()
        .isVisible({ timeout: 500 }).catch(() => false);
      if (found) {
        log('attachment chip verified in compose', { selector: sel });
        return true;
      }
    }

    // A pasted image lands INLINE in the compose text field, not in the footer
    // attachment strip. It renders from a blob:/data: URL — emoji images come
    // from the CDN, so this cannot false-positive on them.
    const inlineImg = await page.locator(S.compose).locator('img[src^="blob:"], img[src^="data:"]').first()
      .isVisible({ timeout: 500 }).catch(() => false);
    if (inlineImg) {
      log('attachment verified as inline image in compose');
      return true;
    }

    await page.waitForTimeout(500);
  }

  const dump = await page.locator(S.composeFooter).innerHTML().catch(() => '');
  log('attachment chip NOT found after 8s', { footerSnippet: dump.slice(0, 600) });
  return false;
}

/**
 * Verify the message was sent.
 *
 * The feed is virtualized (message-pane-list-runway) — counting chat-pane-message
 * elements is unreliable, because old bubbles drop out of the DOM as the new one
 * is added, so the count often does NOT increase even on a successful send. The
 * reliable, virtualization-independent signal is that the COMPOSE box empties:
 * Teams only clears it once the message actually leaves. If a send is blocked
 * (e.g. by a modal or banner), the text stays in compose.
 *
 * Primary   : compose becomes empty  → message sent
 * Confirming: the last feed bubble contains our marker text (best-effort)
 *
 * `countIncreased` is true when compose emptied — the message went out even if we
 * couldn't re-match the bubble — so the caller must NOT retry (it would duplicate).
 *
 * @returns {Promise<{ ok: boolean, reason: string|null, countIncreased: boolean }>}
 */
async function verifyMessage(page, compose, plainText, attachmentNames = []) {
  const marker = (plainText || '').slice(0, 50).trim();

  // Primary signal: compose empties once the message is sent.
  let composeEmptied = false;
  for (let i = 0; i < 30; i++) { // up to ~15s
    const text = await compose.innerText().catch(() => null);
    if (text !== null && text.replace(/\u200B/g, '').trim() === '') {
      composeEmptied = true;
      break;
    }
    await page.waitForTimeout(500);
  }

  if (!composeEmptied) {
    return {
      ok: false,
      reason: 'Message stayed in the compose box — send was blocked and never went out',
      countIncreased: false,
    };
  }

  // Confirming signal (best-effort). Failure here does NOT flip success: compose
  // already emptied, so the message is out; we only log a soft warning.
  let contentConfirmed = false;
  let attachmentConfirmed = attachmentNames.length === 0;
  for (let i = 0; i < 16; i++) { // up to ~8s for Teams to echo the bubble
    const messages = page.locator(S.messageBubble);
    const count = await messages.count().catch(() => 0);
    if (count > 0) {
      const last = messages.nth(count - 1);
      const text = await last.textContent().catch(() => '');
      if (!marker || (text && text.includes(marker))) contentConfirmed = true;
      if (!attachmentConfirmed) {
        for (const name of attachmentNames) {
          const baseName = path.parse(name).name;
          const found = await last.locator([
            `[aria-label*="${name}"]`, `[aria-label*="${baseName}"]`,
            `img[alt*="${baseName}"]`, `[data-tid*="file-attachment"]`,
            `[data-tid*="card-attachment"]`, `[data-tid*="lazy-image"]`, `figure img`,
          ].join(', ')).first().isVisible({ timeout: 500 }).catch(() => false);
          if (found) { attachmentConfirmed = true; break; }
        }
      }
      if (contentConfirmed && attachmentConfirmed) break;
    }
    await page.waitForTimeout(500);
  }

  if (!contentConfirmed || !attachmentConfirmed) {
    logger.warn({ contentConfirmed, attachmentConfirmed, marker },
      '[verify] compose emptied (message sent) but could not re-confirm bubble content');
  }
  // Compose emptied → the message is out. countIncreased:true so nobody retries.
  return { ok: true, reason: null, countIncreased: true };
}

module.exports = { sendMessage, ChatNotFoundError, AttachmentError };
