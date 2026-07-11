/**
 * The app-wide date formats. Every surface uses these three — mixing
 * per-page toLocale* calls is what made dates look different on every screen.
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** `11.07.2026` */
export function formatDate(iso?: string | Date | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/** `11.07.2026, 01:04` */
export function formatDateTime(iso?: string | Date | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${formatDate(d)}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `5m ago` / `3h ago` / `2d ago`, then `11.07.2026` past a week. */
export function formatRelative(iso?: string | Date | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return formatDate(d);
}
