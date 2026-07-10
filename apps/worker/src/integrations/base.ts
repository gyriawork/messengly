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

  /** Send a message (with optional attachments) to a chat. Returns the external message ID. */
  sendMessage(
    externalChatId: string,
    text: string,
    options?: {
      replyToExternalId?: string;
      attachments?: Array<{
        url: string;
        filename: string;
        mimeType: string;
        size: number;
      }>;
    },
  ): Promise<{ externalMessageId: string }>;

  /** Edit an existing message. */
  editMessage(externalChatId: string, externalMessageId: string, newText: string): Promise<void>;

  /** Delete an existing message. */
  deleteMessage(externalChatId: string, externalMessageId: string): Promise<void>;

  /** Get the current connection status. */
  getStatus(): 'connected' | 'disconnected' | 'token_expired' | 'session_expired';

  /** Fetch message history from a chat with pagination. Returns messages oldest-first. */
  getMessages?(
    externalChatId: string,
    limit: number,
    cursor?: string,
  ): Promise<GetMessagesResult>;
}

/** Standard message shape returned by getMessages */
export interface HistoryMessage {
  id: string;
  text: string;
  senderId: string;
  senderName?: string;
  date: Date;
  isSelf: boolean;
  // Email-specific fields (populated by Gmail adapter). Undefined for other messengers.
  subject?: string;
  htmlBody?: string;
  plainBody?: string;
  fromEmail?: string;
  toEmails?: string[];
  ccEmails?: string[];
  bccEmails?: string[];
  inReplyTo?: string;
}

/** Result of a paginated getMessages call */
export interface GetMessagesResult {
  messages: HistoryMessage[];
  nextCursor?: string;
  hasMore: boolean;
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
