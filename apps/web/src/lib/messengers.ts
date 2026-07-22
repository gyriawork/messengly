import type { MessengerType } from '@/types/chat';

// Channels temporarily hidden from the product for launch (not yet integrated).
// Backend adapters/routes stay in place — these are only removed from every
// user-facing list (connections, broadcast pickers, anti-ban tabs, dashboard).
export const HIDDEN_MESSENGERS: MessengerType[] = ['whatsapp', 'gmail'];

// The channels shown to users, in display order.
export const ACTIVE_MESSENGERS: MessengerType[] = ['telegram', 'slack', 'teams'];

/** Whether a messenger is currently user-facing (not hidden for launch). */
export function isActiveMessenger(m: string): boolean {
  return !HIDDEN_MESSENGERS.includes(m as MessengerType);
}
