'use client';

import Link from 'next/link';
import { Sparkles, ArrowRight } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

const MESSENGER_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  slack: 'Slack',
  whatsapp: 'WhatsApp',
  gmail: 'Gmail',
  teams: 'MS Teams',
};

export interface PendingImports {
  [messenger: string]: { count: number; at: string };
}

export function usePendingImports() {
  return useQuery({
    queryKey: ['pending-imports'],
    queryFn: () => api.get<{ pending: PendingImports }>('/api/chats/pending-imports'),
    staleTime: 60_000,
  });
}

/**
 * "New chats pending" — shown when the latest scans found chats that were
 * never imported. Lists the messengers with counts and links to /import.
 */
export function NewChatsBanner({ hideReviewLink = false }: { hideReviewLink?: boolean }) {
  const { data } = usePendingImports();
  const pending = data?.pending ?? {};
  const entries = Object.entries(pending).filter(([, v]) => v.count > 0);
  if (entries.length === 0) return null;

  const total = entries.reduce((n, [, v]) => n + v.count, 0);

  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-accent/20 bg-accent-bg px-4 py-3 motion-safe:animate-fade-in-up">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/10">
        <Sparkles className="h-4 w-4 text-accent" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-slate-900">
          {total} new chat{total !== 1 ? 's' : ''} pending
        </p>
        <p className="text-xs text-slate-500">
          {entries
            .map(([m, v]) => `${MESSENGER_LABELS[m] ?? m}: ${v.count}`)
            .join(' · ')}
        </p>
      </div>
      {!hideReviewLink && (
        <Link
          href="/import"
          className="flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white shadow-accent-sm transition-all hover:bg-accent-hover hover:-translate-y-px motion-safe:active:translate-y-0 motion-safe:active:scale-[0.98]"
        >
          Review
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      )}
    </div>
  );
}
