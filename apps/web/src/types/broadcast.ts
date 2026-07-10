export type BroadcastStatus =
  | 'draft'
  | 'scheduled'
  | 'sending'
  | 'sent'
  | 'partially_failed'
  | 'failed';

export interface Broadcast {
  id: string;
  name: string;
  messageText: string;
  attachments?: BroadcastAttachment[];
  status: BroadcastStatus;
  scheduledAt?: string;
  sentAt?: string;
  deliveryRate?: number;
  createdById: string;
  templateId?: string;
  createdAt: string;
  chatCount?: number;
  sentCount?: number;
  failedCount?: number;
  chats?: BroadcastChat[];
}

export interface BroadcastChat {
  chatId: string;
  chatName: string;
  messenger: string;
  /**
   * `skipped` means the chat was never attempted — it had gone missing, or the
   * messenger halted mid-batch (expired session, five consecutive failures).
   * `retry_exhausted` is terminal: retrying would duplicate or repeat.
   */
  status: 'pending' | 'sent' | 'failed' | 'skipped' | 'retrying' | 'retry_exhausted';
  sentAt?: string;
  error?: string;
}

export interface AntibanSettings {
  id?: string;
  messenger: string;
  messagesPerBatch: number;
  delayBetweenMessages: number;
  delayBetweenBatches: number;
  maxMessagesPerHour: number;
  maxMessagesPerDay: number;
  autoRetryEnabled: boolean;
  maxRetryAttempts: number;
  retryWindowHours: number;
}

export interface RiskScore {
  score: number;
  zone: 'safe' | 'moderate' | 'risky' | 'dangerous';
  description: string;
}

export interface BroadcastFilters {
  status?: BroadcastStatus | null;
  search?: string;
}

export interface BroadcastAnalytics {
  totalSent: number;
  totalFailed: number;
  total: number;
  deliveryRate: number;
  perMessenger: Record<string, {
    sent: number;
    failed: number;
    total: number;
    deliveryRate: number;
  }>;
  dailyCounts: Array<{ date: string; sent: number; failed: number }>;
}

export interface BroadcastAttachment {
  url: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface CreateBroadcastInput {
  name: string;
  messageText: string;
  chatIds: string[];
  scheduledAt?: string;
  templateId?: string;
  attachments?: BroadcastAttachment[];
}

export interface UpdateBroadcastInput {
  name?: string;
  messageText?: string;
  chatIds?: string[];
  scheduledAt?: string;
  templateId?: string;
  attachments?: BroadcastAttachment[];
}

// ─── Safe presets — conservative, match API defaults, low ban risk ───
export const ANTIBAN_SAFE_PRESETS: Record<string, AntibanSettings> = {
  telegram: {
    messenger: 'telegram',
    messagesPerBatch: 10,
    delayBetweenMessages: 5,
    delayBetweenBatches: 180,
    maxMessagesPerHour: 50,
    maxMessagesPerDay: 300,
    autoRetryEnabled: true,
    maxRetryAttempts: 3,
    retryWindowHours: 6,
  },
  slack: {
    messenger: 'slack',
    messagesPerBatch: 20,
    delayBetweenMessages: 2,
    delayBetweenBatches: 60,
    maxMessagesPerHour: 100,
    maxMessagesPerDay: 1000,
    autoRetryEnabled: true,
    maxRetryAttempts: 3,
    retryWindowHours: 6,
  },
  whatsapp: {
    messenger: 'whatsapp',
    messagesPerBatch: 3,
    delayBetweenMessages: 15,
    delayBetweenBatches: 600,
    maxMessagesPerHour: 20,
    maxMessagesPerDay: 80,
    autoRetryEnabled: true,
    maxRetryAttempts: 3,
    retryWindowHours: 6,
  },
  gmail: {
    messenger: 'gmail',
    messagesPerBatch: 5,
    delayBetweenMessages: 8,
    delayBetweenBatches: 180,
    maxMessagesPerHour: 30,
    maxMessagesPerDay: 200,
    autoRetryEnabled: true,
    maxRetryAttempts: 3,
    retryWindowHours: 6,
  },
  // Teams is driven through a real browser, so every send costs seconds. The
  // agent also adds 3–10s of random jitter on top of these delays.
  teams: {
    messenger: 'teams',
    messagesPerBatch: 5,
    delayBetweenMessages: 8,
    delayBetweenBatches: 300,
    maxMessagesPerHour: 40,
    maxMessagesPerDay: 200,
    autoRetryEnabled: true,
    maxRetryAttempts: 3,
    retryWindowHours: 6,
  },
};

// ─── Moderate presets — balanced speed vs safety ───
export const ANTIBAN_MODERATE_PRESETS: Record<string, AntibanSettings> = {
  telegram: {
    messenger: 'telegram',
    messagesPerBatch: 20,
    delayBetweenMessages: 3,
    delayBetweenBatches: 90,
    maxMessagesPerHour: 120,
    maxMessagesPerDay: 800,
    autoRetryEnabled: true,
    maxRetryAttempts: 3,
    retryWindowHours: 6,
  },
  slack: {
    messenger: 'slack',
    messagesPerBatch: 40,
    delayBetweenMessages: 1,
    delayBetweenBatches: 30,
    maxMessagesPerHour: 300,
    maxMessagesPerDay: 3000,
    autoRetryEnabled: true,
    maxRetryAttempts: 3,
    retryWindowHours: 6,
  },
  whatsapp: {
    messenger: 'whatsapp',
    messagesPerBatch: 5,
    delayBetweenMessages: 10,
    delayBetweenBatches: 300,
    maxMessagesPerHour: 40,
    maxMessagesPerDay: 200,
    autoRetryEnabled: true,
    maxRetryAttempts: 3,
    retryWindowHours: 6,
  },
  gmail: {
    messenger: 'gmail',
    messagesPerBatch: 10,
    delayBetweenMessages: 5,
    delayBetweenBatches: 120,
    maxMessagesPerHour: 60,
    maxMessagesPerDay: 500,
    autoRetryEnabled: true,
    maxRetryAttempts: 3,
    retryWindowHours: 6,
  },
  // Still cautious: the bottleneck is the browser, not Microsoft's rate limits.
  teams: {
    messenger: 'teams',
    messagesPerBatch: 8,
    delayBetweenMessages: 5,
    delayBetweenBatches: 180,
    maxMessagesPerHour: 60,
    maxMessagesPerDay: 400,
    autoRetryEnabled: true,
    maxRetryAttempts: 3,
    retryWindowHours: 6,
  },
};

// Default = safe presets (used as fallback when no settings saved in DB)
export const ANTIBAN_DEFAULTS = ANTIBAN_SAFE_PRESETS;
