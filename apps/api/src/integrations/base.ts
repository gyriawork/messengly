// ─── Messenger Adapter Interface ───
// All messenger adapters must implement this interface to provide
// a unified API for chat listing, message sending, editing, and deletion.

export interface MessengerAdapter {
  /** Establish connection. Credentials are passed in the constructor; this param allows overrides. */
  connect(credentials?: Record<string, unknown>): Promise<void>;

  /** Gracefully disconnect from the messenger. */
  disconnect(): Promise<void>;

  /** List available chats/conversations from the messenger. */
  listChats(): Promise<Array<{ externalChatId: string; name: string; chatType: string }>>;

  /** Send a text message to a chat. Returns the external message ID. */
  sendMessage(
    externalChatId: string,
    text: string,
    options?: {
      replyToExternalId?: string;
      attachments?: Array<{ url: string; filename: string; mimeType: string }>;
    },
  ): Promise<{ externalMessageId: string }>;

  /** Edit an existing message. */
  editMessage(externalChatId: string, externalMessageId: string, newText: string): Promise<void>;

  /** Delete an existing message. */
  deleteMessage(externalChatId: string, externalMessageId: string): Promise<void>;

  /** Add an emoji reaction to a message. Optional — not all messengers support reactions. */
  addReaction?(externalChatId: string, externalMessageId: string, emoji: string): Promise<void>;

  /** Remove an emoji reaction. options.remainingEmoji used by Telegram (replace-all semantics). */
  removeReaction?(externalChatId: string, externalMessageId: string, emoji: string, options?: { remainingEmoji?: string[] }): Promise<void>;

  /** Get the current connection status. */
  getStatus(): 'connected' | 'disconnected' | 'token_expired' | 'session_expired';

  /**
   * Human-readable identity of the connected account (e.g. the person's name /
   * workspace), for showing "importing from X" in the wizard. Optional — an
   * adapter that can't determine it returns null (or omits the method).
   */
  getAccountIdentity?(): Promise<{ name: string; handle?: string } | null>;
}

/** Typed error for messenger adapter failures. */
/**
 * What the broadcast worker should do when a send fails.
 *
 * `retry`    transient — the chat can be retried later. The default, so adapters
 *            that say nothing keep their existing behaviour.
 * `no_retry` permanent for this message. Retrying repeats the same failure, and
 *            for an unverified send it would duplicate a message that may already
 *            have arrived.
 * `skip`     the chat itself is the problem (gone, ambiguous). Not a delivery
 *            failure, so it does not count against the recipient's stats.
 * `halt`     stop sending through this messenger entirely; the remaining chats in
 *            the batch are skipped. Used for an expired session or a run of
 *            consecutive failures, where continuing only makes things worse.
 */
export type SendFailurePolicy = 'retry' | 'no_retry' | 'skip' | 'halt';

export class MessengerError extends Error {
  constructor(
    public messenger: string,
    public originalError: unknown,
    message?: string,
    public policy: SendFailurePolicy = 'retry',
  ) {
    super(message ?? `${messenger} adapter error`);
    this.name = 'MessengerError';
  }
}
