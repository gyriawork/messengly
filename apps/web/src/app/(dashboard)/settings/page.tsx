'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { Settings, Building2, User, Plug, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { IntegrationsTab, messengers } from '@/components/settings/IntegrationsTab';
import { WorkspaceTab } from '@/components/settings/WorkspaceTab';
import { ProfileTab } from '@/components/settings/ProfileTab';
import { OrganizationTab } from '@/components/settings/OrganizationTab';
import { MessengerIcon } from '@/components/ui/MessengerIcon';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/auth';
import { can } from '@/lib/permissions';

type Tab = 'integrations' | 'my-messengers' | 'workspace' | 'organization' | 'profile';

const ALL_TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: 'integrations', label: 'Integrations', icon: Settings },
  { id: 'my-messengers', label: 'My Messengers', icon: Plug },
  { id: 'workspace', label: 'Workspace', icon: Building2 },
  { id: 'organization', label: 'Organization', icon: Building2 },
  { id: 'profile', label: 'Profile', icon: User },
];

/** Entry point for a plain user with canSelfConnectMessengers — links out to
 * each messenger's own settings page (Task 4). Admin+ uses the fuller
 * Integrations tab instead, so this only ever renders for a self-connecting
 * `user`. Teams is included since Task 8: a self-connecting user gets their
 * own isolated Teams browser session, separate from the org's shared one. */
function MyMessengersTab() {
  return (
    <div className="space-y-3">
      {messengers.map((m) => (
        <Link
          key={m.key}
          href={`/settings/messengers/${m.key}`}
          className="flex items-center justify-between rounded-xl bg-white p-4 shadow-xs transition-shadow hover:shadow-sm"
        >
          <div className="flex items-center gap-3">
            <MessengerIcon messenger={m.key} size={36} />
            <div>
              <p className="text-sm font-medium text-slate-800">{m.name}</p>
              <p className="text-xs text-slate-500">{m.description}</p>
            </div>
          </div>
          <ChevronRight className="h-4 w-4 text-slate-300" />
        </Link>
      ))}
    </div>
  );
}

const oauthErrorMessages: Record<string, string> = {
  oauth_not_configured: 'OAuth is not configured on the server. Please use manual credential input.',
  no_organization: 'No organization selected. Please select an organization in the sidebar first.',
  missing_params: 'OAuth callback received incomplete data. Please try again.',
  invalid_or_expired_state: 'OAuth session expired. Please try connecting again.',
  corrupted_state: 'OAuth session was corrupted. Please try connecting again.',
  token_exchange_failed: 'Failed to exchange authorization code. Please try again.',
  token_verification_failed: 'Token could not be verified. Please try again.',
  access_denied: 'You denied the authorization request.',
  no_refresh_token: 'Google did not return a refresh token. Please revoke app access at myaccount.google.com/permissions and try again.',
};

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<Tab>('integrations');
  const [autoOpenMessenger, setAutoOpenMessenger] = useState<string | null>(null);
  const searchParams = useSearchParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);

  // Admin+ manages messenger integrations (Task 3/4 widened this from
  // superadmin-only) — org admins run their own team (Workspace) and
  // branding (Organization); everyone gets Profile.
  const isSuperadmin = user?.role === 'superadmin';
  const isAdmin = user?.role === 'admin';
  const canManageOrg = isSuperadmin || isAdmin;
  const canBrand = canManageOrg;
  const tabs = ALL_TABS.filter((t) => {
    if (t.id === 'profile') return true;
    if (t.id === 'organization') return canBrand;
    if (t.id === 'workspace') return canManageOrg;
    if (t.id === 'my-messengers') return !canManageOrg && can(user, 'canSelfConnectMessengers');
    return canManageOrg; // integrations
  });

  // Keep the active tab valid when the role-filtered tab set changes.
  useEffect(() => {
    if (!tabs.some((t) => t.id === activeTab)) {
      setActiveTab(tabs[0].id);
    }
  }, [tabs, activeTab]);

  // Handle OAuth callback query parameters
  useEffect(() => {
    const integration = searchParams.get('integration');
    const status = searchParams.get('status');
    const error = searchParams.get('error');

    if (!integration || !status) return;

    if (status === 'connected') {
      toast.success(`${integration.charAt(0).toUpperCase() + integration.slice(1)} connected successfully via OAuth`);
      // Await fresh data before opening wizard — prevents race condition
      // where wizard sees stale "disconnected" status
      (async () => {
        await queryClient.invalidateQueries({ queryKey: ['integrations'] });
        setAutoOpenMessenger(integration as 'telegram' | 'slack' | 'whatsapp' | 'gmail');
      })();
    } else if (status === 'error' && error) {
      const friendlyMessage = oauthErrorMessages[error] ?? `OAuth error: ${error}`;
      toast.error(friendlyMessage);
    }

    // Clean up URL query params after handling
    router.replace('/settings', { scroll: false });
  }, [searchParams, router, queryClient]);

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-4xl px-4 py-6 md:px-6 md:py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-semibold text-slate-900">Settings</h1>
          <p className="mt-1 text-sm text-slate-500">
            Manage your integrations, workspace, and profile
          </p>
        </div>

        {/* Tab Navigation */}
        <div className="mb-8 flex gap-1 overflow-x-auto rounded-lg bg-slate-100 p-1">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={cn(
                'flex flex-1 flex-shrink-0 items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm font-medium transition-all',
                activeTab === id
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-500 hover:text-slate-700',
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        {activeTab === 'integrations' && canManageOrg && (
          <IntegrationsTab
            autoOpenMessenger={autoOpenMessenger}
            onAutoOpenHandled={() => setAutoOpenMessenger(null)}
          />
        )}
        {activeTab === 'my-messengers' && <MyMessengersTab />}
        {activeTab === 'workspace' && canManageOrg && <WorkspaceTab />}
        {activeTab === 'organization' && canBrand && <OrganizationTab />}
        {activeTab === 'profile' && <ProfileTab />}
      </div>
    </div>
  );
}
