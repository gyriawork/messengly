// ─── ENUMS ───

export const MESSENGERS = ['telegram', 'slack', 'whatsapp', 'gmail', 'teams'] as const;
export type Messenger = (typeof MESSENGERS)[number];

export const USER_ROLES = ['superadmin', 'admin', 'user'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ['active', 'deactivated'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const CHAT_STATUSES = ['active', 'read-only'] as const;
export type ChatStatus = (typeof CHAT_STATUSES)[number];

export const CHAT_TYPES = ['direct', 'group', 'channel'] as const;
export type ChatType = (typeof CHAT_TYPES)[number];

// 'canceling' is transient: the user asked to stop a live send and the worker
// bails at the next message boundary, landing on terminal 'canceled'.
export const BROADCAST_STATUSES = ['draft', 'scheduled', 'sending', 'canceling', 'sent', 'partially_failed', 'failed', 'canceled'] as const;
export type BroadcastStatus = (typeof BROADCAST_STATUSES)[number];

export const BROADCAST_CHAT_STATUSES = ['pending', 'sent', 'failed', 'retrying', 'retry_exhausted'] as const;
export type BroadcastChatStatus = (typeof BROADCAST_CHAT_STATUSES)[number];

export const INTEGRATION_STATUSES = ['connected', 'disconnected', 'token_expired', 'session_expired'] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export const DELIVERY_STATUSES = ['sent', 'delivered', 'read', 'failed'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const ORG_STATUSES = ['active', 'suspended'] as const;
export type OrgStatus = (typeof ORG_STATUSES)[number];

export const ACTIVITY_CATEGORIES = [
  'chats', 'messages', 'broadcast', 'templates',
  'users', 'integrations', 'settings', 'organizations',
] as const;
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

// ─── MESSENGER COLORS ───

export const MESSENGER_COLORS: Record<Messenger, { bg: string; text: string; label: string }> = {
  telegram:  { bg: '#e6f1fb', text: '#0c447c', label: 'TG' },
  slack:     { bg: '#eeedfe', text: '#3c3489', label: 'SL' },
  whatsapp:  { bg: '#eaf3de', text: '#3b6d11', label: 'WA' },
  gmail:     { bg: '#fcebeb', text: '#a32d2d', label: 'GM' },
  teams:     { bg: '#eceafa', text: '#4b53bc', label: 'MT' },
};

// ─── EDIT LIMITS ───

export const MESSAGE_EDIT_LIMITS: Record<Messenger, number | null> = {
  telegram:  48 * 60 * 60,   // 48 hours in seconds
  slack:     null,            // unlimited
  whatsapp:  15 * 60,        // 15 minutes in seconds
  gmail:     0,              // not supported (0 = disabled)
  teams:     0,              // browser automation cannot reliably edit a sent message
};

// ─── DEFAULT ANTIBAN SETTINGS ───

export const DEFAULT_ANTIBAN: Record<Messenger, {
  messagesPerBatch: number;
  delayBetweenMessages: number;
  delayBetweenBatches: number;
  maxMessagesPerHour: number;
  maxMessagesPerDay: number;
}> = {
  telegram: {
    messagesPerBatch: 10,
    delayBetweenMessages: 5,
    delayBetweenBatches: 180,
    maxMessagesPerHour: 50,
    maxMessagesPerDay: 300,
  },
  whatsapp: {
    messagesPerBatch: 3,
    delayBetweenMessages: 15,
    delayBetweenBatches: 600,
    maxMessagesPerHour: 20,
    maxMessagesPerDay: 80,
  },
  slack: {
    messagesPerBatch: 30,
    delayBetweenMessages: 1,
    delayBetweenBatches: 30,
    maxMessagesPerHour: 200,
    maxMessagesPerDay: 2000,
  },
  gmail: {
    messagesPerBatch: 5,
    delayBetweenMessages: 8,
    delayBetweenBatches: 180,
    maxMessagesPerHour: 80,
    maxMessagesPerDay: 400,
  },
  // Teams runs through a real browser: every send costs seconds and looks like a
  // human typing. Conservative on purpose. The agent adds its own 3–10s random
  // jitter on top — these delays are deterministic, and randomization is what
  // actually defeats rate-limit heuristics.
  teams: {
    messagesPerBatch: 5,
    delayBetweenMessages: 8,
    delayBetweenBatches: 300,
    maxMessagesPerHour: 40,
    maxMessagesPerDay: 200,
  },
};

// ─── PLATFORM CONFIG ───

export interface PlatformField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'number';
}

export const MESSENGER_PLATFORM_FIELDS: Record<Messenger, PlatformField[]> = {
  telegram: [
    { key: 'apiId', label: 'API ID', type: 'number' },
    { key: 'apiHash', label: 'API Hash', type: 'password' },
  ],
  slack: [
    { key: 'clientId', label: 'Client ID', type: 'text' },
    { key: 'clientSecret', label: 'Client Secret', type: 'password' },
  ],
  gmail: [
    { key: 'clientId', label: 'Client ID', type: 'text' },
    { key: 'clientSecret', label: 'Client Secret', type: 'password' },
  ],
  whatsapp: [],
  // Teams authenticates through a browser session held by the teams-agent
  // sidecar, so there are no platform-level API keys to configure.
  teams: [],
};

export const MESSENGER_ENV_VARS: Record<Messenger, Record<string, string>> = {
  telegram: { apiId: 'TELEGRAM_API_ID', apiHash: 'TELEGRAM_API_HASH' },
  slack: { clientId: 'SLACK_CLIENT_ID', clientSecret: 'SLACK_CLIENT_SECRET' },
  gmail: { clientId: 'GOOGLE_CLIENT_ID', clientSecret: 'GOOGLE_CLIENT_SECRET' },
  whatsapp: {},
  teams: {},
};

// ─── ERROR CODES ───

export const ERROR_CODES = {
  AUTH_INVALID_CREDENTIALS: { statusCode: 401, message: 'Invalid email or password' },
  AUTH_TOKEN_EXPIRED: { statusCode: 401, message: 'Token has expired' },
  AUTH_INSUFFICIENT_PERMISSIONS: { statusCode: 403, message: 'Insufficient permissions' },
  RESOURCE_NOT_FOUND: { statusCode: 404, message: 'Resource not found' },
  VALIDATION_ERROR: { statusCode: 422, message: 'Validation error' },
  RATE_LIMIT_EXCEEDED: { statusCode: 429, message: 'Rate limit exceeded' },
  MESSENGER_API_ERROR: { statusCode: 502, message: 'Messenger API error' },
  MESSENGER_RATE_LIMITED: { statusCode: 429, message: 'Messenger rate limit reached' },
  INTERNAL_ERROR: { statusCode: 500, message: 'Internal server error' },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

// ─── EMOJI MAP ───

export { TELEGRAM_ALLOWED_EMOJI, getReactionSupport } from './emoji-map';
