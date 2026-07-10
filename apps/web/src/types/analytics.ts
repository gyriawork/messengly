// Types for the /api/analytics endpoint.
// Mirrors the AnalyticsResponse shape produced by apps/api/src/routes/analytics.ts.

export type AnalyticsScope = 'my' | 'org';
export type AnalyticsPeriod = '7d' | '30d' | '90d';
export type AnalyticsGranularity = 'day' | 'week' | 'month';
export type AnalyticsMessenger = 'telegram' | 'slack' | 'whatsapp' | 'gmail' | 'teams';

export interface DeltaValue {
  value: number;
  deltaPct: number | null;
}

export interface ChatsKpi {
  active: number;
  inactive: number;
  deltaPctActive: number | null;
}

export interface PerMessengerStats {
  count: number;
  percent: number;
  activeChats: number;
  inactiveChats: number;
}

export interface TrendBucket {
  bucket: string; // ISO timestamp (start of bucket)
  total: number;
  byMessenger: Record<AnalyticsMessenger, number>;
}

export interface HeatmapCell {
  weekday: number; // 0 = Sun … 6 = Sat (Postgres DOW)
  hour: number; // 0..23
  count: number;
}

export interface MemberRow {
  id: string;
  name: string;
  email: string;
  role: string;
  messages: number;
  activeChats: number;
  inactiveChats: number;
  lastActiveAt: string | null;
  topMessenger: AnalyticsMessenger | null;
}

export interface AnalyticsResponse {
  kpis: {
    messagesSent: DeltaValue;
    messagesReceived: DeltaValue;
    chats: ChatsKpi;
    activeDaysOrMembers: DeltaValue;
  };
  trend: TrendBucket[];
  byMessenger: Record<AnalyticsMessenger, PerMessengerStats>;
  heatmap: HeatmapCell[];
  members?: MemberRow[];
}
