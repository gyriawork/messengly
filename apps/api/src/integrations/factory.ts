// ─── Adapter Factory ───
// Creates the appropriate messenger adapter based on messenger type.
// Uses dynamic imports to avoid crashing if native deps are missing.

import type { MessengerAdapter } from './base.js';
import { MessengerError } from './base.js';
import { getPlatformCredentials } from '../lib/platform-credentials.js';

const SUPPORTED_MESSENGERS = ['telegram', 'slack', 'whatsapp', 'gmail', 'teams'] as const;
type SupportedMessenger = (typeof SUPPORTED_MESSENGERS)[number];

/**
 * Create a messenger adapter instance for the given messenger type.
 * Does NOT call connect() — caller must do that separately.
 */
export async function createAdapter(
  messenger: string,
  credentials: Record<string, unknown>,
  opts?: { organizationId?: string },
): Promise<MessengerAdapter> {
  switch (messenger as SupportedMessenger) {
    case 'telegram': {
      const { TelegramAdapter } = await import('./telegram.js');
      const tgCreds = credentials as { apiId?: number; apiHash?: string; session?: string };
      // If apiId/apiHash not in user credentials, resolve from platform config
      let apiId = tgCreds.apiId;
      let apiHash = tgCreds.apiHash;
      if (!apiId || !apiHash) {
        const platform = await getPlatformCredentials('telegram', opts?.organizationId);
        if (!platform.credentials) {
          throw new MessengerError('telegram', null, 'Telegram platform credentials not configured');
        }
        apiId = Number(platform.credentials.apiId);
        apiHash = platform.credentials.apiHash;
      }
      return new TelegramAdapter({ apiId, apiHash, session: tgCreds.session });
    }
    case 'slack': {
      const { SlackAdapter } = await import('./slack.js');
      return new SlackAdapter(credentials as { token: string });
    }
    case 'whatsapp': {
      const { WhatsAppAdapter } = await import('./whatsapp.js');
      return new WhatsAppAdapter(credentials as { wahaSessionName: string; phoneNumber?: string });
    }
    case 'gmail': {
      const { GmailAdapter } = await import('./gmail.js');
      const gmailCreds = credentials as { clientId?: string; clientSecret?: string; refreshToken: string };
      // If clientId/clientSecret not in user credentials, resolve from platform config
      let clientId = gmailCreds.clientId;
      let clientSecret = gmailCreds.clientSecret;
      if (!clientId || !clientSecret) {
        const platform = await getPlatformCredentials('gmail', opts?.organizationId);
        if (!platform.credentials) {
          throw new MessengerError('gmail', null, 'Gmail platform credentials not configured');
        }
        clientId = platform.credentials.clientId;
        clientSecret = platform.credentials.clientSecret;
      }
      return new GmailAdapter({ clientId, clientSecret, refreshToken: gmailCreds.refreshToken });
    }
    case 'teams': {
      // No credentials to pass: the teams-agent sidecar owns the single browser
      // session, exactly as WAHA owns the WhatsApp one.
      const { TeamsAdapter } = await import('./teams.js');
      return new TeamsAdapter();
    }
    default:
      throw new MessengerError(
        messenger,
        null,
        `Unsupported messenger type: ${messenger}. Supported: ${SUPPORTED_MESSENGERS.join(', ')}`,
      );
  }
}

export { SUPPORTED_MESSENGERS };
export type { SupportedMessenger };
