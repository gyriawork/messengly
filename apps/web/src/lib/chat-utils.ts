import type { MessengerType } from '@/types/chat';

const MESSENGER_COLORS: Record<MessengerType, string> = {
  telegram: '#0088cc',
  slack: '#611f69',
  whatsapp: '#25D366',
  gmail: '#EA4335',
  teams: '#4b53bc',
};

export function getMessengerDotColor(messenger: MessengerType): string {
  return MESSENGER_COLORS[messenger];
}

const AVATAR_COLORS = [
  '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
  '#ec4899', '#f43f5e', '#ef4444', '#f97316',
  '#eab308', '#84cc16', '#22c55e', '#14b8a6',
  '#06b6d4', '#3b82f6', '#2563eb',
];

export function getAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export function getInitials(name: string): string {
  return name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}
