'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Shield, ShieldCheck, User as UserIcon, KeyRound, Ban, CheckCircle2, Unplug, Plug } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { humanizeError } from '@/lib/errors';
import { useAuthStore } from '@/stores/auth';
import { isAdmin } from '@/lib/permissions';
import { useTeamUsers, useUpdateTeamUser, type TeamUser } from '@/hooks/useUsers';
import { useIntegrations, useDisconnectIntegrationById } from '@/hooks/useIntegrations';
import { messengers, ConnectModal, type MessengerInfo } from '@/components/settings/IntegrationsTab';
import { MessengerIcon } from '@/components/ui/MessengerIcon';
import { CredentialReveal } from '@/components/settings/CredentialReveal';
import { Skeleton } from '@/components/ui/Skeleton';
import { RequireOrgContext } from '@/components/layout/RequireOrgContext';

const roleConfig = {
  superadmin: { label: 'Super Admin', icon: ShieldCheck, badgeClass: 'bg-purple-50 text-purple-700' },
  admin: { label: 'Admin', icon: Shield, badgeClass: 'bg-accent-bg text-accent' },
  user: { label: 'User', icon: UserIcon, badgeClass: 'bg-slate-100 text-slate-600' },
};

/** 14-char random password for admin-initiated resets (client-generated). */
function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint8Array(14);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

function PermissionToggle({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl bg-white p-4 shadow-xs">
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-800">{label}</p>
        <p className="mt-0.5 text-xs text-slate-500">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className="group shrink-0 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span
          className={cn(
            'relative block h-5 w-9 rounded-full transition-colors duration-300 ease-out',
            checked ? 'bg-accent' : 'bg-slate-300 group-hover:bg-slate-400',
          )}
        >
          <span
            className={cn(
              'absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-300 ease-out',
              checked && 'translate-x-4',
            )}
          />
        </span>
      </button>
    </div>
  );
}

export default function TeamMemberPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const currentUser = useAuthStore((s) => s.user);
  const { data, isLoading } = useTeamUsers();
  const updateMutation = useUpdateTeamUser();
  const [resetCredentials, setResetCredentials] = useState<{ email: string; password: string } | null>(null);
  const [connectingMessenger, setConnectingMessenger] = useState<MessengerInfo | null>(null);
  const { data: integrationsData } = useIntegrations();
  const disconnectById = useDisconnectIntegrationById();

  if (!isAdmin(currentUser)) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <p className="text-lg font-semibold text-slate-900">Access Denied</p>
          <p className="mt-1 text-sm text-slate-500">
            You need admin privileges to view this page.
          </p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-6 md:px-6 md:py-8">
        <Skeleton className="h-8 w-48" />
        <div className="mt-6 space-y-3">
          <Skeleton className="h-20 w-full rounded-xl" />
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-16 w-full rounded-xl" />
        </div>
      </div>
    );
  }

  const member = (data ?? []).find((u) => u.id === params.id);

  if (!member) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <p className="text-lg font-semibold text-slate-900">User not found</p>
          <Link href="/team" className="mt-2 inline-block text-sm text-accent hover:underline">
            Back to Team
          </Link>
        </div>
      </div>
    );
  }

  // An admin cannot manage other admins/superadmins — the API enforces this
  // too (users.ts PATCH /:id); mirror it here so controls aren't shown just to 403.
  const isSuperadmin = currentUser?.role === 'superadmin';
  const canManageThisUser = isSuperadmin || member.role === 'user';
  const cfg = roleConfig[member.role];
  const RoleIcon = cfg.icon;

  const setPermission = (key: 'canCreateTags' | 'canSelfConnectMessengers' | 'canViewAllChats', value: boolean) => {
    updateMutation.mutate(
      { id: member.id, [key]: value },
      {
        onError: (err) => toast.error(humanizeError(err, 'Failed to update permission')),
      },
    );
  };

  const toggleStatus = () => {
    const nextStatus = member.status === 'active' ? 'deactivated' : 'active';
    updateMutation.mutate(
      { id: member.id, status: nextStatus },
      {
        onSuccess: () => toast.success(nextStatus === 'active' ? 'User activated' : 'User deactivated'),
        onError: (err) => toast.error(humanizeError(err, 'Failed to update status')),
      },
    );
  };

  const resetPassword = () => {
    const password = generatePassword();
    updateMutation.mutate(
      { id: member.id, password },
      {
        onSuccess: () => setResetCredentials({ email: member.email, password }),
        onError: (err) => toast.error(humanizeError(err, 'Failed to reset password')),
      },
    );
  };

  return (
    <RequireOrgContext>
      <div className="mx-auto max-w-2xl px-4 py-6 md:px-6 md:py-8">
        <button
          onClick={() => router.push('/team')}
          className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 transition-colors hover:text-slate-700"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Team
        </button>

        {/* Profile */}
        <div className="flex items-center gap-4 rounded-xl bg-white p-6 shadow-xs">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-slate-100 text-lg font-semibold text-slate-600">
            {member.name.slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-semibold text-slate-900">{member.name}</h1>
            <p className="truncate text-sm text-slate-500">{member.email}</p>
          </div>
          <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${cfg.badgeClass}`}>
            <RoleIcon className="h-3.5 w-3.5" />
            {cfg.label}
          </span>
        </div>

        {!canManageThisUser ? (
          <p className="mt-4 text-sm text-slate-500">
            {member.role === 'admin' ? 'Admins' : 'Super admins'} manage their own account settings.
          </p>
        ) : (
          <>
            {/* Account actions */}
            <div className="mt-6 flex flex-wrap gap-2">
              <button
                onClick={resetPassword}
                disabled={updateMutation.isPending}
                className="flex items-center gap-2 rounded-lg border-[1.5px] border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50"
              >
                <KeyRound className="h-4 w-4" />
                Reset password
              </button>
              <button
                onClick={toggleStatus}
                disabled={updateMutation.isPending}
                className={cn(
                  'flex items-center gap-2 rounded-lg border-[1.5px] px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50',
                  member.status === 'active'
                    ? 'border-red-200 text-red-600 hover:bg-red-50'
                    : 'border-emerald-200 text-emerald-600 hover:bg-emerald-50',
                )}
              >
                {member.status === 'active' ? <Ban className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
                {member.status === 'active' ? 'Deactivate' : 'Activate'}
              </button>
            </div>

            {/* Permissions */}
            <div className="mt-6">
              <h2 className="mb-3 text-sm font-semibold text-slate-700">Permissions</h2>
              <div className="space-y-3">
                <PermissionToggle
                  label="Can create tags"
                  description="Create, rename, and delete labels used to organize chats."
                  checked={member.permissions.canCreateTags}
                  onChange={(v) => setPermission('canCreateTags', v)}
                  disabled={updateMutation.isPending}
                />
                <PermissionToggle
                  label="Can connect own messengers"
                  description="Connect and disconnect their own messenger accounts in Settings, without an admin's help."
                  checked={member.permissions.canSelfConnectMessengers}
                  onChange={(v) => setPermission('canSelfConnectMessengers', v)}
                  disabled={updateMutation.isPending}
                />
                <PermissionToggle
                  label="Can view all chats"
                  description="See every chat in the organization and filter by owner, instead of only their own."
                  checked={member.permissions.canViewAllChats}
                  onChange={(v) => setPermission('canViewAllChats', v)}
                  disabled={updateMutation.isPending}
                />
              </div>
            </div>

            {/* Connections */}
            <div className="mt-6">
              <h2 className="mb-3 text-sm font-semibold text-slate-700">Messenger connections</h2>
              {(() => {
                const theirs = (integrationsData?.integrations ?? []).filter((i) => i.userId === member.id);
                const connectedKeys = new Set(theirs.map((i) => i.messenger));
                const notConnected = messengers.filter((m) => !connectedKeys.has(m.key));
                return (
                  <div className="space-y-2">
                    {theirs.map((integration) => {
                      const info = messengers.find((m) => m.key === integration.messenger);
                      return (
                        <div key={integration.id} className="flex items-center justify-between rounded-xl bg-white p-4 shadow-xs">
                          <div className="flex items-center gap-3">
                            <MessengerIcon messenger={integration.messenger} size={32} />
                            <div>
                              <p className="text-sm font-medium text-slate-800">{info?.name ?? integration.messenger}</p>
                              <p className="text-xs text-slate-500">
                                {integration.status === 'connected' ? 'Connected' : integration.status}
                              </p>
                            </div>
                          </div>
                          <button
                            onClick={() =>
                              disconnectById.mutate(integration.id, {
                                onSuccess: () => toast.success(`${info?.name ?? integration.messenger} disconnected`),
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
                      );
                    })}
                    {notConnected.map((info) => (
                      <div key={info.key} className="flex items-center justify-between rounded-xl bg-white p-4 shadow-xs">
                        <div className="flex items-center gap-3">
                          <MessengerIcon messenger={info.key} size={32} />
                          <div>
                            <p className="text-sm font-medium text-slate-800">{info.name}</p>
                            <p className="text-xs text-slate-500">Not connected</p>
                          </div>
                        </div>
                        <button
                          onClick={() => setConnectingMessenger(info)}
                          className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover"
                        >
                          <Plug className="h-3.5 w-3.5" />
                          Connect
                        </button>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
          </>
        )}

        {connectingMessenger && (
          <ConnectModal
            messenger={connectingMessenger}
            onClose={() => setConnectingMessenger(null)}
            forUserId={member.id}
            forUserName={member.name}
          />
        )}

        {resetCredentials && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
            <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
              <h2 className="mb-4 text-lg font-semibold text-slate-900">Password reset</h2>
              <CredentialReveal
                email={resetCredentials.email}
                password={resetCredentials.password}
                note="Copy this password and pass it on to the user now — it won't be shown again."
                onDone={() => setResetCredentials(null)}
              />
            </div>
          </div>
        )}
      </div>
    </RequireOrgContext>
  );
}
