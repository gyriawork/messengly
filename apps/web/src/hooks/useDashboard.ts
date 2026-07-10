'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { DashboardStats } from '@/types/dashboard';
import type { ActivityEntry } from '@/types/activity';

interface ChatsResponse {
  chats: Array<{ id: string; messenger?: string; name: string }>;
  total: number;
}

interface BroadcastsResponse {
  broadcasts: Array<{ id: string; status: string; name: string }>;
  total: number;
}

interface IntegrationsResponse {
  integrations: Array<{ messenger: string; status: string }>;
}

interface AnalyticsResponse {
  totalSent: number;
  totalFailed: number;
  total: number;
  deliveryRate: number;
  perMessenger: Record<string, { sent: number; failed: number; total: number; deliveryRate: number }>;
  dailyCounts: Array<{ date: string; sent: number; failed: number }>;
}

interface ActivityResponse {
  data: ActivityEntry[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

export function useDashboardStats(scope?: 'org' | 'my') {
  const scopeParam = scope === 'my' ? '&scope=my' : '';

  return useQuery({
    queryKey: ['dashboard-stats', scope ?? 'default'],
    queryFn: async (): Promise<DashboardStats> => {
      const [chatsData, broadcastsData, integrationsData, analyticsData, activityData] =
        await Promise.allSettled([
          // Chats are an org-wide resource (imported by the superadmin), so the
          // per-messenger counts must not be scoped to the viewer. High limit so
          // every chat is counted, not just the first page.
          api.get<ChatsResponse>(`/api/chats?limit=1000`),
          api.get<BroadcastsResponse>('/api/broadcasts'),
          api.get<IntegrationsResponse>('/api/integrations'),
          api.get<AnalyticsResponse>(`/api/broadcasts/analytics?period=30d${scopeParam}`),
          api.get<ActivityResponse>(`/api/activity?limit=10${scopeParam}`),
        ]);

      const chats = chatsData.status === 'fulfilled' ? chatsData.value : { chats: [], total: 0 };
      const broadcasts = broadcastsData.status === 'fulfilled' ? broadcastsData.value : { broadcasts: [], total: 0 };
      const integrations = integrationsData.status === 'fulfilled' ? integrationsData.value : { integrations: [] };
      const analytics = analyticsData.status === 'fulfilled' ? analyticsData.value : null;
      const activity = activityData.status === 'fulfilled' ? activityData.value : { data: [], pagination: { total: 0 } };

      const activeIntegrations = integrations.integrations.filter(
        (i) => i.status === 'connected',
      );

      const messengerChatCounts = { telegram: 0, slack: 0, whatsapp: 0, gmail: 0, teams: 0 };
      if (chatsData.status === 'fulfilled' && Array.isArray(chats.chats)) {
        for (const chat of chats.chats) {
          const m = chat.messenger as keyof typeof messengerChatCounts;
          if (m && m in messengerChatCounts) {
            messengerChatCounts[m]++;
          }
        }
      }

      const isConnected = (messenger: string) =>
        activeIntegrations.some((i) => i.messenger === messenger);

      return {
        totalChats: chats.total,
        totalBroadcasts: broadcasts.total,
        activeIntegrations: activeIntegrations.length,
        messagesSent: analytics?.totalSent ?? 0,
        deliveryRate: Math.round((analytics?.deliveryRate ?? 0) * 100),
        recentActivity: activity.data,
        perMessenger: {
          telegram: { chats: messengerChatCounts.telegram, connected: isConnected('telegram') },
          slack: { chats: messengerChatCounts.slack, connected: isConnected('slack') },
          whatsapp: { chats: messengerChatCounts.whatsapp, connected: isConnected('whatsapp') },
          gmail: { chats: messengerChatCounts.gmail, connected: isConnected('gmail') },
          teams: { chats: messengerChatCounts.teams, connected: isConnected('teams') },
        },
      };
    },
    staleTime: 30_000,
  });
}
