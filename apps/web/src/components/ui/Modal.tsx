// ─── Modal primitive ───
// One overlay + panel for every dialog: same backdrop, radius, close affordance
// and keyboard behavior (ESC closes, focus stays inside the panel).

'use client';

import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Modal({
  title,
  subtitle,
  icon,
  onClose,
  children,
  wide = false,
  /** Hide the ✕ and ignore ESC/backdrop — for steps that must not be abandoned. */
  locked = false,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  locked?: boolean;
}) {
  useEffect(() => {
    if (locked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, locked]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm motion-safe:animate-overlay-in md:items-center"
      onClick={locked ? undefined : onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'w-full max-h-[100dvh] overflow-y-auto rounded-t-2xl bg-white p-6 shadow-lg motion-safe:animate-modal-in md:rounded-xl',
          wide ? 'md:max-w-6xl' : 'md:max-w-md',
        )}
      >
        {(title || !locked) && (
          <div className="mb-5 flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              {icon}
              <div className="min-w-0">
                {title && (
                  <h3 className="text-lg font-semibold text-slate-900">{title}</h3>
                )}
                {subtitle && <p className="text-xs text-slate-500">{subtitle}</p>}
              </div>
            </div>
            {!locked && (
              <button
                onClick={onClose}
                aria-label="Close"
                className="shrink-0 rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
              >
                <X className="h-5 w-5" />
              </button>
            )}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
