// ─── Telegram Adapter (gramjs / MTProto) ───
// Real implementation using the `telegram` (gramjs) package with TelegramClient.
// Supports multi-step interactive auth: sendCode → signIn → optional 2FA.

import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { CustomFile } from 'telegram/client/uploads.js';
import IORedis from 'ioredis';
import type { MessengerAdapter, GetMessagesResult, HistoryMessage } from './base.js';
import { MessengerError } from './base.js';

// Common MIME → extension map; falls back to the subtype (e.g. image/webp → webp).
const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'application/pdf': 'pdf',
};

/**
 * Ensure a file name has an extension so Telegram can detect the media type.
 * Without an extension, images are sent as un-openable "attachment" documents.
 */
function ensureFileExtension(name: string | undefined, mimeType: string | undefined): string {
  const base = name && name.trim() ? name.trim() : 'file';
  if (/\.[a-z0-9]{2,5}$/i.test(base)) return base; // already has an extension
  const mime = (mimeType || '').toLowerCase();
  const ext = MIME_EXT[mime] || mime.split('/')[1]?.split('+')[0] || '';
  return ext ? `${base}.${ext}` : base;
}

// ─── Types ───

export interface TelegramCredentials {
  apiId: number;
  apiHash: string;
  session?: string;
  phoneNumber?: string;
}

// ─── Redis-backed pending auth store for multi-step Telegram auth ───
// TelegramClient holds a live MTProto connection and cannot be serialized,
// so we keep a local Map for client references while storing metadata in
// Redis with a 300s TTL. Redis handles expiry automatically — no cleanup
// interval needed.

interface PendingAuth {
  client: TelegramClient;
  phoneNumber: string;
  apiId: number;
  apiHash: string;
  createdAt: number;
}

interface PendingAuthMeta {
  phoneNumber: string;
  apiId: number;
  apiHash: string;
  createdAt: number;
}

const PENDING_AUTH_TTL_SECONDS = 300; // 5 minutes
const REDIS_KEY_PREFIX = 'telegram:pending-auth:';

/** Local map for TelegramClient references (not serializable). */
const localClients = new Map<string, TelegramClient>();

/** Lazily-initialized Redis client for pending auth metadata. */
let redis: IORedis | null = null;

function getRedis(): IORedis {
  if (!redis) {
    redis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });
    redis.connect().catch(() => {});
  }
  return redis;
}

function redisKey(userPhone: string): string {
  return `${REDIS_KEY_PREFIX}${userPhone}`;
}

/**
 * Store a temporary TelegramClient during multi-step auth.
 * Metadata is persisted to Redis with a 300s TTL; the live client
 * reference is held in a local Map.
 */
export async function storePendingAuth(
  userId: string,
  phoneNumber: string,
  client: TelegramClient,
  apiId: number,
  apiHash: string,
): Promise<void> {
  const key = `${userId}:${phoneNumber}`;

  // Clean up any previous local client
  const prev = localClients.get(key);
  if (prev) {
    prev.disconnect().catch(() => {});
  }

  // Store client reference locally
  localClients.set(key, client);

  // Store serializable metadata in Redis with TTL
  const meta: PendingAuthMeta = { phoneNumber, apiId, apiHash, createdAt: Date.now() };
  await getRedis().set(redisKey(key), JSON.stringify(meta), 'EX', PENDING_AUTH_TTL_SECONDS);
}

/**
 * Retrieve a pending auth client. Returns undefined if expired or not found.
 */
export async function getPendingAuth(userId: string, phoneNumber: string): Promise<PendingAuth | undefined> {
  const key = `${userId}:${phoneNumber}`;

  const raw = await getRedis().get(redisKey(key));
  if (!raw) {
    // Expired or never stored — clean up local client if any
    const orphan = localClients.get(key);
    if (orphan) {
      orphan.disconnect().catch(() => {});
      localClients.delete(key);
    }
    return undefined;
  }

  const client = localClients.get(key);
  if (!client) {
    // Redis has metadata but local client is gone (e.g. process restarted)
    await getRedis().del(redisKey(key));
    return undefined;
  }

  const meta: PendingAuthMeta = JSON.parse(raw);
  return {
    client,
    phoneNumber: meta.phoneNumber,
    apiId: meta.apiId,
    apiHash: meta.apiHash,
    createdAt: meta.createdAt,
  };
}

/**
 * Remove a pending auth entry (on success or explicit cancel).
 */
export async function removePendingAuth(userId: string, phoneNumber: string): Promise<void> {
  const key = `${userId}:${phoneNumber}`;

  // Remove from Redis
  await getRedis().del(redisKey(key));

  // Remove local client reference — don't disconnect, caller owns it now
  localClients.delete(key);
}

// ─── Adapter ───

export class TelegramAdapter implements MessengerAdapter {
  private client: TelegramClient | null = null;
  private status: 'connected' | 'disconnected' | 'token_expired' | 'session_expired' = 'disconnected';
  private credentials: TelegramCredentials;

  constructor(credentials: TelegramCredentials) {
    this.credentials = credentials;
  }

  async connect(): Promise<void> {
    try {
      if (!this.credentials.apiId || !this.credentials.apiHash) {
        throw new Error('apiId and apiHash are required');
      }

      const session = new StringSession(this.credentials.session ?? '');
      this.client = new TelegramClient(session, this.credentials.apiId, this.credentials.apiHash, {
        connectionRetries: 5,
      });

      await this.client.connect();

      // Verify we are authorized (have a valid session)
      const authorized = await this.client.isUserAuthorized();
      if (!authorized) {
        this.status = 'session_expired';
        throw new Error('Telegram session is not authorized. Please re-authenticate.');
      }

      this.status = 'connected';
    } catch (err) {
      if (this.status !== 'session_expired') {
        this.status = 'disconnected';
      }
      throw new MessengerError(
        'telegram',
        err,
        err instanceof Error ? err.message : 'Failed to connect to Telegram',
      );
    }
  }

  async disconnect(): Promise<void> {
    try {
      if (this.client) {
        await this.client.disconnect();
        this.client = null;
      }
      this.status = 'disconnected';
    } catch (err) {
      throw new MessengerError('telegram', err, 'Failed to disconnect from Telegram');
    }
  }

  async listChats(): Promise<Array<{ externalChatId: string; name: string; chatType: string }>> {
    this.ensureConnected();

    try {
      const dialogs = await this.client!.getDialogs({ limit: 500 });

      return dialogs.map((d) => {
        let chatType = 'direct';
        if (d.isGroup) chatType = 'group';
        else if (d.isChannel) chatType = 'channel';

        // Resolve name: groups/channels have title, users have firstName/lastName
        let chatName = d.title ?? d.name;
        if (!chatName && d.entity instanceof Api.User) {
          chatName = [d.entity.firstName, d.entity.lastName].filter(Boolean).join(' ');
        }

        return {
          externalChatId: d.id?.toString() ?? '',
          name: chatName || d.id?.toString() || 'Unknown',
          chatType,
        };
      });
    } catch (err) {
      throw new MessengerError('telegram', err, 'Failed to list Telegram chats');
    }
  }

  async sendMessage(
    externalChatId: string,
    text: string,
    options?: {
      replyToExternalId?: string;
      attachments?: Array<{ url: string; filename: string; mimeType: string; size: number }>;
    },
  ): Promise<{ externalMessageId: string }> {
    this.ensureConnected();

    try {
      const peer = await this.resolvePeer(externalChatId);
      const replyTo = options?.replyToExternalId ? parseInt(options.replyToExternalId, 10) : undefined;

      // Send attachments (if any). Supports multiple files of mixed types —
      // images go as photos, everything else as documents.
      if (options?.attachments && options.attachments.length > 0) {
        let firstMessageId: string | undefined;

        // Telegram media captions are capped at 1024 chars. If the text fits it
        // rides as the first attachment's caption; if it's longer it's sent as
        // its own message first (otherwise MEDIA_CAPTION_TOO_LONG drops the media).
        const TG_CAPTION_MAX = 1024;
        const useCaption = !!text && text.length <= TG_CAPTION_MAX;
        let sentSeparateText = false;
        if (text && !useCaption) {
          try {
            const tm = await this.client!.sendMessage(peer, { message: text, replyTo });
            firstMessageId = tm.id.toString();
            sentSeparateText = true;
          } catch (textErr) {
            console.warn(`[Telegram] Failed to send long text before attachments to ${externalChatId}:`, textErr instanceof Error ? textErr.message : textErr);
          }
        }

        for (let i = 0; i < options.attachments.length; i++) {
          const attachment = options.attachments[i];
          try {
            const fileUrl = attachment.url.startsWith('http')
              ? attachment.url
              : `${process.env.API_URL || process.env.APP_URL || 'http://localhost:3000'}${attachment.url}`;
            const response = await fetch(fileUrl);
            if (!response.ok) throw new Error(`Failed to download attachment: ${response.status}`);
            const buffer = Buffer.from(await response.arrayBuffer());

            // Ensure the file name carries an extension so Telegram detects the
            // media type. Images are sent as photos (viewable inline) rather
            // than as documents named "attachment" that can't be opened.
            const isImage = (attachment.mimeType || '').toLowerCase().startsWith('image/');
            const fileName = ensureFileExtension(attachment.filename, attachment.mimeType);
            const customFile = new CustomFile(fileName, buffer.length, '', buffer);

            const result = await this.client!.sendFile(peer, {
              file: customFile,
              // Caption only on the first file, and only when it fits.
              caption: i === 0 && useCaption ? text : '',
              replyTo: i === 0 && !sentSeparateText ? replyTo : undefined,
              forceDocument: !isImage,
            });

            if (!firstMessageId) {
              firstMessageId = result.id.toString();
            }
          } catch (fileErr) {
            console.warn(`[Telegram] Failed to send attachment "${attachment.filename}" to ${externalChatId}:`, fileErr instanceof Error ? fileErr.message : fileErr);
          }
        }

        // If nothing went out at all, fall back to text-only.
        if (!firstMessageId && text) {
          const result = await this.client!.sendMessage(peer, {
            message: text,
            replyTo,
          });
          return { externalMessageId: result.id.toString() };
        }

        if (firstMessageId) {
          return { externalMessageId: firstMessageId };
        }
      }

      // Text-only path
      const result = await this.client!.sendMessage(peer, {
        message: text,
        replyTo,
      });

      return { externalMessageId: result.id.toString() };
    } catch (err) {
      throw new MessengerError('telegram', err, 'Failed to send Telegram message');
    }
  }

  async editMessage(
    externalChatId: string,
    externalMessageId: string,
    newText: string,
  ): Promise<void> {
    this.ensureConnected();

    try {
      const peer = await this.resolvePeer(externalChatId);
      await this.client!.editMessage(peer, {
        message: parseInt(externalMessageId, 10),
        text: newText,
      });
    } catch (err) {
      throw new MessengerError('telegram', err, 'Failed to edit Telegram message');
    }
  }

  async deleteMessage(
    externalChatId: string,
    externalMessageId: string,
  ): Promise<void> {
    this.ensureConnected();

    try {
      const peer = await this.resolvePeer(externalChatId);
      await this.client!.deleteMessages(peer, [parseInt(externalMessageId, 10)], {
        revoke: true,
      });
    } catch (err) {
      throw new MessengerError('telegram', err, 'Failed to delete Telegram message');
    }
  }

  /**
   * Fetch message history from a chat with cursor-based pagination.
   * Returns messages oldest-first.
   */
  async getMessages(
    externalChatId: string,
    limit = 100,
    cursor?: string,
  ): Promise<GetMessagesResult> {
    this.ensureConnected();

    try {
      const peer = await this.resolvePeer(externalChatId);
      const params: Record<string, unknown> = { limit };

      // cursor is the offsetId (oldest message ID from previous batch)
      if (cursor) {
        params.offsetId = parseInt(cursor, 10);
      }

      const rawMessages = await this.client!.getMessages(peer, params);

      const messages: HistoryMessage[] = rawMessages
        .filter((m) => m.id !== undefined)
        .map((m) => ({
          id: m.id.toString(),
          text: m.text || '',
          senderId: m.senderId ? m.senderId.toString() : '',
          date: new Date((m.date ?? 0) * 1000),
          isSelf: m.out ?? false,
        }))
        .reverse(); // oldest first

      // Determine next cursor: the oldest message ID in this batch
      const oldestId = rawMessages.length > 0
        ? rawMessages.reduce((min, m) => (m.id !== undefined && m.id < min ? m.id : min), rawMessages[0]!.id)
        : undefined;

      return {
        messages,
        nextCursor: oldestId !== undefined ? oldestId.toString() : undefined,
        hasMore: rawMessages.length >= limit,
      };
    } catch (err) {
      throw new MessengerError('telegram', err, 'Failed to get Telegram messages');
    }
  }

  /**
   * Get the currently authenticated user's info.
   */
  async getMe(): Promise<{ id: string; firstName: string; lastName: string }> {
    this.ensureConnected();
    const me = await this.client!.getMe() as Api.User;
    return {
      id: me.id.toString(),
      firstName: me.firstName ?? '',
      lastName: me.lastName ?? '',
    };
  }

  /**
   * Resolve a sender ID to a display name.
   */
  async getSenderName(senderId: string): Promise<string> {
    this.ensureConnected();
    try {
      const numId = parseInt(senderId, 10);
      if (isNaN(numId)) return 'Unknown';
      const entity = await this.client!.getEntity(numId);
      if (entity instanceof Api.User) {
        return [entity.firstName, entity.lastName].filter(Boolean).join(' ') || 'Unknown';
      }
      if ('title' in entity) {
        return (entity as { title: string }).title || 'Unknown';
      }
      return 'Unknown';
    } catch {
      return 'Unknown';
    }
  }

  getStatus(): 'connected' | 'disconnected' | 'token_expired' | 'session_expired' {
    return this.status;
  }

  /** Get the underlying TelegramClient (for advanced operations). */
  getClient(): TelegramClient | null {
    return this.client;
  }

  private ensureConnected(): void {
    if (this.status !== 'connected' || !this.client) {
      throw new MessengerError('telegram', null, 'Telegram adapter is not connected');
    }
  }

  /**
   * Resolve a chat ID to a Telegram peer entity.
   * Handles numeric IDs (users, groups, channels).
   */
  private async resolvePeer(externalChatId: string): Promise<Api.TypeEntityLike> {
    const numId = parseInt(externalChatId, 10);
    if (!isNaN(numId)) {
      return numId;
    }
    // If it's a username or other string format, try to resolve it
    return externalChatId;
  }
}

// ─── Helper: create a fresh TelegramClient for auth flow ───

export function createAuthClient(apiId: number, apiHash: string): TelegramClient {
  const session = new StringSession('');
  return new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
  });
}
