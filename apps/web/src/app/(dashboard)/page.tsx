'use client';

import { useRouter } from 'next/navigation';
import {
  MessageSquare,
  Plug,
  Send,
  TrendingUp,
  Plus,
  FileText,
  Clock,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDate } from '@/lib/dates';
import { useDashboardStats } from '@/hooks/useDashboard';
import type { ActivityCategory } from '@/types/activity';
import { MessengerIcon } from '@/components/ui/MessengerIcon';
import { RequireOrgContext } from '@/components/layout/RequireOrgContext';
import { Skeleton } from '@/components/ui/Skeleton';

const CATEGORY_COLORS: Record<ActivityCategory, string> = {
  chats: '#3b82f6',
  messages: '#6366f1',
  broadcast: '#8b5cf6',
  templates: '#f59e0b',
  users: '#10b981',
  integrations: '#ec4899',
  settings: '#6b7280',
  organizations: '#06b6d4',
};

const CATEGORY_BG: Record<ActivityCategory, string> = {
  chats: 'bg-blue-50 text-blue-700',
  messages: 'bg-indigo-50 text-indigo-700',
  broadcast: 'bg-purple-50 text-purple-700',
  templates: 'bg-amber-50 text-amber-700',
  users: 'bg-emerald-50 text-emerald-700',
  integrations: 'bg-pink-50 text-pink-700',
  settings: 'bg-slate-100 text-slate-600',
  organizations: 'bg-cyan-50 text-cyan-700',
};

// Gmail intentionally omitted — service is focused on Slack/Telegram broadcasts.
const MESSENGER_CONFIG = {
  telegram: { label: 'Telegram', short: 'TG', color: 'bg-[#2AABEE]' },
  slack: { label: 'Slack', short: 'SL', color: 'bg-[#E01E5A]' },
  whatsapp: { label: 'WhatsApp', short: 'WA', color: 'bg-[#25D366]' },
  teams: { label: 'MS Teams', short: 'TS', color: 'bg-[#6264A7]' },
} as const;

export default function DashboardPage() {
  const router = useRouter();
  // The dashboard always shows organization-wide stats (no private/my view).
  const { data: stats, isLoading } = useDashboardStats('org');

  if (isLoading) {
    return (
      <RequireOrgContext>
        <div className="mx-auto max-w-5xl px-4 py-6 md:px-6 md:py-8">
          {/* Header skeleton */}
          <div className="mb-8">
            <Skeleton className="h-7 w-40" />
            <Skeleton className="mt-2 h-4 w-64" />
          </div>

          {/* Metric cards skeleton */}
          <div className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="rounded-xl bg-white p-5 shadow-xs">
                <div className="flex items-start justify-between">
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-3 w-20" />
                    <Skeleton className="h-7 w-16" />
                  </div>
                  <Skeleton className="h-10 w-10 rounded-lg" />
                </div>
              </div>
            ))}
          </div>

          {/* Quick actions skeleton */}
          <div className="mb-8">
            <Skeleton className="mb-3 h-4 w-28" />
            <div className="flex gap-3">
              <Skeleton className="h-10 w-40 rounded-lg" />
              <Skeleton className="h-10 w-44 rounded-lg" />
            </div>
          </div>

          {/* Two-column content skeleton */}
          <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
            <div className="lg:col-span-2">
              <div className="rounded-xl bg-white p-6 shadow-xs">
                <Skeleton className="mb-4 h-5 w-36" />
                <div className="space-y-3">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="flex items-start gap-3 py-2">
                      <Skeleton className="mt-1.5 h-2 w-2 rounded-full" />
                      <div className="flex-1 space-y-1.5">
                        <Skeleton className="h-3.5 w-full" />
                        <Skeleton className="h-2.5 w-32" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div>
              <div className="rounded-xl bg-white p-6 shadow-xs">
                <Skeleton className="mb-4 h-5 w-28" />
                <div className="space-y-3">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-3 rounded-lg border border-slate-100 p-3"
                    >
                      <Skeleton className="h-9 w-9 rounded-lg" />
                      <div className="flex-1 space-y-1.5">
                        <Skeleton className="h-3.5 w-20" />
                        <Skeleton className="h-2.5 w-14" />
                      </div>
                      <Skeleton className="h-5 w-20 rounded-full" />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </RequireOrgContext>
    );
  }

  return (
    <RequireOrgContext>
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-6 md:py-8">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">Dashboard</h1>
            <p className="mt-1 text-sm text-slate-500">
              Overview of your broadcast workspace
            </p>
          </div>
        </div>
      </div>

      {/* Metric cards */}
      <div className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-4">
        <MetricCard
          icon={<MessageSquare className="h-5 w-5 text-blue-500" />}
          iconBg="bg-blue-50"
          label="Total Chats"
          value={stats?.totalChats ?? 0}
        />
        <MetricCard
          icon={<Plug className="h-5 w-5 text-emerald-500" />}
          iconBg="bg-emerald-50"
          label="Active Integrations"
          value={stats?.activeIntegrations ?? 0}
        />
        <MetricCard
          icon={<Send className="h-5 w-5 text-accent" />}
          iconBg="bg-accent-bg"
          label="Messages Sent"
          value={formatNumber(stats?.messagesSent ?? 0)}
          subtitle="This month"
        />
        <MetricCard
          icon={<TrendingUp className="h-5 w-5 text-purple-500" />}
          iconBg="bg-purple-50"
          label="Delivery Rate"
          value={`${Math.round(stats?.deliveryRate ?? 0)}%`}
        />
      </div>

      {/* Quick actions */}
      <div className="mb-8">
        <h2 className="mb-3 text-sm font-semibold text-slate-700">
          Quick Actions
        </h2>
        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => router.push('/broadcast/new')}
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white shadow-accent-sm transition-all hover:bg-accent-hover hover:-translate-y-px"
          >
            <Plus className="h-4 w-4" />
            New Broadcast
          </button>
<button
            onClick={() => router.push('/templates')}
            className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 shadow-xs transition-all hover:bg-slate-50 hover:-translate-y-px"
          >
            <FileText className="h-4 w-4" />
            Manage Templates
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        {/* Recent activity */}
        <div className="lg:col-span-2">
          <div className="rounded-xl bg-white p-6 shadow-xs">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-900">
                Recent Activity
              </h2>
              <button
                onClick={() => router.push('/activity')}
                className="text-sm font-medium text-accent hover:text-accent-hover"
              >
                View all
              </button>
            </div>

            {!stats?.recentActivity?.length ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Clock className="h-8 w-8 text-slate-200" />
                <p className="mt-3 text-sm text-slate-400">
                  No recent activity yet
                </p>
              </div>
            ) : (
              <div className="space-y-0">
                {stats.recentActivity.slice(0, 8).map((entry, idx) => (
                  <div
                    key={entry.id}
                    className={cn(
                      'flex items-start gap-3 py-3',
                      idx > 0 && 'border-t border-slate-50',
                    )}
                  >
                    <div
                      className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                      style={{
                        backgroundColor:
                          CATEGORY_COLORS[entry.category] || '#6b7280',
                      }}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-slate-700">
                        <span className="font-medium">{entry.userName}</span>{' '}
                        {entry.description}
                      </p>
                      <div className="mt-1 flex items-center gap-2">
                        <span
                          className={cn(
                            'inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium',
                            CATEGORY_BG[entry.category] || 'bg-slate-100 text-slate-600',
                          )}
                        >
                          {entry.category}
                        </span>
                        <span className="text-xs text-slate-400">
                          {formatRelativeTime(entry.createdAt)}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Per-messenger summary */}
        <div>
          <div className="rounded-xl bg-white p-6 shadow-xs">
            <h2 className="mb-4 text-base font-semibold text-slate-900">
              Messengers
            </h2>
            <div className="space-y-3">
              {(Object.keys(MESSENGER_CONFIG) as Array<keyof typeof MESSENGER_CONFIG>).map(
                (messenger) => {
                  const config = MESSENGER_CONFIG[messenger];
                  const data = stats?.perMessenger?.[messenger];
                  return (
                    <div
                      key={messenger}
                      className="flex items-center gap-3 rounded-lg border border-slate-100 p-3"
                    >
                      <MessengerIcon messenger={messenger} size={36} />
                      <div className="flex-1">
                        <p className="text-sm font-medium text-slate-800">
                          {config.label}
                        </p>
                        <p className="text-xs text-slate-400">
                          {data?.chats ?? 0} chats
                        </p>
                      </div>
                      <span
                        className={cn(
                          'inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium',
                          data?.connected
                            ? 'bg-emerald-50 text-emerald-600'
                            : 'bg-slate-100 text-slate-400',
                        )}
                      >
                        {data?.connected ? 'Connected' : 'Disconnected'}
                      </span>
                    </div>
                  );
                },
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
    </RequireOrgContext>
  );
}

function MetricCard({
  icon,
  iconBg,
  label,
  value,
  subtitle,
}: {
  icon: React.ReactNode;
  iconBg: string;
  label: string;
  value: string | number;
  subtitle?: string;
}) {
  return (
    <div className="rounded-xl bg-white p-5 shadow-xs">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-slate-500">{label}</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">{value}</p>
          {subtitle && (
            <p className="mt-0.5 text-xs text-slate-400">{subtitle}</p>
          )}
        </div>
        <div
          className={cn(
            'flex h-10 w-10 items-center justify-center rounded-lg',
            iconBg,
          )}
        >
          {icon}
        </div>
      </div>
    </div>
  );
}

function formatNumber(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return String(num);
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHour = Math.floor(diffMs / 3_600_000);
  const diffDay = Math.floor(diffMs / 86_400_000);

  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;

  return formatDate(date);
}
