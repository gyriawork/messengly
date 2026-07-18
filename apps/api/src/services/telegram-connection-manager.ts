// ─── Telegram Connection Manager ───
// Maintains persistent gramjs client connections for all connected Telegram
// integrations. Registers NewMessage event handlers so incoming messages
// are saved and pushed to the frontend in real time.

import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage, type NewMessageEvent, Raw } from 'telegram/events/index.js';
import prisma from '../lib/prisma.js';
import { decryptCredentials } from '../lib/crypto.js';
import { getPlatformCredentials } from '../lib/platform-credentials.js';
import {
  saveIncomingMessage,
  ingestReaction,
  type StructuredAttachment,
} from './message-service.js';
import { uploadFile } from '../lib/storage.js';

interface ActiveClient {
  client: TelegramClient;
  integrationId: string;
  organizationId: string;
  userId: string;
  selfId: string; // stored as string for safe comparison
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAYS = [5_000, 10_000, 30_000, 60_000, 60_000];

// Concurrency + per-chat message cap for the post-connect catch-up sweep.
const CATCHUP_CONCURRENCY = 3;
const CATCHUP_MESSAGES_PER_CHAT = 50;

// ─── Singleton ───

let manager: TelegramConnectionManager | null = null;

export function getTelegramManager(): TelegramConnectionManager {
  if (!manager) {
    manager = new TelegramConnectionManager();
  }
  return manager;
}

// ─── Helpers ───

function extractChatId(peerId: Api.TypePeer): string {
  if (peerId instanceof Api.PeerUser) {
    return peerId.userId.toString();
  }
  if (peerId instanceof Api.PeerChat) {
    return (-Number(peerId.chatId)).toString();
  }
  if (peerId instanceof Api.PeerChannel) {
    // Channels use -100 prefix convention
    return `-100${peerId.channelId.toString()}`;
  }
  return '';
}

/** Resolve an externalChatId string back into the number/peer gramjs expects. */
function parsePeer(externalChatId: string): number | string {
  const n = parseInt(externalChatId, 10);
  return Number.isFinite(n) ? n : externalChatId;
}

/** Simple bounded-concurrency runner so we don't hammer Telegram during catch-up. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = index++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Describe the media attached to a Telegram message for preview + download. */
interface TelegramMediaDescriptor {
  previewText: string;
  /** If null, we can't/don't download this media (polls, locations, contacts). */
  filename: string | null;
  mimeType: string;
}

function describeMedia(msg: Api.Message): TelegramMediaDescriptor | null {
  if (!msg.media) return null;

  if (msg.media instanceof Api.MessageMediaPhoto) {
    return {
      previewText: '📷 Photo',
      filename: `photo_${msg.id}.jpg`,
      mimeType: 'image/jpeg',
    };
  }

  if (msg.media instanceof Api.MessageMediaDocument) {
    const doc = msg.media.document;
    if (!(doc instanceof Api.Document)) {
      return { previewText: '📎 Attachment', filename: null, mimeType: '' };
    }
    const attrs = doc.attributes || [];
    const fileNameAttr = attrs.find(
      (a: Api.TypeDocumentAttribute): a is Api.DocumentAttributeFilename =>
        a instanceof Api.DocumentAttributeFilename,
    );
    const isSticker = attrs.some((a) => a instanceof Api.DocumentAttributeSticker);
    const isAnimated = attrs.some((a) => a instanceof Api.DocumentAttributeAnimated);
    const videoAttr = attrs.find(
      (a: Api.TypeDocumentAttribute): a is Api.DocumentAttributeVideo =>
        a instanceof Api.DocumentAttributeVideo,
    );
    const audioAttr = attrs.find(
      (a: Api.TypeDocumentAttribute): a is Api.DocumentAttributeAudio =>
        a instanceof Api.DocumentAttributeAudio,
    );

    const mimeType = doc.mimeType || 'application/octet-stream';
    const baseName = fileNameAttr?.fileName;

    if (isSticker) {
      return {
        previewText: '🏷 Sticker',
        filename: baseName ?? `sticker_${msg.id}.webp`,
        mimeType,
      };
    }
    if (isAnimated || mimeType === 'image/gif') {
      return {
        previewText: 'GIF',
        filename: baseName ?? `gif_${msg.id}.gif`,
        mimeType,
      };
    }
    if (videoAttr) {
      const isRound = videoAttr.roundMessage;
      return {
        previewText: isRound ? '🎥 Video message' : '🎬 Video',
        filename: baseName ?? `video_${msg.id}.mp4`,
        mimeType,
      };
    }
    if (audioAttr) {
      const isVoice = audioAttr.voice;
      return {
        previewText: isVoice ? '🎤 Voice message' : '🎵 Audio',
        filename: baseName ?? (isVoice ? `voice_${msg.id}.ogg` : `audio_${msg.id}.mp3`),
        mimeType,
      };
    }
    return {
      previewText: '📎 File',
      filename: baseName ?? `file_${msg.id}`,
      mimeType,
    };
  }

  if (
    msg.media instanceof Api.MessageMediaGeo ||
    msg.media instanceof Api.MessageMediaGeoLive
  ) {
    return { previewText: '📍 Location', filename: null, mimeType: '' };
  }
  if (msg.media instanceof Api.MessageMediaContact) {
    return { previewText: '👤 Contact', filename: null, mimeType: '' };
  }
  if (msg.media instanceof Api.MessageMediaPoll) {
    return { previewText: '📊 Poll', filename: null, mimeType: '' };
  }
  return { previewText: '📎 Attachment', filename: null, mimeType: '' };
}

// ─── Manager ───

// The persistent inbound listener is disabled by default. This is a
// broadcast-only product (no inbox), so we don't need to receive messages — and
// keeping a 24/7 client connected with the same session string conflicts with
// the on-demand send/import clients (two connections sharing one auth key),
// which makes Telegram invalidate the session within minutes. Using the session
// only on-demand (sequentially) keeps it alive for a long time. Set
// TELEGRAM_LISTENER_ENABLED=true to re-enable the persistent listener.
const LISTENER_ENABLED = process.env.TELEGRAM_LISTENER_ENABLED === 'true';

export class TelegramConnectionManager {
  private clients = new Map<string, ActiveClient>();
  private senderNameCache = new Map<string, { name: string; expiry: number }>();

  /**
   * On API startup, connect all Telegram integrations that are marked as connected.
   */
  async startAll(): Promise<void> {
    if (!LISTENER_ENABLED) {
      console.log('[TelegramManager] Persistent listener disabled (broadcast-only mode) — sessions are used on-demand only');
      return;
    }

    const integrations = await prisma.integration.findMany({
      where: { messenger: 'telegram', status: 'connected' },
      select: { id: true },
    });

    console.log(`[TelegramManager] Starting listeners for ${integrations.length} integration(s)`);

    for (const integration of integrations) {
      try {
        await this.startListening(integration.id);
      } catch (err) {
        console.error(`[TelegramManager] Failed to start listener for integration ${integration.id}:`, err);
      }
    }
  }

  /**
   * Start listening for messages on a specific integration.
   */
  async startListening(integrationId: string): Promise<void> {
    // Disabled in broadcast-only mode — see LISTENER_ENABLED above. The session
    // stays valid because nothing holds a persistent connection to it.
    if (!LISTENER_ENABLED) return;

    // If a client is already registered for this integration (e.g. credentials
    // were just rotated by a connect/reconnect flow), stop it first so the new
    // session can take over. Otherwise messages from the old session keep
    // flowing because the old TelegramClient is still connected.
    if (this.clients.has(integrationId)) {
      await this.stopListening(integrationId);
    }

    const integration = await prisma.integration.findUnique({
      where: { id: integrationId },
      select: { id: true, credentials: true, organizationId: true, userId: true, messenger: true },
    });

    if (!integration || integration.messenger !== 'telegram') {
      return;
    }

    // User-level credentials: session + phone. apiId/apiHash live in
    // PlatformConfig (or env fallback) so they can be rotated centrally.
    let credentials: { session?: string; phoneNumber?: string };
    try {
      credentials = decryptCredentials(integration.credentials as string);
    } catch (err) {
      console.error(`[TelegramManager] Failed to decrypt credentials for ${integrationId}:`, err);
      return;
    }

    if (!credentials.session) {
      console.warn(`[TelegramManager] Missing session for ${integrationId}, skipping`);
      return;
    }

    const platform = await getPlatformCredentials('telegram', integration.organizationId);
    const apiIdRaw = platform.credentials?.apiId;
    const apiHash = platform.credentials?.apiHash;
    if (!apiIdRaw || !apiHash) {
      console.warn(
        `[TelegramManager] Platform apiId/apiHash not configured — cannot start ${integrationId}`,
      );
      return;
    }
    const apiId = Number(apiIdRaw);
    if (!Number.isFinite(apiId) || apiId <= 0) {
      console.warn(`[TelegramManager] Invalid platform apiId for ${integrationId}`);
      return;
    }

    const session = new StringSession(credentials.session);
    const client = new TelegramClient(session, apiId, apiHash, {
      connectionRetries: 10,
      retryDelay: 2000,
      autoReconnect: true,
      timeout: 30,
    });

    try {
      await client.connect();

      const authorized = await client.isUserAuthorized();
      if (!authorized) {
        console.warn(`[TelegramManager] Session expired for ${integrationId}`);
        await prisma.integration.update({
          where: { id: integrationId },
          data: { status: 'session_expired' },
        });
        await client.disconnect().catch(() => {});
        return;
      }

      // Get self user ID to distinguish own messages
      const me = await client.getMe() as Api.User;
      const selfId = me.id.toString();

      const activeClient: ActiveClient = {
        client,
        integrationId,
        organizationId: integration.organizationId,
        userId: integration.userId,
        selfId,
        reconnectAttempts: 0,
        reconnectTimer: null,
      };

      // Register NewMessage event handler
      client.addEventHandler(
        (event: NewMessageEvent) => this.handleNewMessage(event, activeClient),
        new NewMessage({}),
      );

      // Register UpdateMessageReactions event handler for incoming reactions
      client.addEventHandler(
        (update: Api.TypeUpdate) => this.handleReactionUpdate(update, activeClient),
        new Raw({ types: [Api.UpdateMessageReactions] }),
      );

      // Monitor disconnections — log for diagnostics
      client.addEventHandler((update: Api.TypeUpdate) => {
        const name = (update as unknown as { className?: string }).className;
        if (name && name.includes('ConnectionState')) {
          console.warn(`[TelegramManager] Connection state change for ${integrationId}:`, name);
        }
      });

      this.clients.set(integrationId, activeClient);
      console.log(`[TelegramManager] Listening on integration ${integrationId} (selfId: ${selfId})`);

      // Fire-and-forget catch-up sweep — don't block startup on network.
      // Fixes the case where messages arriving during a restart / account
      // switch never reach us via NewMessage and would otherwise be lost.
      this.runCatchup(activeClient).catch((err) => {
        console.error(`[TelegramManager] Catch-up failed for ${integrationId}:`, err);
      });
    } catch (err) {
      console.error(`[TelegramManager] Failed to connect for ${integrationId}:`, err);
      await client.disconnect().catch(() => {});
    }
  }

  /**
   * Stop listening for messages on a specific integration.
   */
  async stopListening(integrationId: string): Promise<void> {
    const active = this.clients.get(integrationId);
    if (!active) return;

    if (active.reconnectTimer) {
      clearTimeout(active.reconnectTimer);
    }

    try {
      await active.client.disconnect();
    } catch {
      // Non-critical
    }

    this.clients.delete(integrationId);
    console.log(`[TelegramManager] Stopped listening on integration ${integrationId}`);
  }

  /**
   * Shutdown all connections (for graceful server stop).
   */
  async shutdown(): Promise<void> {
    console.log(`[TelegramManager] Shutting down ${this.clients.size} connection(s)`);
    const promises: Promise<void>[] = [];
    for (const [id] of this.clients) {
      promises.push(this.stopListening(id));
    }
    await Promise.allSettled(promises);
  }

  /**
   * Get the active TelegramClient for an integration (if connected).
   * Used by the messages route to send messages via the persistent connection
   * instead of creating a conflicting second session.
   */
  getClient(integrationId: string): TelegramClient | null {
    const active = this.clients.get(integrationId);
    return active?.client ?? null;
  }

  // ─── Event handler ───

  private async handleNewMessage(
    event: NewMessageEvent,
    active: ActiveClient,
  ): Promise<void> {
    try {
      if (!event.message) return;
      await this.ingestMessage(event.message, active);
    } catch (err) {
      console.error('[TelegramManager] Error handling incoming message:', err);
    }
  }

  /**
   * Shared ingestion path used by both live events (handleNewMessage) and the
   * post-connect catch-up sweep (runCatchup). Idempotent — duplicate messages
   * are dropped by saveIncomingMessage via the (chatId, externalMessageId)
   * unique constraint.
   */
  private async ingestMessage(msg: Api.Message, active: ActiveClient): Promise<void> {
    if (!msg.peerId) return;

    const externalChatId = extractChatId(msg.peerId);
    if (!externalChatId) return;

    const externalMessageId = msg.id.toString();
    const senderId = msg.senderId ? msg.senderId.toString() : '';
    const isSelf = senderId === active.selfId;

    // Preview text + optional download descriptor.
    const mediaInfo = describeMedia(msg);
    let text = msg.text || '';
    if (!text && mediaInfo) text = mediaInfo.previewText;

    // Attempt to download media and persist it as a real Attachment. Wrap
    // separately so a download failure doesn't lose the text of the message.
    let attachments: StructuredAttachment[] | undefined;
    if (mediaInfo && mediaInfo.filename) {
      try {
        const buffer = (await active.client.downloadMedia(msg, {})) as Buffer | null;
        if (buffer && buffer.length > 0) {
          const uploaded = await uploadFile(
            buffer,
            mediaInfo.filename,
            mediaInfo.mimeType || 'application/octet-stream',
            active.organizationId,
          );
          attachments = [
            {
              url: uploaded.url,
              filename: mediaInfo.filename,
              mimeType: mediaInfo.mimeType || uploaded.mimeType,
              size: uploaded.size,
            },
          ];
        }
      } catch (err) {
        console.error(
          `[TelegramManager] Failed to download media for message ${externalMessageId}:`,
          err,
        );
      }
    }

    // Resolve sender name — multiple strategies, ordered by cost/reliability.
    const senderName = await this.resolveSenderName(msg, senderId, active);

    // Resolve chat display name — prefer the chat entity's title for groups/channels.
    let chatName = senderName;
    let chatType: 'direct' | 'group' | 'channel' = 'direct';
    if (msg.peerId instanceof Api.PeerChat || msg.peerId instanceof Api.PeerChannel) {
      chatType = msg.peerId instanceof Api.PeerChannel ? 'channel' : 'group';
      try {
        const chatEntity = await Promise.race([
          active.client.getEntity(msg.peerId),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), 3000),
          ),
        ]);
        if (chatEntity && 'title' in (chatEntity as unknown as Record<string, unknown>)) {
          chatName = (chatEntity as unknown as { title: string }).title || senderName;
        }
      } catch {
        // fallback to senderName
      }
    }

    console.log(
      `[TelegramManager] ingest integration=${active.integrationId} chat=${externalChatId} msg=${externalMessageId} self=${isSelf} media=${mediaInfo?.previewText ?? 'none'} len=${text.length}`,
    );

    await saveIncomingMessage({
      externalChatId,
      messenger: 'telegram',
      organizationId: active.organizationId,
      importedById: active.userId,
      senderName,
      senderExternalId: senderId,
      text,
      externalMessageId,
      isSelf,
      chatName,
      chatType,
      attachments,
      createdAt: msg.date ? new Date(msg.date * 1000) : undefined,
    });
  }

  private async resolveSenderName(
    msg: Api.Message,
    senderId: string,
    active: ActiveClient,
  ): Promise<string> {
    if (!msg.senderId) return 'Unknown';

    const cached = this.senderNameCache.get(senderId);
    if (cached && cached.expiry > Date.now()) {
      return cached.name;
    }

    let senderName = 'Unknown';

    // Strategy 1: Use _sender from the update payload (no network call)
    const inlineSender = (msg as unknown as {
      _sender?: Api.TypeUser | { title?: string };
    })._sender;
    if (inlineSender) {
      if (inlineSender instanceof Api.User) {
        senderName =
          [inlineSender.firstName, inlineSender.lastName].filter(Boolean).join(' ') ||
          'Unknown';
      } else if ('title' in inlineSender && inlineSender.title) {
        senderName = inlineSender.title;
      }
    }

    // Strategy 2: If _sender didn't resolve, try getSender() then getEntity()
    if (senderName === 'Unknown') {
      try {
        let entity: Api.TypeUser | { title?: string } | undefined;
        try {
          entity = (await Promise.race([
            (msg as unknown as {
              getSender: () => Promise<Api.TypeUser | undefined>;
            }).getSender(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('timeout')), 5000),
            ),
          ])) as Api.TypeUser | { title?: string } | undefined;
        } catch {
          // Fall through to getEntity
        }
        if (!entity) {
          entity = (await Promise.race([
            active.client.getEntity(msg.senderId),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('timeout')), 10000),
            ),
          ])) as Api.TypeUser | { title?: string } | undefined;
        }
        if (entity) {
          if (entity instanceof Api.User) {
            senderName =
              [entity.firstName, entity.lastName].filter(Boolean).join(' ') || 'Unknown';
          } else if ('title' in entity && entity.title) {
            senderName = entity.title;
          }
        }
      } catch {
        if (cached) senderName = cached.name;
      }
    }

    // Cache resolved name (10 min for real names, skip caching Unknown)
    if (senderName !== 'Unknown') {
      this.senderNameCache.set(senderId, {
        name: senderName,
        expiry: Date.now() + 600_000,
      });
    } else if (cached) {
      senderName = cached.name;
    }

    return senderName;
  }

  /**
   * Post-connect catch-up: for every Telegram chat we know about, fetch the
   * last N messages and ingest anything newer than lastActivityAt. Dedup is
   * enforced by saveIncomingMessage's unique constraint, so re-ingesting known
   * messages is a no-op.
   *
   * Runs in the background; does not block the listener startup.
   */
  private async runCatchup(active: ActiveClient): Promise<void> {
    const started = Date.now();
    const chats = await prisma.chat.findMany({
      where: {
        organizationId: active.organizationId,
        messenger: 'telegram',
        deletedAt: null,
      },
      select: { id: true, externalChatId: true, lastActivityAt: true },
    });

    if (chats.length === 0) {
      console.log(
        `[TelegramManager] catch-up: integration=${active.integrationId} no chats to sweep`,
      );
      return;
    }

    let totalNew = 0;
    const results = await mapWithConcurrency(chats, CATCHUP_CONCURRENCY, async (chat) => {
      try {
        const peer = parsePeer(chat.externalChatId);
        const messages = await active.client.getMessages(peer, {
          limit: CATCHUP_MESSAGES_PER_CHAT,
        });

        // Iterate oldest → newest so DB order matches real order.
        const ordered = [...messages].reverse();
        const lastActivityMs = chat.lastActivityAt
          ? new Date(chat.lastActivityAt).getTime()
          : 0;

        let newInThisChat = 0;
        for (const m of ordered) {
          if (!m || m.id === undefined) continue;
          // If we already have a cached lastActivity, skip anything older — the
          // unique constraint would drop them anyway but skipping saves work.
          const msgMs = (m.date ?? 0) * 1000;
          if (lastActivityMs > 0 && msgMs <= lastActivityMs) continue;
          await this.ingestMessage(m, active);
          newInThisChat += 1;
        }
        return newInThisChat;
      } catch (err) {
        console.error(
          `[TelegramManager] catch-up error for chat ${chat.externalChatId}:`,
          err,
        );
        return 0;
      }
    });

    totalNew = results.reduce((a, b) => a + b, 0);
    console.log(
      `[TelegramManager] catch-up: integration=${active.integrationId} chats=${chats.length} newMessages=${totalNew} durationMs=${Date.now() - started}`,
    );
  }

  private async handleReactionUpdate(update: Api.TypeUpdate, active: ActiveClient): Promise<void> {
    try {
      if (!(update instanceof Api.UpdateMessageReactions)) return;

      const msgId = update.msgId.toString();
      const peerId = update.peer;
      const externalChatId = extractChatId(peerId);
      if (!externalChatId) return;

      const reactions = update.reactions;
      if (!reactions) return;

      // Telegram sends current state, not diffs. Diff against DB to detect adds and removes.
      const recentReactions = reactions.recentReactions ?? [];

      // Build set of current reactions from the update
      const incomingReactions = new Map<string, string[]>(); // senderId -> emoji[]
      for (const recent of recentReactions) {
        if (!(recent.reaction instanceof Api.ReactionEmoji)) continue;
        const senderId = recent.peerId instanceof Api.PeerUser
          ? recent.peerId.userId.toString()
          : '';
        if (!senderId || senderId === active.selfId) continue;

        if (!incomingReactions.has(senderId)) incomingReactions.set(senderId, []);
        incomingReactions.get(senderId)!.push(recent.reaction.emoticon);
      }

      // For each external user in the update, diff against DB
      for (const [senderId, emojis] of incomingReactions) {
        const existing = await prisma.reaction.findMany({
          where: {
            message: { externalMessageId: msgId },
            externalUserId: senderId,
          },
          select: { emoji: true },
        });
        const existingEmojis = new Set(existing.map((r) => r.emoji));
        const incomingEmojis = new Set(emojis);

        // Add new reactions
        for (const emoji of incomingEmojis) {
          if (!existingEmojis.has(emoji)) {
            await ingestReaction({
              externalMessageId: msgId,
              messenger: 'telegram',
              externalUserId: senderId,
              emoji,
              action: 'add',
            });
          }
        }

        // Remove reactions no longer present
        for (const emoji of existingEmojis) {
          if (!incomingEmojis.has(emoji)) {
            await ingestReaction({
              externalMessageId: msgId,
              messenger: 'telegram',
              externalUserId: senderId,
              emoji,
              action: 'remove',
            });
          }
        }
      }
    } catch (err) {
      console.error('[TelegramManager] Error handling reaction update:', err);
    }
  }

  // ─── Reconnection (can be called if disconnect detected) ───

  private scheduleReconnect(integrationId: string): void {
    const active = this.clients.get(integrationId);
    if (!active) return;

    if (active.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error(`[TelegramManager] Max reconnect attempts reached for ${integrationId}, marking disconnected`);
      this.clients.delete(integrationId);
      prisma.integration.update({
        where: { id: integrationId },
        data: { status: 'disconnected' },
      }).catch(() => {});
      return;
    }

    const delay = RECONNECT_DELAYS[active.reconnectAttempts] ?? 60_000;
    active.reconnectAttempts++;

    console.log(`[TelegramManager] Reconnecting ${integrationId} in ${delay}ms (attempt ${active.reconnectAttempts})`);

    active.reconnectTimer = setTimeout(async () => {
      this.clients.delete(integrationId);
      try {
        await this.startListening(integrationId);
      } catch (err) {
        console.error(`[TelegramManager] Reconnect failed for ${integrationId}:`, err);
        this.scheduleReconnect(integrationId);
      }
    }, delay);
  }
}
