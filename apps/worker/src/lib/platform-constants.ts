// Platform credential constants — duplicated from @messengly/shared
// to avoid workspace dependency issues with Railway builds.

export const MESSENGERS = ['telegram', 'slack', 'whatsapp', 'gmail'] as const;
export type Messenger = (typeof MESSENGERS)[number];

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
};

export const MESSENGER_ENV_VARS: Record<Messenger, Record<string, string>> = {
  telegram: { apiId: 'TELEGRAM_API_ID', apiHash: 'TELEGRAM_API_HASH' },
  slack: { clientId: 'SLACK_CLIENT_ID', clientSecret: 'SLACK_CLIENT_SECRET' },
  gmail: { clientId: 'GOOGLE_CLIENT_ID', clientSecret: 'GOOGLE_CLIENT_SECRET' },
  whatsapp: {},
};
