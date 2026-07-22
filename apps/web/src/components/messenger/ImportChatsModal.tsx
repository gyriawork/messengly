'use client';

import { useState } from 'react';
import Link from 'next/link';
import { X, Loader2 } from 'lucide-react';
import { useIntegrations } from '@/hooks/useIntegrations';
import { MessengerIcon } from '@/components/ui/MessengerIcon';
import { ConnectAndImportWizard } from '@/components/settings/ConnectAndImportWizard';
import { useAuthStore } from '@/stores/auth';
import { can, isAdmin } from '@/lib/permissions';
import { isActiveMessenger } from '@/lib/messengers';
import type { MessengerType } from '@/types/chat';
import { cn } from '@/lib/utils';

interface ImportChatsModalProps {
  onClose: () => void;
}

const MESSENGER_LABELS: Record<MessengerType, string> = {
  telegram: 'Telegram',
  slack: 'Slack',
  whatsapp: 'WhatsApp',
  gmail: 'Gmail',
  teams: 'MS Teams',
};

export function ImportChatsModal({ onClose }: ImportChatsModalProps) {
  const { data: integrationsData, isLoading } = useIntegrations();
  const [selectedMessenger, setSelectedMessenger] = useState<MessengerType | null>(null);
  const user = useAuthStore((s) => s.user);
  const admin = isAdmin(user);
  const selfConnectAllowed = can(user, 'canSelfConnectMessengers');

  // A plain user only ever imports through THEIR OWN connected account (the
  // server enforces this too — see POST /chats/import) — offering the org's
  // shared connection here would just lead to a 403 one step later.
  const connectedMessengers = [
    ...new Set(
      (integrationsData?.integrations ?? [])
        .filter((i) =>
          i.status === 'connected' &&
          isActiveMessenger(i.messenger) &&
          (admin || (i.scope === 'user' && i.userId === user?.id)),
        )
        .map((i) => i.messenger as MessengerType),
    ),
  ];

  // If a messenger is selected, show the wizard directly (steps 2+3 only)
  if (selectedMessenger) {
    return (
      <ConnectAndImportWizard
        messenger={selectedMessenger}
        messengerName={MESSENGER_LABELS[selectedMessenger]}
        isAlreadyConnected
        onClose={onClose}
      />
    );
  }

  // Messenger picker
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm motion-safe:animate-overlay-in md:items-center">
      <div className="w-full max-h-[90dvh] rounded-t-2xl bg-white p-6 shadow-lg motion-safe:animate-modal-in md:max-w-md md:rounded-xl">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-slate-900">Import Chats</h3>
            <p className="text-xs text-slate-500">
              Select a messenger to import chats with message history
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {isLoading && (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-6 w-6 animate-spin text-accent" />
          </div>
        )}

        {!isLoading && connectedMessengers.length === 0 && (
          <div className="py-8 text-center">
            <p className="text-sm text-slate-500">
              {admin || !selfConnectAllowed
                ? 'No messengers connected yet.'
                : "You haven't connected any messengers yet."}
            </p>
            {!admin && selfConnectAllowed ? (
              <Link
                href="/settings"
                className="mt-1 inline-block text-xs font-medium text-accent hover:underline"
              >
                Connect one in Settings → My Messengers
              </Link>
            ) : (
              <p className="mt-1 text-xs text-slate-400">
                {admin
                  ? 'Go to Settings to connect a messenger first.'
                  : 'Ask your workspace operator to connect one first.'}
              </p>
            )}
          </div>
        )}

        {!isLoading && connectedMessengers.length > 0 && (
          <div className="space-y-2">
            {connectedMessengers.map((m) => (
              <button
                key={m}
                onClick={() => setSelectedMessenger(m)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg border border-slate-200 px-4 py-3 text-left transition-all hover:border-accent/30 hover:bg-accent/5 hover:-translate-y-px motion-safe:active:translate-y-0 motion-safe:active:scale-[0.98]',
                )}
              >
                <MessengerIcon messenger={m} size={36} />
                <div>
                  <p className="text-sm font-medium text-slate-700">{MESSENGER_LABELS[m]}</p>
                  <p className="text-xs text-slate-400">Import chats with history</p>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
