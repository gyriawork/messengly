'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ChevronRight, Download } from 'lucide-react';
import { useIntegrations } from '@/hooks/useIntegrations';
import { MessengerIcon } from '@/components/ui/MessengerIcon';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConnectAndImportWizard } from '@/components/settings/ConnectAndImportWizard';
import { NewChatsBanner, usePendingImports } from '@/components/chats/NewChatsBanner';
import { RequireOrgContext } from '@/components/layout/RequireOrgContext';
import { useAuthStore } from '@/stores/auth';
import { can, isAdmin } from '@/lib/permissions';
import { isActiveMessenger } from '@/lib/messengers';
import type { MessengerType } from '@/types/chat';

const MESSENGER_LABELS: Record<MessengerType, string> = {
  telegram: 'Telegram',
  slack: 'Slack',
  whatsapp: 'WhatsApp',
  gmail: 'Gmail',
  teams: 'MS Teams',
};

export default function ImportPage() {
  const { data: integrationsData, isLoading } = useIntegrations();
  const { data: pendingData } = usePendingImports();
  const [selectedMessenger, setSelectedMessenger] = useState<MessengerType | null>(null);
  const user = useAuthStore((s) => s.user);
  const isSuperadmin = user?.role === 'superadmin';
  const admin = isAdmin(user);
  const selfConnectAllowed = can(user, 'canSelfConnectMessengers');

  const pending = pendingData?.pending ?? {};

  // A plain user only ever imports through THEIR OWN connected account (the
  // server enforces this too — see POST /chats/import) — offering the org's
  // shared connection here would just lead to a 403 one step later.
  const connectedMessengers = [
    ...new Set(
      (integrationsData?.integrations ?? [])
        .filter((i) =>
          i.status === 'connected' &&
          (admin || (i.scope === 'user' && i.userId === user?.id)),
        )
        .map((i) => i.messenger as MessengerType),
    ),
  ].filter(isActiveMessenger); // Gmail + WhatsApp hidden for launch

  return (
    <RequireOrgContext>
    <div className="mx-auto max-w-4xl px-4 py-6 md:px-6 md:py-8">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">Import</h1>
        <p className="mt-1 text-sm text-slate-500">
          Bring chats from your connected messengers into Messengly
        </p>
      </div>

      <NewChatsBanner hideReviewLink />

      {/* Messenger cards */}
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 rounded-xl border border-slate-200 bg-white p-5">
              <Skeleton className="h-11 w-11 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-56" />
              </div>
            </div>
          ))}
        </div>
      ) : connectedMessengers.length === 0 ? (
        <EmptyState
          icon={<Download className="h-12 w-12" />}
          title="Nothing to import from yet"
          description={
            // Admin+ manages connections from Settings → Integrations. A
            // self-connecting user has their own "My Messengers" entry point
            // (the action link below); anyone else has no way to fix this
            // themselves and needs to ask whoever manages the workspace.
            admin
              ? 'Connect a messenger in Settings first, then come back here to bring in its chats.'
              : selfConnectAllowed
                ? "You haven't connected any messengers yet."
                : 'No messengers are connected yet. Ask your workspace operator to connect one, then come back here.'
          }
          action={
            !admin && selfConnectAllowed ? (
              <Link href="/settings" className="text-sm font-medium text-accent hover:underline">
                Connect one in Settings → My Messengers
              </Link>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-3">
          {connectedMessengers.map((m, i) => {
            const newCount = pending[m]?.count ?? 0;
            return (
              <button
                key={m}
                onClick={() => setSelectedMessenger(m)}
                className="flex w-full items-center gap-4 rounded-xl border border-slate-200 bg-white p-5 text-left transition-all hover:border-accent/30 hover:shadow-xs hover:-translate-y-px motion-safe:active:translate-y-0 motion-safe:active:scale-[0.99] motion-safe:animate-fade-in-up"
                style={{ animationDelay: `${Math.min(i, 12) * 25}ms` }}
              >
                <MessengerIcon messenger={m} size={44} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-base font-semibold text-slate-900">{MESSENGER_LABELS[m]}</p>
                    {newCount > 0 && (
                      <span className="inline-flex items-center rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold text-white">
                        {newCount} new
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {newCount > 0
                      ? `${newCount} chat${newCount !== 1 ? 's' : ''} found that you haven't imported`
                      : 'Scan for chats and pick which ones to import'}
                  </p>
                </div>
                <ChevronRight className="h-5 w-5 shrink-0 text-slate-300" />
              </button>
            );
          })}
        </div>
      )}

      {/* The same wizard the app has always used: scan → select → import. */}
      {selectedMessenger && (
        <ConnectAndImportWizard
          messenger={selectedMessenger}
          messengerName={MESSENGER_LABELS[selectedMessenger]}
          isAlreadyConnected
          onClose={() => setSelectedMessenger(null)}
        />
      )}
    </div>
    </RequireOrgContext>
  );
}
