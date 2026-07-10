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
