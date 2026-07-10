/**
 * Attachment staging.
 *
 * Messengly stores broadcast attachments in object storage and hands us URLs.
 * Playwright needs real files on disk, so we download each one to a temp file.
 *
 * The filename gets a short random suffix. Teams refuses to send a file whose
 * name it has already seen ("a file with the same name was already shared"),
 * which silently blocks Send on the second and later chats of a broadcast.
 * meetsbroadcast solved this by renaming to `bcast-<uuid>.<ext>`; we keep the
 * original basename so recipients still see a meaningful name.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const logger = require('../util/logger');
const config = require('../config');

const MIME_MAP = {
  pdf: 'application/pdf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  txt: 'text/plain', csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip', json: 'application/json',
};

/** Best-effort mime from a file path; falls back to octet-stream. */
function getMime(filePath) {
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  return MIME_MAP[ext] || 'application/octet-stream';
}

/** Strip path separators and control characters out of a caller-supplied name. */
function safeBaseName(name) {
  const base = path.basename(String(name || 'file'));
  return base.replace(/[^\w.\- ]+/g, '_').slice(0, 80) || 'file';
}

/**
 * Download one attachment to a uniquely-named temp file.
 *
 * @param {{ url: string, filename?: string, mimeType?: string }} attachment
 * @returns {Promise<{ path: string, fileName: string, mimeType: string }>}
 */
async function stageAttachment(attachment) {
  const { url } = attachment;
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new Error(`Attachment url must be absolute http(s): ${url}`);
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download attachment (HTTP ${res.status}): ${url}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > config.MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `Attachment is ${Math.round(buffer.length / 1024 / 1024)} MB, over the ` +
      `${Math.round(config.MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB limit`
    );
  }

  const original = safeBaseName(attachment.filename || path.basename(new URL(url).pathname));
  const ext = path.extname(original);
  const stem = ext ? original.slice(0, -ext.length) : original;
  const suffix = crypto.randomBytes(4).toString('hex');
  const fileName = `${stem}-${suffix}${ext}`;
  const dest = path.join(os.tmpdir(), fileName);

  await fs.promises.writeFile(dest, buffer);
  const mimeType = attachment.mimeType || getMime(dest);

  logger.info({ fileName, mimeType, sizeKB: Math.round(buffer.length / 1024) }, 'attachment staged');
  return { path: dest, fileName, mimeType };
}

/** Download every attachment, cleaning up partial work if any of them fails. */
async function stageAll(attachments = []) {
  const staged = [];
  try {
    for (const a of attachments) staged.push(await stageAttachment(a));
    return staged;
  } catch (err) {
    await cleanup(staged);
    throw err;
  }
}

async function cleanup(staged = []) {
  await Promise.all(
    staged.map((s) => fs.promises.unlink(s.path).catch(() => {}))
  );
}

module.exports = { stageAttachment, stageAll, cleanup, getMime };
