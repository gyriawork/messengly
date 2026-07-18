'use client';

import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { ArrowLeft, Plug, Unplug, Loader2, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { humanizeError } from '@/lib/errors';
import { MessengerIcon } from '@/components/ui/MessengerIcon';
import { useAuthStore } from '@/stores/auth';
import { can, isAdmin } from '@/lib/permissions';
import { useIntegrations, useDisconnectIntegration, useDisconnectIntegrationById } from '@/hooks/useIntegrations';
import { useTeamUsers } from '@/hooks/useUsers';
import { messengers, ConnectModal, type MessengerInfo } from '@/components/settings/IntegrationsTab';
import type { MessengerType } from '@/types/integration';

export default function MessengerSettingsPage() {
  const params = useParams<{ messenger: string }>();
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const { data, isLoading } = useIntegrations();
  const { data: teamUsers } = useTeamUsers();
  const disconnectMine = useDisconnectIntegration();
  const disconnectById = useDisconnectIntegrationById();
  const [connecting, setConnecting] = useState(false);

  const info: MessengerInfo | undefined = messengers.find((m) => m.key === params.messenger);

  if (!info) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <p className="text-lg font-semibold text-slate-900">Unknown messenger</p>
          <button onClick={() => router.push('/settings')} className="mt-2 text-sm text-accent hover:underline">
            Back to Settings
          </button>
        </div>
      </div>
    );
  }

  const messenger = info.key as MessengerType;
  const admin = isAdmin(user);
  const canSelfConnect = can(user, 'canSelfConnectMessengers');
  // Task 8: Teams is now per-user too — a plain user with
  // canSelfConnectMessengers gets their own isolated browser session,
  // separate from the org's shared one (which only an admin's own "My
  // account" connect creates).
  const selfConnectAllowed = canSelfConnect;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-accent" />
      </div>
    );
  }

  const allForMessenger = (data?.integrations ?? []).filter((i) => i.messenger === messenger);
  const mine = allForMessenger.find((i) => i.userId === user?.id);
  const userNameFor = (userId: string) =>
    teamUsers?.find((u) => u.id === userId)?.name ?? (userId === user?.id ? 'You' : 'Unknown user');

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 md:px-6 md:py-8">
      <button
        onClick={() => router.push('/settings')}
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 transition-colors hover:text-slate-700"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Settings
      </button>

      <div className="flex items-center gap-4 rounded-xl bg-white p-6 shadow-xs">
        <MessengerIcon messenger={messenger} size={44} />
        <div>
          <h1 className="text-xl font-semibold text-slate-900">{info.name}</h1>
          <p className="text-sm text-slate-500">{info.description}</p>
        </div>
      </div>

      {/* Admin view: every org connection for this messenger */}
      {admin && (
        <div className="mt-6">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">Organization connections</h2>
          {allForMessenger.length === 0 ? (
            <p className="text-sm text-slate-500">No one has connected {info.name} yet.</p>
          ) : (
            <div className="space-y-2">
              {allForMessenger.map((integration) => (
                <div key={integration.id} className="flex items-center justify-between rounded-xl bg-white p-4 shadow-xs">
                  <div>
                    <p className="text-sm font-medium text-slate-800">{userNameFor(integration.userId)}</p>
                    <p className="text-xs text-slate-500">
                      {integration.status === 'connected' ? 'Connected' : integration.status}
                    </p>
                  </div>
                  <button
                    onClick={() =>
                      disconnectById.mutate(integration.id, {
                        onSuccess: () => toast.success(`Disconnected ${userNameFor(integration.userId)}'s ${info.name}`),
                        onError: (err) => toast.error(humanizeError(err, 'Failed to disconnect')),
                      })
                    }
                    disabled={disconnectById.isPending}
                    className="flex items-center gap-1.5 rounded-lg border-[1.5px] border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50"
                  >
                    <Unplug className="h-3.5 w-3.5" />
                    Disconnect
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* My account */}
      <div className="mt-6">
        <h2 className="mb-3 text-sm font-semibold text-slate-700">My account</h2>
        {mine ? (
          <div className="flex items-center justify-between rounded-xl bg-white p-4 shadow-xs">
            <p className="text-sm text-slate-700">
              {mine.status === 'connected' ? 'Connected' : `Status: ${mine.status}`}
            </p>
            {(admin || selfConnectAllowed) && (
              <button
                onClick={() =>
                  disconnectMine.mutate(messenger, {
                    onSuccess: () => toast.success(`${info.name} disconnected`),
                    onError: (err) => toast.error(humanizeError(err, 'Failed to disconnect')),
                  })
                }
                disabled={disconnectMine.isPending}
                className="flex items-center gap-1.5 rounded-lg border-[1.5px] border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50"
              >
                <Unplug className="h-3.5 w-3.5" />
                Disconnect
              </button>
            )}
          </div>
        ) : admin || selfConnectAllowed ? (
          <button
            onClick={() => setConnecting(true)}
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white shadow-accent-sm transition-all hover:bg-accent-hover hover:-translate-y-px motion-safe:active:translate-y-0 motion-safe:active:scale-[0.98]"
          >
            <Plug className="h-4 w-4" />
            Connect {info.name}
          </button>
        ) : (
          <div className="flex items-start gap-2 rounded-lg bg-amber-50 p-3">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <p className="text-xs text-amber-700">
              You don&apos;t have permission to connect your own {info.name} account. Ask your admin to enable it or
              connect it for you from your Team card.
            </p>
          </div>
        )}
      </div>

      {connecting && <ConnectModal messenger={info} onClose={() => setConnecting(false)} />}
    </div>
  );
}
