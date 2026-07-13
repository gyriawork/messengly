'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Pencil,
  KeyRound,
  Users as UsersIcon,
  MessageSquare,
  Send,
  Loader2,
  Ban,
  CheckCircle2,
  Trash2,
  Power,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import { humanizeError } from '@/lib/errors';
import { formatDate } from '@/lib/dates';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  useOrganizations,
  useUpdateOrganization,
  useOrganizationStats,
} from '@/hooks/useOrganizations';
import { useAuthStore } from '@/stores/auth';

interface OrgUser {
  id: string;
  email: string;
  name: string;
  role: 'superadmin' | 'admin' | 'user';
  status: 'active' | 'deactivated';
  lastActiveAt: string | null;
}

const ROLE_LABEL: Record<OrgUser['role'], string> = {
  superadmin: 'Superadmin',
  admin: 'Admin',
  user: 'User',
};

export default function OrganizationSettingsPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const me = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();

  const { data: orgs, isLoading: orgsLoading } = useOrganizations();
  const org = orgs?.find((o) => o.id === id);
  const { data: stats } = useOrganizationStats(id);

  // Users of THIS org (not the sidebar selection) — bare array response.
  const { data: usersData, isLoading: usersLoading } = useQuery<OrgUser[]>({
    queryKey: ['org-users', id],
    queryFn: () => api.get(`/api/users?organizationId=${id}`),
    enabled: !!id,
  });
  const users = usersData ?? [];

  const updateOrg = useUpdateOrganization();

  const updateUser = useMutation({
    mutationFn: ({ userId, ...data }: { userId: string; name?: string; email?: string; password?: string; status?: string }) =>
      api.patch(`/api/users/${userId}`, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['org-users', id] }),
  });

  const deleteUser = useMutation({
    mutationFn: (userId: string) => api.delete(`/api/users/${userId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['org-users', id] }),
  });

  const toggleUserStatus = (u: OrgUser) =>
    updateUser.mutate(
      { userId: u.id, status: u.status === 'active' ? 'deactivated' : 'active' },
      {
        onSuccess: () =>
          toast.success(u.status === 'active' ? `${u.name} deactivated` : `${u.name} activated`),
        onError: (err) => toast.error(humanizeError(err, 'Failed to update user')),
      },
    );

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [confirmSuspend, setConfirmSuspend] = useState(false);
  const [editingUser, setEditingUser] = useState<OrgUser | null>(null);
  const [deletingUser, setDeletingUser] = useState<OrgUser | null>(null);

  if (me?.role !== 'superadmin') {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-slate-500">
          You need superadmin privileges to view this page.
        </p>
      </div>
    );
  }

  if (orgsLoading) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-6 md:px-6 md:py-8">
        <Skeleton className="h-7 w-64" />
        <Skeleton className="mt-6 h-40 w-full rounded-xl" />
        <Skeleton className="mt-4 h-64 w-full rounded-xl" />
      </div>
    );
  }

  if (!org) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-sm text-slate-500">Organization not found.</p>
        <Button variant="secondary" onClick={() => router.push('/admin')}>
          Back to Admin
        </Button>
      </div>
    );
  }

  const saveName = () => {
    const name = nameDraft.trim();
    if (!name || name === org.name) {
      setEditingName(false);
      return;
    }
    updateOrg.mutate(
      { id: org.id, name },
      {
        onSuccess: () => {
          toast.success('Organization renamed');
          setEditingName(false);
        },
        onError: (err) => toast.error(humanizeError(err, 'Failed to rename')),
      },
    );
  };

  const setStatus = (status: 'active' | 'suspended') => {
    updateOrg.mutate(
      { id: org.id, status },
      {
        onSuccess: () => {
          toast.success(status === 'active' ? 'Organization activated' : 'Organization suspended');
          setConfirmSuspend(false);
        },
        onError: (err) => toast.error(humanizeError(err, 'Failed to update status')),
      },
    );
  };

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 md:px-6 md:py-8">
      {/* Header */}
      <button
        onClick={() => router.push('/admin')}
        className="mb-4 flex items-center gap-1.5 text-sm text-slate-500 transition-colors hover:text-slate-700"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Organizations
      </button>

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold text-slate-900">{org.name}</h1>
        <StatusBadge tone={org.status === 'active' ? 'positive' : 'negative'} dot>
          {org.status === 'active' ? 'Active' : 'Suspended'}
        </StatusBadge>
        <span className="text-sm text-slate-400">
          Created {formatDate(org.createdAt)}
        </span>
      </div>

      {/* Quick stats */}
      <div className="mb-6 grid grid-cols-3 gap-3">
        {[
          { icon: UsersIcon, label: 'Users', value: stats?.userCount ?? org._count?.users ?? 0 },
          { icon: MessageSquare, label: 'Chats', value: stats?.chatCount ?? org._count?.chats ?? 0 },
          { icon: Send, label: 'Broadcasts', value: stats?.broadcastCount ?? org._count?.broadcasts ?? 0 },
        ].map(({ icon: Icon, label, value }) => (
          <div key={label} className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <Icon className="h-3.5 w-3.5" />
              {label}
            </div>
            <p className="mt-1 text-xl font-semibold text-slate-900">{value.toLocaleString()}</p>
          </div>
        ))}
      </div>

      {/* General */}
      <div className="mb-6 rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="mb-4 text-base font-semibold text-slate-900">General</h2>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-slate-700">Organization name</p>
            {editingName ? (
              <div className="mt-1.5 flex items-center gap-2">
                <input
                  autoFocus
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveName();
                    if (e.key === 'Escape') setEditingName(false);
                  }}
                  className="rounded-lg border-[1.5px] border-slate-200 px-3 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15"
                />
                <Button size="sm" loading={updateOrg.isPending} onClick={saveName}>
                  Save
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditingName(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <p className="mt-0.5 text-sm text-slate-500">{org.name}</p>
            )}
          </div>
          {!editingName && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setNameDraft(org.name);
                setEditingName(true);
              }}
            >
              <Pencil className="h-4 w-4" />
              Rename
            </Button>
          )}
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-5">
          <div>
            <p className="text-sm font-medium text-slate-700">
              {org.status === 'active' ? 'Suspend organization' : 'Activate organization'}
            </p>
            <p className="mt-0.5 max-w-md text-sm text-slate-500">
              {org.status === 'active'
                ? 'Members of a suspended organization cannot sign in. They see "This platform is currently unavailable. Please contact us."'
                : 'This organization is suspended: its members cannot sign in. Activate it to restore access.'}
            </p>
          </div>
          {org.status === 'active' ? (
            <Button variant="danger" onClick={() => setConfirmSuspend(true)}>
              <Ban className="h-4 w-4" />
              Suspend
            </Button>
          ) : (
            <Button loading={updateOrg.isPending} onClick={() => setStatus('active')}>
              <CheckCircle2 className="h-4 w-4" />
              Activate
            </Button>
          )}
        </div>
      </div>

      {/* Users */}
      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="mb-1 text-base font-semibold text-slate-900">Users</h2>
        <p className="mb-4 text-sm text-slate-500">
          Everyone in this organization. Rename, change email or password, activate/deactivate, or remove.
        </p>

        {usersLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        ) : users.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-400">
            No users in this organization yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-100">
                  {['Name', 'Email', 'Role', 'Status', 'Last active', ''].map((h) => (
                    <th
                      key={h}
                      className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-slate-500"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-b border-slate-50 transition-colors hover:bg-slate-50/50">
                    <td className="px-3 py-2.5 text-sm font-medium text-slate-800">{u.name}</td>
                    <td className="px-3 py-2.5 text-sm text-slate-500">{u.email}</td>
                    <td className="px-3 py-2.5">
                      <span
                        className={cn(
                          'inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium',
                          u.role === 'admin'
                            ? 'bg-accent-bg text-accent'
                            : 'bg-slate-100 text-slate-600',
                        )}
                      >
                        {ROLE_LABEL[u.role]}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <StatusBadge tone={u.status === 'active' ? 'positive' : 'neutral'}>
                        {u.status === 'active' ? 'Active' : 'Deactivated'}
                      </StatusBadge>
                    </td>
                    <td className="px-3 py-2.5 text-sm text-slate-500">
                      {u.lastActiveAt ? formatDate(u.lastActiveAt) : '—'}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => toggleUserStatus(u)}
                          title={u.status === 'active' ? 'Deactivate' : 'Activate'}
                        >
                          <Power className="h-3.5 w-3.5" />
                          {u.status === 'active' ? 'Deactivate' : 'Activate'}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setEditingUser(u)}>
                          <KeyRound className="h-3.5 w-3.5" />
                          Edit
                        </Button>
                        {u.id !== me?.id && (
                          <button
                            onClick={() => setDeletingUser(u)}
                            title="Delete user"
                            className="rounded p-1.5 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-500"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Suspend confirmation */}
      {confirmSuspend && (
        <Modal
          title="Suspend this organization?"
          subtitle={`${org.name} · ${users.length} user${users.length === 1 ? '' : 's'}`}
          onClose={() => setConfirmSuspend(false)}
        >
          <p className="text-sm text-slate-600">
            Every member will be locked out at their next sign-in and shown
            &ldquo;This platform is currently unavailable. Please contact us.&rdquo;
            You can activate the organization again at any time.
          </p>
          <div className="mt-5 flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={() => setConfirmSuspend(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              className="flex-1"
              loading={updateOrg.isPending}
              onClick={() => setStatus('suspended')}
            >
              Suspend
            </Button>
          </div>
        </Modal>
      )}

      {/* Delete user */}
      {deletingUser && (
        <Modal
          title={`Delete ${deletingUser.name}?`}
          subtitle={deletingUser.email}
          onClose={() => setDeletingUser(null)}
        >
          <p className="text-sm text-slate-600">
            This user will no longer be able to sign in, and their email is freed
            up so it can be used for a new account. Their broadcasts and imported
            chats stay in place.
          </p>
          <div className="mt-5 flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={() => setDeletingUser(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              className="flex-1"
              loading={deleteUser.isPending}
              onClick={() =>
                deleteUser.mutate(deletingUser.id, {
                  onSuccess: () => {
                    toast.success(`${deletingUser.name} deleted`);
                    setDeletingUser(null);
                  },
                  onError: (err) => toast.error(humanizeError(err, 'Failed to delete user')),
                })
              }
            >
              Delete
            </Button>
          </div>
        </Modal>
      )}

      {/* Edit user */}
      {editingUser && (
        <EditUserModal
          user={editingUser}
          isPending={updateUser.isPending}
          onClose={() => setEditingUser(null)}
          onSubmit={(data) => {
            updateUser.mutate(
              { userId: editingUser.id, ...data },
              {
                onSuccess: () => {
                  toast.success(`${data.name ?? editingUser.name} updated`);
                  setEditingUser(null);
                },
                onError: (err) => toast.error(humanizeError(err, 'Failed to update user')),
              },
            );
          }}
        />
      )}
    </div>
  );
}

function EditUserModal({
  user,
  isPending,
  onClose,
  onSubmit,
}: {
  user: OrgUser;
  isPending: boolean;
  onClose: () => void;
  onSubmit: (data: { name?: string; email?: string; password?: string }) => void;
}) {
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [password, setPassword] = useState('');

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const passwordTooShort = password.length > 0 && password.length < 8;
  const nothingChanged =
    name.trim() === user.name &&
    email.trim() === user.email &&
    password.length === 0;

  const submit = () => {
    if (passwordTooShort || nothingChanged || !emailValid) return;
    const data: { name?: string; email?: string; password?: string } = {};
    if (name.trim() && name.trim() !== user.name) data.name = name.trim();
    if (email.trim() && email.trim() !== user.email) data.email = email.trim().toLowerCase();
    if (password) data.password = password;
    onSubmit(data);
  };

  return (
    <Modal title={`Edit ${user.name}`} subtitle={user.email} onClose={onClose}>
      <div className="space-y-4">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-700">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border-[1.5px] border-slate-200 px-3 py-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-700">Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={cn(
              'w-full rounded-lg border-[1.5px] px-3 py-2 text-sm focus:outline-none focus:ring-2',
              email.trim() && !emailValid
                ? 'border-red-300 focus:border-red-400 focus:ring-red-100'
                : 'border-slate-200 focus:border-accent focus:ring-accent/15',
            )}
          />
          <p className="mt-1 text-xs text-slate-400">The address this person signs in with.</p>
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-700">New password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Leave empty to keep the current one"
            className={cn(
              'w-full rounded-lg border-[1.5px] px-3 py-2 text-sm focus:outline-none focus:ring-2',
              passwordTooShort
                ? 'border-red-300 focus:border-red-400 focus:ring-red-100'
                : 'border-slate-200 focus:border-accent focus:ring-accent/15',
            )}
          />
          {passwordTooShort && (
            <p className="mt-1 text-xs text-red-500">At least 8 characters</p>
          )}
        </div>
        <div className="flex gap-2 pt-1">
          <Button variant="secondary" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button
            className="flex-1"
            loading={isPending}
            disabled={nothingChanged || passwordTooShort || !emailValid}
            onClick={submit}
          >
            {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}
