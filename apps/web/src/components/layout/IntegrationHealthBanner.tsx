'use client';

import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { useIntegrations } from '@/hooks/useIntegrations';
import { useAuthStore } from '@/stores/auth';

const MESSENGER_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  slack: 'Slack',
  whatsapp: 'WhatsApp',
  gmail: 'Gmail',
  teams: 'MS Teams',
};

// Statuses that mean "this integration silently stopped working" — an
// intentional disconnect is not a problem, an expired session is.
const BROKEN = new Set(['token_expired', 'session_expired', 'error']);

/**
 * App-wide warning when a connected messenger has died (expired Teams
 * session, revoked token). Without it, users only found out when a
 * broadcast failed — and non-superadmins couldn't even see the status.
 */
export function IntegrationHealthBanner() {
  const { data } = useIntegrations();
  const isSuperadmin = useAuthStore((s) => s.user?.role === 'superadmin');

  const broken = (data?.integrations ?? []).filter((i) => BROKEN.has(i.status));
  if (broken.length === 0) return null;

  const names = [...new Set(broken.map((i) => MESSENGER_LABELS[i.messenger] ?? i.messenger))];

  return (
    <div className="flex items-start gap-2.5 border-b border-amber-200 bg-amber-50 px-4 py-2.5 md:px-6">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
      <p className="text-sm leading-relaxed text-amber-800">
        <span className="font-medium">
          {names.join(', ')} {names.length === 1 ? 'needs' : 'need'} to be reconnected
        </span>{' '}
        — broadcasts to {names.length === 1 ? 'it' : 'them'} will fail until then.{' '}
        {isSuperadmin ? (
          <Link href="/settings" className="font-medium underline underline-offset-2 hover:text-amber-900">
            Reconnect in Settings
          </Link>
        ) : (
          'Ask your workspace operator to reconnect.'
        )}
      </p>
    </div>
  );
}
