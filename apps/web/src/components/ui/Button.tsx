// ─── Button primitive ───
// The one place button styling lives. New code uses this; existing screens
// migrate as they're touched (the class strings were normalized app-wide to
// match these exact variants, so visuals are already consistent).

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
type Size = 'sm' | 'md';

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-accent text-white shadow-accent-sm hover:bg-accent-hover hover:-translate-y-px motion-safe:active:translate-y-0 motion-safe:active:scale-[0.98]',
  secondary:
    'border-[1.5px] border-slate-200 text-slate-700 hover:bg-slate-50 hover:-translate-y-px motion-safe:active:translate-y-0 motion-safe:active:scale-[0.98]',
  danger:
    'border-[1.5px] border-red-200 text-red-600 hover:bg-red-50 hover:-translate-y-px motion-safe:active:translate-y-0 motion-safe:active:scale-[0.98]',
  ghost: 'text-slate-600 hover:bg-slate-100',
};

const SIZES: Record<Size, string> = {
  sm: 'px-3 py-1.5 text-xs',
  md: 'px-4 py-2 text-sm',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  children: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', loading, disabled, className, children, ...rest }, ref) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'flex items-center justify-center gap-2 rounded-lg font-medium transition-all',
        'disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  ),
);
Button.displayName = 'Button';
