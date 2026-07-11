'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Animates a number from 0 to `value` once on mount (~600ms, ease-out).
 * Respects prefers-reduced-motion by rendering the final value immediately.
 * Re-runs only when `value` itself changes (e.g. a refetch), starting from
 * the previously shown number so updates read as a nudge, not a reset.
 */
export function CountUp({ value }: { value: number }) {
  const [shown, setShown] = useState(0);
  const fromRef = useRef(0);

  useEffect(() => {
    if (
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      setShown(value);
      fromRef.current = value;
      return;
    }

    const from = fromRef.current;
    const delta = value - from;
    if (delta === 0) return;

    const duration = 600;
    const start = performance.now();
    let raf = 0;

    const tick = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(Math.round(from + delta * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  return <>{shown.toLocaleString()}</>;
}
