'use client';

import Link from 'next/link';
import { Shield, ShieldCheck, User as UserIcon, ChevronRight } from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import { isAdmin } from '@/lib/permissions';
import { useTeamUsers } from '@/hooks/useUsers';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { RequireOrgContext } from '@/components/layout/RequireOrgContext';

const roleConfig = {
  superadmin: { label: 'Super Admin', icon: ShieldCheck, badgeClass: 'bg-purple-50 text-purple-700' },
  admin: { label: 'Admin', icon: Shield, badgeClass: 'bg-accent-bg text-accent' },
  user: { label: 'User', icon: UserIcon, badgeClass: 'bg-slate-100 text-slate-600' },
};

const permissionLabels: Array<{ key: 'canCreateTags' | 'canSelfConnectMessengers'; label: string }> = [
  { key: 'canCreateTags', label: 'Create tags' },
  { key: 'canSelfConnectMessengers', label: 'Self-connect' },
];

export default function TeamPage() {
  const user = useAuthStore((s) => s.user);
  const { data, isLoading } = useTeamUsers();

  if (!isAdmin(user)) {
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

  const members = (data ?? []).filter((u) => u.role !== 'superadmin');

  return (
    <RequireOrgContext>
      <div className="mx-auto max-w-4xl px-4 py-6 md:px-6 md:py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-slate-900">Team</h1>
          <p className="mt-1 text-sm text-slate-500">
            {members.length} member{members.length !== 1 ? 's' : ''} in your organization
          </p>
        </div>

        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 rounded-xl bg-white p-5 shadow-xs">
                <Skeleton className="h-9 w-9 rounded-full" />
                <Skeleton className="h-4 w-40" />
              </div>
            ))}
          </div>
        ) : members.length === 0 ? (
          <EmptyState
            icon={<UserIcon className="h-12 w-12" />}
            title="No team members yet"
            description="Invite teammates from Settings → Workspace to get started."
          />
        ) : (
          <div className="space-y-3">
            {members.map((member) => {
              const cfg = roleConfig[member.role];
              const RoleIcon = cfg.icon;
              return (
                <Link
                  key={member.id}
                  href={`/team/${member.id}`}
                  className="flex items-center justify-between rounded-xl bg-white p-5 shadow-xs transition-shadow hover:shadow-sm"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-sm font-semibold text-slate-600">
                      {member.name.slice(0, 1).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-800">{member.name}</p>
                      <p className="truncate text-xs text-slate-500">{member.email}</p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <div className="hidden items-center gap-1.5 sm:flex">
                      {permissionLabels.map(({ key, label }) =>
                        member.permissions[key] ? (
                          <span
                            key={key}
                            className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500"
                          >
                            {label}
                          </span>
                        ) : null,
                      )}
                    </div>
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${cfg.badgeClass}`}
                    >
                      <RoleIcon className="h-3 w-3" />
                      {cfg.label}
                    </span>
                    {member.status === 'deactivated' && (
                      <span className="rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-600">
                        Deactivated
                      </span>
                    )}
                    <ChevronRight className="h-4 w-4 text-slate-300" />
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </RequireOrgContext>
  );
}
