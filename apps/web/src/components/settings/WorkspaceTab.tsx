'use client';

import { useState } from 'react';
import {
  Loader2,
  UserPlus,
  X,
  Shield,
  ShieldCheck,
  User,
  MoreHorizontal,
  Ban,
  CheckCircle2,
} from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useWorkspaceSettings } from '@/hooks/useActivity';
import { api } from '@/lib/api';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/auth';

// ─── Types ───

interface OrgUser {
  id: string;
  email: string;
  name: string;
  role: 'superadmin' | 'admin' | 'user';
  status: 'active' | 'deactivated';
  lastActiveAt?: string;
  createdAt: string;
}

// ─── Constants ───


const roleConfig = {
  superadmin: {
    label: 'Super Admin',
    icon: ShieldCheck,
    badgeClass: 'bg-purple-50 text-purple-700',
  },
  admin: {
    label: 'Admin',
    icon: Shield,
    badgeClass: 'bg-accent-bg text-accent',
  },
  user: {
    label: 'User',
    icon: User,
    badgeClass: 'bg-slate-100 text-slate-600',
  },
};

// ─── Invite form schema ───

const inviteSchema = z.object({
  email: z.string().email('Enter a valid email'),
  name: z.string().min(1, 'Name is required'),
  role: z.enum(['admin', 'user']),
});

type InviteFormData = z.infer<typeof inviteSchema>;

// ─── Invite Modal ───

function InviteUserModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<InviteFormData>({
    resolver: zodResolver(inviteSchema),
    defaultValues: { role: 'user' },
  });

  const inviteMutation = useMutation({
    mutationFn: (data: InviteFormData) => api.post('/api/users/invite', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace-users'] });
      toast.success('User invited successfully');
      onClose();
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to invite user');
    },
  });

  const inputClass = cn(
    'w-full rounded-lg border-[1.5px] border-slate-200 px-3 py-2 text-sm transition-colors',
    'placeholder:text-slate-400 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15',
  );

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm motion-safe:animate-overlay-in md:items-center">
      <div className="w-full max-h-[100dvh] overflow-y-auto rounded-t-2xl bg-white p-6 shadow-lg motion-safe:animate-modal-in md:max-w-md md:rounded-xl">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Invite Team Member</h3>
            <p className="text-xs text-slate-500">
              They will receive an email with login credentials
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit((d) => inviteMutation.mutate(d))} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">
              Full Name
            </label>
            <input
              {...register('name')}
              placeholder="John Doe"
              className={cn(inputClass, errors.name && 'border-red-300')}
            />
            {errors.name && (
              <p className="mt-1 text-xs text-red-500">{errors.name.message}</p>
            )}
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">
              Email Address
            </label>
            <input
              {...register('email')}
              type="email"
              placeholder="john@company.com"
              className={cn(inputClass, errors.email && 'border-red-300')}
            />
            {errors.email && (
              <p className="mt-1 text-xs text-red-500">{errors.email.message}</p>
            )}
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">
              Role
            </label>
            <div className="grid grid-cols-2 gap-3">
              {(['user', 'admin'] as const).map((r) => {
                const cfg = roleConfig[r];
                return (
                  <label
                    key={r}
                    className={cn(
                      'flex cursor-pointer items-center gap-3 rounded-lg border-[1.5px] p-3 transition-colors',
                      'has-[:checked]:border-accent has-[:checked]:bg-accent-bg',
                      'border-slate-200 hover:border-slate-300',
                    )}
                  >
                    <input
                      {...register('role')}
                      type="radio"
                      value={r}
                      className="sr-only"
                    />
                    <cfg.icon className="h-4 w-4 text-slate-500" />
                    <div>
                      <p className="text-sm font-medium text-slate-800">{cfg.label}</p>
                      <p className="text-[11px] text-slate-500">
                        {r === 'admin'
                          ? 'Can manage chats, users, broadcasts'
                          : 'Can view chats and send messages'}
                      </p>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          <button
            type="submit"
            disabled={inviteMutation.isPending}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white transition-all hover:bg-accent-hover hover:-translate-y-px motion-safe:active:translate-y-0 motion-safe:active:scale-[0.98] disabled:opacity-50"
          >
            {inviteMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <UserPlus className="h-4 w-4" />
            )}
            Send Invite
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── User Row Actions ───

function UserActions({
  user,
  currentUserId,
}: {
  user: OrgUser;
  currentUserId?: string;
}) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const updateMutation = useMutation({
    mutationFn: (data: { name?: string; role?: string; status?: string }) =>
      api.patch(`/api/users/${user.id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace-users'] });
      toast.success('User updated');
      setOpen(false);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to update user');
    },
  });

  const isSelf = user.id === currentUserId;
  const isDeactivated = user.status === 'deactivated';

  if (isSelf || user.role === 'superadmin') return null;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-1 w-48 rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
            {/* Role change */}
            {user.role === 'user' && (
              <button
                onClick={() => updateMutation.mutate({ role: 'admin' })}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
              >
                <Shield className="h-3.5 w-3.5" />
                Promote to Admin
              </button>
            )}
            {user.role === 'admin' && (
              <button
                onClick={() => updateMutation.mutate({ role: 'user' })}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
              >
                <User className="h-3.5 w-3.5" />
                Demote to User
              </button>
            )}

            {/* Status toggle */}
            <button
              onClick={() =>
                updateMutation.mutate({
                  status: isDeactivated ? 'active' : 'deactivated',
                })
              }
              className={cn(
                'flex w-full items-center gap-2 px-3 py-2 text-left text-sm',
                isDeactivated
                  ? 'text-emerald-600 hover:bg-emerald-50'
                  : 'text-red-600 hover:bg-red-50',
              )}
            >
              {isDeactivated ? (
                <>
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Activate
                </>
              ) : (
                <>
                  <Ban className="h-3.5 w-3.5" />
                  Deactivate
                </>
              )}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Team Members Section ───

function TeamMembersSection() {
  const [showInvite, setShowInvite] = useState(false);
  const currentUser = useAuthStore((s) => s.user);

  // GET /api/users returns a bare array
  const { data, isLoading } = useQuery<OrgUser[]>({
    queryKey: ['workspace-users'],
    queryFn: () => api.get('/api/users'),
  });

  const users = data ?? [];
  const activeCount = users.filter((u) => u.status === 'active').length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            Team Members
          </h2>
          <p className="text-sm text-slate-500">
            {activeCount} active member{activeCount !== 1 ? 's' : ''} in your workspace
          </p>
        </div>
        <button
          onClick={() => setShowInvite(true)}
          className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:bg-accent-hover hover:-translate-y-px motion-safe:active:translate-y-0 motion-safe:active:scale-[0.98]"
        >
          <UserPlus className="h-4 w-4" />
          Invite User
        </button>
      </div>

      <div className="overflow-hidden rounded-lg bg-white shadow-xs">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-accent" />
          </div>
        ) : users.length === 0 ? (
          <div className="py-12 text-center">
            <User className="mx-auto mb-2 h-8 w-8 text-slate-300" />
            <p className="text-sm text-slate-500">No team members yet</p>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/50">
                <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500">
                  User
                </th>
                <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500">
                  Role
                </th>
                <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500">
                  Status
                </th>
                <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500">
                  Last Active
                </th>
                <th className="w-10 px-3 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {users.map((user) => {
                const role = roleConfig[user.role] ?? roleConfig.user;
                const RoleIcon = role.icon;
                const isDeactivated = user.status === 'deactivated';
                const isSelf = user.id === currentUser?.id;
                const initials = user.name
                  .split(' ')
                  .map((w) => w[0])
                  .join('')
                  .toUpperCase()
                  .slice(0, 2);

                return (
                  <tr
                    key={user.id}
                    className={cn(
                      'transition-colors hover:bg-slate-50/50',
                      isDeactivated && 'opacity-50',
                    )}
                  >
                    {/* User info */}
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-avatar bg-accent-bg text-xs font-semibold text-accent">
                          {initials}
                        </div>
                        <div>
                          <p className="text-sm font-medium text-slate-800">
                            {user.name}
                            {isSelf && (
                              <span className="ml-1.5 text-xs font-normal text-slate-400">
                                (you)
                              </span>
                            )}
                          </p>
                          <p className="text-xs text-slate-500">{user.email}</p>
                        </div>
                      </div>
                    </td>

                    {/* Role */}
                    <td className="px-5 py-3.5">
                      <span
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
                          role.badgeClass,
                        )}
                      >
                        <RoleIcon className="h-3 w-3" />
                        {role.label}
                      </span>
                    </td>

                    {/* Status */}
                    <td className="px-5 py-3.5">
                      <span
                        className={cn(
                          'inline-flex items-center gap-1.5 text-xs font-medium',
                          isDeactivated ? 'text-red-500' : 'text-emerald-600',
                        )}
                      >
                        <span
                          className={cn(
                            'h-1.5 w-1.5 rounded-full',
                            isDeactivated ? 'bg-red-400' : 'bg-emerald-500',
                          )}
                        />
                        {isDeactivated ? 'Deactivated' : 'Active'}
                      </span>
                    </td>

                    {/* Last active */}
                    <td className="px-5 py-3.5 text-xs text-slate-500">
                      {user.lastActiveAt
                        ? new Date(user.lastActiveAt).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : 'Never'}
                    </td>

                    {/* Actions */}
                    <td className="px-3 py-3.5">
                      <UserActions user={user} currentUserId={currentUser?.id} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {showInvite && <InviteUserModal onClose={() => setShowInvite(false)} />}
    </div>
  );
}

// ─── Main Component ───

export function WorkspaceTab() {
  const { data: settings, isLoading } = useWorkspaceSettings();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-10">
      {/* Workspace Settings */}
      <div className="space-y-4">
        <div className="mb-2">
          <h2 className="text-base font-semibold text-slate-900">
            Workspace Settings
          </h2>
          <p className="text-sm text-slate-500">
            Your organization info
          </p>
        </div>

        <div className="rounded-lg bg-white p-6 shadow-xs">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">
              Organization Name
            </label>
            <p className="text-sm text-slate-900">
              {settings?.name || '—'}
            </p>
          </div>
        </div>
      </div>

      {/* Team Members */}
      <TeamMembersSection />
    </div>
  );
}
