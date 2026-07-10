'use client';

import { BarChart3 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type {
  TrendBucket,
  AnalyticsScope,
  AnalyticsGranularity,
  AnalyticsMessenger,
} from '@/types/analytics';

interface TrendChartProps {
  data: TrendBucket[];
  scope: AnalyticsScope;
  granularity: AnalyticsGranularity;
  isDrillDown: boolean;
}

// Colours picked to match the rest of the UI's messenger palette.
const MESSENGER_COLORS: Record<AnalyticsMessenger, string> = {
  telegram: 'bg-[#2AABEE]',
  slack: 'bg-[#E01E5A]',
  whatsapp: 'bg-[#25D366]',
  gmail: 'bg-[#EA4335]',
  teams: 'bg-[#4B53BC]',
};

const MESSENGER_LABELS: Record<AnalyticsMessenger, string> = {
  telegram: 'Telegram',
  slack: 'Slack',
  whatsapp: 'WhatsApp',
  gmail: 'Gmail',
  teams: 'MS Teams',
};

export function TrendChart({
  data,
  scope,
  granularity,
  isDrillDown,
}: TrendChartProps) {
  // Bars are stacked by messenger only in the "whole org" view — in drill-down
  // mode we're showing one person's history, so a flat bar is cleaner.
  const stacked = scope === 'org' && !isDrillDown;

  if (!data.length) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-slate-400">
        <div className="flex flex-col items-center gap-2">
          <BarChart3 className="h-8 w-8" />
          No activity in this period
        </div>
      </div>
    );
  }

  const maxTotal = Math.max(...data.map((b) => b.total), 1);

  return (
    <div>
      <div className="flex h-48 items-end gap-1">
        {data.map((bucket) => (
          <TrendBar
            key={bucket.bucket}
            bucket={bucket}
            maxTotal={maxTotal}
            stacked={stacked}
            granularity={granularity}
            showLabel={shouldShowLabel(data.length, data.indexOf(bucket), data.length)}
          />
        ))}
      </div>
      {stacked && (
        <div className="mt-4 flex flex-wrap items-center gap-4 border-t border-slate-100 pt-3">
          {(Object.keys(MESSENGER_COLORS) as AnalyticsMessenger[]).map((m) => (
            <div key={m} className="flex items-center gap-2 text-xs text-slate-500">
              <span
                className={cn('h-2.5 w-2.5 rounded-sm', MESSENGER_COLORS[m])}
              />
              {MESSENGER_LABELS[m]}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TrendBar({
  bucket,
  maxTotal,
  stacked,
  granularity,
  showLabel,
}: {
  bucket: TrendBucket;
  maxTotal: number;
  stacked: boolean;
  granularity: AnalyticsGranularity;
  showLabel: boolean;
}) {
  // Columns have min-height 2px when non-zero so a single-message bucket still
  // shows a sliver instead of disappearing.
  const totalHeight =
    bucket.total > 0
      ? Math.max((bucket.total / maxTotal) * 160, 2)
      : 0;

  // Build the list of non-zero segments (top to bottom, so the visually-topmost
  // one is first in the array — we give it the rounded corners).
  const segments: Array<{ messenger: AnalyticsMessenger; count: number }> =
    stacked && bucket.total > 0
      ? (Object.keys(MESSENGER_COLORS) as AnalyticsMessenger[])
          .map((m) => ({ messenger: m, count: bucket.byMessenger[m] }))
          .filter((s) => s.count > 0)
      : [];

  return (
    <div className="group relative flex min-w-[4px] flex-1 flex-col items-center justify-end">
      {/* Tooltip (bucket total + per-messenger breakdown) */}
      <div className="pointer-events-none absolute -top-2 left-1/2 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs text-white opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
        <div className="font-medium">
          {formatBucketLabel(bucket.bucket, granularity)}
        </div>
        <div className="mt-0.5 font-semibold">
          {bucket.total.toLocaleString()}{' '}
          {bucket.total === 1 ? 'message' : 'messages'}
        </div>
        {stacked && segments.length > 0 && (
          <div className="mt-1 flex flex-col gap-0.5 border-t border-slate-700 pt-1">
            {segments.map((s) => (
              <div
                key={s.messenger}
                className="flex items-center gap-1.5 text-[10px] text-slate-200"
              >
                <span
                  className={cn(
                    'h-2 w-2 rounded-sm',
                    MESSENGER_COLORS[s.messenger],
                  )}
                />
                <span>{MESSENGER_LABELS[s.messenger]}</span>
                <span className="ml-auto font-medium text-white">
                  {s.count.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Bar — top-to-bottom flex so the first (largest) segment sits on top
          and we can round just its top corners. */}
      <div
        className="flex w-full flex-col overflow-hidden"
        style={{ height: `${totalHeight}px` }}
      >
        {stacked ? (
          segments.map((s, idx) => {
            const segmentHeight = (s.count / bucket.total) * 100;
            return (
              <div
                key={s.messenger}
                className={cn(
                  MESSENGER_COLORS[s.messenger],
                  'transition-opacity group-hover:opacity-90',
                  idx === 0 && 'rounded-t-sm',
                )}
                style={{ height: `${segmentHeight}%` }}
              />
            );
          })
        ) : bucket.total > 0 ? (
          <div className="h-full w-full rounded-t-sm bg-accent/80 transition-colors group-hover:bg-accent" />
        ) : null}
      </div>

      {showLabel && (
        <span className="mt-1 text-[10px] text-slate-400">
          {formatShortBucketLabel(bucket.bucket, granularity)}
        </span>
      )}
    </div>
  );
}

function shouldShowLabel(_bucketCount: number, index: number, total: number): boolean {
  // Show every Nth label (max 7 labels) to avoid crowding.
  const step = Math.max(Math.floor(total / 7), 1);
  return index % step === 0 || index === total - 1;
}

function formatBucketLabel(iso: string, granularity: AnalyticsGranularity): string {
  const d = new Date(iso);
  if (granularity === 'month') {
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
  }
  if (granularity === 'week') {
    return `Week of ${d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    })}`;
  }
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

function formatShortBucketLabel(iso: string, granularity: AnalyticsGranularity): string {
  const d = new Date(iso);
  if (granularity === 'month') {
    return d.toLocaleDateString('en-US', { month: 'short' });
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
