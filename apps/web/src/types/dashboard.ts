import type { ActivityEntry } from './activity';

export interface DashboardStats {
  totalChats: number;
  totalBroadcasts: number;
  activeIntegrations: number;
  messagesSent: number;
  deliveryRate: number;
  recentActivity: ActivityEntry[];
  perMessenger: {
    telegram: { chats: number; connected: boolean };
    slack: { chats: number; connected: boolean };
    whatsapp: { chats: number; connected: boolean };
    gmail: { chats: number; connected: boolean };
    teams: { chats: number; connected: boolean };
  };
}
