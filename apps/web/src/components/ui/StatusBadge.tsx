// ─── StatusBadge primitive ───
// One pill for every status in the app. Tones map to meaning, not to feature:
// positive (working), negative (broken/unreachable), warning (needs a human),
// neutral (off/idle), info (in progress).

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type Tone = 'positive' | 'negative' | 'warning' | 'neutral' | 'info';

const TONES: Record<Tone, { chip: string; dot: string }> = {
  positive: { chip: 'bg-emerald-100 text-emerald-800 ring-1 ring-inset ring-emerald-300', dot: 'bg-emerald-500' },
  negative: { chip: 'bg-rose-100 text-rose-800 ring-1 ring-inset ring-rose-300', dot: 'bg-rose-500' },
  warning: { chip: 'bg-amber-100 text-amber-800 ring-1 ring-inset ring-amber-300', dot: 'bg-amber-500' },
  neutral: { chip: 'bg-slate-100 text-slate-600 ring-1 ring-inset ring-slate-200', dot: 'bg-slate-400' },
  info: { chip: 'bg-blue-100 text-blue-800 ring-1 ring-inset ring-blue-300', dot: 'bg-blue-500' },
};

export function StatusBadge({
  tone,
  children,
  dot = false,
  className,
}: {
  tone: Tone;
  children: ReactNode;
  /** Show a colored dot before the label. */
  dot?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium',
        TONES[tone].chip,
        className,
      )}
    >
      {dot && <span className={cn('h-1.5 w-1.5 rounded-full', TONES[tone].dot)} />}
      {children}
    </span>
  );
}
