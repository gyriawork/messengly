export type MessengerType = 'telegram' | 'slack' | 'whatsapp' | 'gmail' | 'teams';

export type IntegrationStatus =
  | 'connected'
  | 'disconnected'
  | 'token_expired'
  | 'session_expired';

export interface Integration {
  id: string;
  messenger: MessengerType;
  status: IntegrationStatus;
  settings?: Record<string, unknown>;
  connectedAt?: string;
  createdAt: string;
  /** Which user connected this integration. */
  userId: string;
  /** 'org' = shared connection an admin manages; 'user' = a personal
   * self-connect (Task 3/4). */
  scope: 'org' | 'user';
}

export interface ConnectTelegramPayload {
  apiId: string;
  apiHash: string;
}

export interface ConnectSlackPayload {
  botToken: string;
}

export interface ConnectGmailPayload {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export type ConnectPayload =
  | ConnectTelegramPayload
  | ConnectSlackPayload
  | ConnectGmailPayload
  | Record<string, never>;
