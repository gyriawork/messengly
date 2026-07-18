export type MessengerType = 'telegram' | 'slack' | 'whatsapp' | 'gmail' | 'teams';

// 'unknown' = the messenger couldn't determine the type (currently only Teams,
// via DOM detection); rendered as "—" rather than guessed.
export type ChatType = 'direct' | 'group' | 'channel' | 'unknown';

export interface Chat {
  id: string;
  name: string;
  messenger: MessengerType;
  chatType: ChatType;
  status: string;
  ownerId?: string;
  ownerName?: string;
  messageCount: number;
  syncStatus?: string; // pending | syncing | synced | failed
  hasFullHistory?: boolean;
  createdAt?: string;
  lastActivityAt?: string;
  externalChatId?: string;
  importedByName?: string;
  participants?: Array<{
    id: string;
    name: string;
    role?: string;
  }>;
  lastMessage?: {
    text: string;
    senderName: string;
    createdAt: string;
    fromEmail?: string | null; // Gmail only — used for sender-domain grouping
  };
  tags?: Array<{
    id: string;
    name: string;
    color: string;
  }>;
  preferences?: {
    pinned: boolean;
    favorite: boolean;
    muted: boolean;
    unread: boolean;
  };
}

export interface Message {
  id: string;
  chatId: string;
  senderName: string;
  isSelf: boolean;
  text: string;
  editedAt?: string;
  replyToMessage?: {
    id: string;
    senderName: string;
    text: string;
  };
  reactions?: Array<{
    id: string;
    emoji: string;
    userId: string;
  }>;
  isPinned: boolean;
  deliveryStatus?: string;
  attachments?: Array<{
    url: string;
    filename: string;
    mimeType: string;
    size: number;
  }>;
  createdAt: string;
  // Email-specific fields (Gmail). Undefined/null for other messengers.
  subject?: string | null;
  htmlBody?: string | null;
  plainBody?: string | null;
  fromEmail?: string | null;
  toEmails?: string[];
  ccEmails?: string[];
  bccEmails?: string[];
  inReplyTo?: string | null;
}

export interface ChatFilters {
  search?: string;
  messenger?: MessengerType | null;
  status?: string;
  owner?: string;
  /** Filter to chats linked (ChatOwner) to this user id — Task 10's owner dropdown. */
  ownerId?: string;
  tagId?: string;
  limit?: number;
}
