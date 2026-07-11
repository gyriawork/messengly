// ─── Skeleton primitive ───
// Gray placeholder shapes for loading states. Replaces inline spinners
// (which jar layout and feel slow) with content-shaped pulsing blocks.
//
// Usage:
//   <Skeleton className="h-4 w-32" />
//   <Skeleton className="h-12 w-12 rounded-full" />
//
// Higher-level pre-shaped skeletons live alongside the components they
// stand in for (e.g. ChatListSkeleton, MessageListSkeleton).

import type { HTMLAttributes } from 'react';

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {}

export function Skeleton({ className = '', ...rest }: SkeletonProps) {
  // A gradient sweep instead of a pulse; reduced-motion users get a static
  // block. The sweep animates transform only, so it never triggers layout.
  return (
    <div
      aria-hidden="true"
      className={`relative overflow-hidden rounded bg-gray-200 after:absolute after:inset-0 after:bg-gradient-to-r after:from-transparent after:via-white/60 after:to-transparent motion-safe:after:animate-shimmer ${className}`}
      {...rest}
    />
  );
}
