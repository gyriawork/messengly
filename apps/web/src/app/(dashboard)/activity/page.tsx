'use client';

import { useState, useCallback } from 'react';
import {
  Activity,
  Filter,
  Calendar,
  User,
  ChevronDown,
  Loader2,
  Clock,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useActivity } from '@/hooks/useActivity';
import type { ActivityCategory, ActivityFilters } from '@/types/activity';
import { RequireOrgContext } from '@/components/layout/RequireOrgContext';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState as EmptyStateUI } from '@/components/ui/EmptyState';
import { History } from 'lucide-react';

const CATEGORIES: Array<{ value: ActivityCategory | null; label: string }> = [
  { value: null, label: 'All Categories' },
  { value: 'chats', label: 'Chats' },
  { value: 'broadcast', label: 'Broadcast' },
  { value: 'templates', label: 'Templates' },
  { value: 'users', label: 'Users' },
  { value: 'integrations', label: 'Integrations' },
  { value: 'settings', label: 'Settings' },
  { value: 'organizations', label: 'Organizations' },
];

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

export default function ActivityPage() {
  const [filters, setFilters] = useState<ActivityFilters>({});
  const [page, setPage] = useState(1);

  const { data, isLoading } = useActivity(filters, page);

  // Actor dropdown: the org member list — a raw user-id input is unusable.
  // GET /api/users returns a bare array.
  const { data: usersData } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['org-users'],
    queryFn: () => api.get('/api/users'),
  });
  const orgUsers = usersData ?? [];

  const entries = data?.data || [];
  const pagination = data?.pagination;

  const handleFilterChange = useCallback(
    (update: Partial<ActivityFilters>) => {
      setFilters((prev) => ({ ...prev, ...update }));
      setPage(1);
    },
    [],
  );

  const handleLoadMore = useCallback(() => {
    if (pagination && page < pagination.totalPages) {
      setPage((prev) => prev + 1);
    }
  }, [pagination, page]);

  const inputClass = cn(
    'rounded-lg border-[1.5px] border-slate-200 bg-white px-3 py-2 text-sm text-slate-700',
    'transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15',
  );

  return (
    <RequireOrgContext>
    <div className="mx-auto max-w-4xl px-4 py-6 md:px-6 md:py-8">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">Activity Log</h1>
        <p className="mt-1 text-sm text-slate-500">
          Track all actions across your workspace
        </p>
      </div>

      {/* Filter bar */}
      <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
        {/* Category filter */}
        <div className="relative">
          <Filter className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <select
            value={filters.category || ''}
            onChange={(e) =>
              handleFilterChange({
                category: (e.target.value as ActivityCategory) || null,
              })
            }
            className={cn(inputClass, 'appearance-none pl-9 pr-8')}
          >
            {CATEGORIES.map((cat) => (
              <option key={cat.label} value={cat.value || ''}>
                {cat.label}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        </div>

        {/* Date From */}
        <div className="relative">
          <Calendar className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="date"
            value={filters.dateFrom || ''}
            onChange={(e) =>
              handleFilterChange({ dateFrom: e.target.value || null })
            }
            placeholder="From"
            className={cn(inputClass, 'pl-9')}
          />
        </div>

        {/* Date To */}
        <div className="relative">
          <Calendar className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="date"
            value={filters.dateTo || ''}
            onChange={(e) =>
              handleFilterChange({ dateTo: e.target.value || null })
            }
            placeholder="To"
            className={cn(inputClass, 'pl-9')}
          />
        </div>

        {/* User filter */}
        <div className="relative">
          <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <select
            value={filters.userId || ''}
            onChange={(e) =>
              handleFilterChange({ userId: e.target.value || null })
            }
            className={cn(inputClass, 'appearance-none w-44 pl-9 pr-8')}
          >
            <option value="">All users</option>
            {orgUsers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        </div>

        {/* Clear */}
        {(filters.category || filters.dateFrom || filters.dateTo || filters.userId) && (
          <button
            onClick={() => {
              setFilters({});
              setPage(1);
            }}
            className="text-sm font-medium text-accent hover:text-accent-hover"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Activity list */}
      {isLoading && entries.length === 0 ? (
        <div className="rounded-xl bg-white shadow-xs">
          {Array.from({ length: 10 }).map((_, i) => (
            <div
              key={i}
              className={cn(
                'flex items-start gap-4 px-5 py-4',
                i > 0 && 'border-t border-slate-50',
              )}
            >
              <Skeleton className="mt-1.5 h-2.5 w-2.5 rounded-full" />
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-3">
                  <Skeleton className="h-3.5 w-2/3" />
                  <Skeleton className="h-2.5 w-14" />
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <Skeleton className="h-4 w-16 rounded-full" />
                  <Skeleton className="h-2.5 w-24" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : entries.length === 0 ? (
        <EmptyStateUI
          icon={<History className="h-12 w-12" />}
          title="No activity history yet"
          description="Records will appear here as actions are performed in your workspace."
        />
      ) : (
        <>
          <div className="rounded-xl bg-white shadow-xs">
            {entries.map((entry, idx) => (
              <div
                key={entry.id}
                className={cn(
                  'flex items-start gap-4 px-5 py-4',
                  idx > 0 && 'border-t border-slate-50',
                )}
              >
                {/* Timeline dot */}
                <div className="relative mt-1.5 flex shrink-0 flex-col items-center">
                  <div
                    className="h-2.5 w-2.5 rounded-full"
                    style={{
                      backgroundColor:
                        CATEGORY_COLORS[entry.category] || '#6b7280',
                    }}
                  />
                  {idx < entries.length - 1 && (
                    <div className="absolute top-3.5 h-[calc(100%+16px)] w-px bg-slate-100" />
                  )}
                </div>

                {/* Content */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm text-slate-700">
                      <span className="font-semibold text-slate-900">
                        {entry.userName}
                      </span>{' '}
                      {entry.description}
                    </p>
                    <span className="shrink-0 text-xs text-slate-400">
                      {formatTimestamp(entry.createdAt)}
                    </span>
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <span
                      className={cn(
                        'inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium capitalize',
                        CATEGORY_BG[entry.category] || 'bg-slate-100 text-slate-600',
                      )}
                    >
                      {entry.category}
                    </span>
                    {entry.targetId && entry.targetType && (
                      <span className="text-xs text-slate-400">
                        {entry.targetType}:{' '}
                        {(entry.metadata?.preview as string) ||
                          `${entry.targetId.slice(0, 8)}...`}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Pagination */}
          {pagination && pagination.totalPages > 1 && (
            <div className="mt-6 flex items-center justify-center gap-3">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1 || isLoading}
                className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 shadow-xs transition-all hover:bg-slate-50 disabled:opacity-50"
              >
                Previous
              </button>
              <span className="text-sm text-slate-500">
                Page {page} of {pagination.totalPages}
              </span>
              <button
                onClick={handleLoadMore}
                disabled={page >= pagination.totalPages || isLoading}
                className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 shadow-xs transition-all hover:bg-slate-50 disabled:opacity-50"
              >
                {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
    </RequireOrgContext>
  );
}

function formatTimestamp(dateStr: string): string {
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

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
