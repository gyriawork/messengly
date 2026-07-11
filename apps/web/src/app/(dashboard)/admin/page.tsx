'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  Plus,
  Building2,
  Users,
  MessageSquare,
  Send,
  X,
  BarChart3,
  ArrowLeft,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { formatDate } from '@/lib/dates';
import { useAuthStore } from '@/stores/auth';
import {
  useOrganizations,
  useCreateOrganization,
  useUpdateOrganization,
  useOrganizationStats,
} from '@/hooks/useOrganizations';
import type { Organization } from '@/hooks/useOrganizations';

const createOrgSchema = z.object({
  name: z.string().min(1, 'Organization name is required').max(100),
  adminEmail: z.string().email('Valid email required'),
  adminName: z.string().min(1, 'Admin name is required').max(100),
  adminPassword: z.string().min(8, 'Password must be at least 8 characters'),
});

type CreateOrgFormData = z.infer<typeof createOrgSchema>;

const editOrgSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  status: z.enum(['active', 'suspended']),
});

type EditOrgFormData = z.infer<typeof editOrgSchema>;

export default function AdminPage() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingOrg, setEditingOrg] = useState<Organization | null>(null);
  const [statsOrgId, setStatsOrgId] = useState<string | undefined>(undefined);

  const { data, isLoading } = useOrganizations();
  const { data: stats, isLoading: statsLoading } = useOrganizationStats(statsOrgId);
  const createMutation = useCreateOrganization();
  const updateMutation = useUpdateOrganization();

  // Guard: only superadmin
  if (user?.role !== 'superadmin') {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <p className="text-lg font-semibold text-slate-900">Access Denied</p>
          <p className="mt-1 text-sm text-slate-500">
            You need superadmin privileges to view this page.
          </p>
        </div>
      </div>
    );
  }

  const organizations = data?.organizations || [];

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 md:px-6 md:py-8">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Organizations</h1>
          <p className="mt-1 text-sm text-slate-500">
            Manage all organizations and their settings
          </p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white shadow-accent-sm transition-colors hover:bg-accent-hover"
        >
          <Plus className="h-4 w-4" />
          Create Organization
        </button>
      </div>

      {/* Stats Panel */}
      {statsOrgId && (
        <div className="mb-6 rounded-lg border border-slate-200 bg-white p-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">
              Organization Stats
            </h3>
            <button
              onClick={() => setStatsOrgId(undefined)}
              className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {statsLoading ? (
            <div className="flex items-center gap-2 text-sm text-slate-400">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
              Loading stats...
            </div>
          ) : stats ? (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
              <StatCard icon={Users} label="Users" value={stats.userCount} />
              <StatCard icon={MessageSquare} label="Chats" value={stats.chatCount} />
              <StatCard icon={Send} label="Broadcasts" value={stats.broadcastCount} />
              <StatCard icon={MessageSquare} label="Messages" value={stats.messageCount} />
              <StatCard icon={Building2} label="Integrations" value={stats.integrationCount} />
            </div>
          ) : (
            <p className="text-sm text-slate-400">Failed to load stats</p>
          )}
        </div>
      )}

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        {isLoading ? (
          <div className="flex items-center justify-center px-6 py-12">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          </div>
        ) : organizations.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-slate-400">
            No organizations yet. Create one to get started.
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/50">
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500">
                  Name
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500">
                  Status
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500">
                  Users
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500">
                  Chats
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500">
                  Broadcasts
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500">
                  Created
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {organizations.map((org) => (
                <tr
                  key={org.id}
                  className="border-b border-slate-50 transition-colors hover:bg-slate-50/50"
                >
                  <td className="px-4 py-3">
                    <span className="text-sm font-medium text-slate-900">
                      {org.name}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        'inline-flex rounded-full px-2 py-0.5 text-xs font-medium',
                        org.status === 'active'
                          ? 'bg-green-50 text-green-700'
                          : 'bg-red-50 text-red-700',
                      )}
                    >
                      {org.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-600">
                    {org._count?.users ?? '-'}
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-600">
                    {org._count?.chats ?? '-'}
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-600">
                    {org._count?.broadcasts ?? '-'}
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-500">
                    {formatDate(org.createdAt)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setEditingOrg(org)}
                        className="rounded px-2 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent-bg"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() =>
                          setStatsOrgId(statsOrgId === org.id ? undefined : org.id)
                        }
                        className="rounded px-2 py-1 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-100"
                      >
                        <BarChart3 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Create Modal */}
      {showCreateModal && (
        <CreateOrgModal
          onClose={() => setShowCreateModal(false)}
          onSubmit={async (data) => {
            try {
              await createMutation.mutateAsync(data);
              toast.success('Organization created');
              setShowCreateModal(false);
            } catch {
              toast.error('Failed to create organization');
            }
          }}
          isLoading={createMutation.isPending}
        />
      )}

      {/* Edit Modal */}
      {editingOrg && (
        <EditOrgModal
          organization={editingOrg}
          onClose={() => setEditingOrg(null)}
          onSubmit={async (data) => {
            try {
              await updateMutation.mutateAsync({
                id: editingOrg.id,
                ...data,
              });
              toast.success('Organization updated');
              setEditingOrg(null);
            } catch {
              toast.error('Failed to update organization');
            }
          }}
          isLoading={updateMutation.isPending}
        />
      )}
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ElementType;
  label: string;
  value: number;
}) {
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50/50 p-3">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-slate-400" />
        <span className="text-xs text-slate-500">{label}</span>
      </div>
      <p className="mt-1 text-lg font-semibold text-slate-900">
        {value.toLocaleString()}
      </p>
    </div>
  );
}

function CreateOrgModal({
  onClose,
  onSubmit,
  isLoading,
}: {
  onClose: () => void;
  onSubmit: (data: CreateOrgFormData) => void;
  isLoading: boolean;
}) {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<CreateOrgFormData>({
    resolver: zodResolver(createOrgSchema),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center">
      <div className="w-full max-h-[100dvh] overflow-y-auto rounded-t-2xl bg-white p-6 shadow-xl md:max-w-md md:rounded-xl">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">
            Create Organization
          </h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">
              Organization Name
            </label>
            <input
              {...register('name')}
              placeholder="Acme Corp"
              className={cn(
                'w-full rounded-lg border-[1.5px] bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 transition-shadow focus:outline-none focus:ring-2 focus:ring-accent/15',
                errors.name
                  ? 'border-red-300 focus:border-red-400'
                  : 'border-slate-200 focus:border-accent',
              )}
            />
            {errors.name && (
              <p className="mt-1 text-xs text-red-500">{errors.name.message}</p>
            )}
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">
              Admin Email
            </label>
            <input
              {...register('adminEmail')}
              type="email"
              placeholder="admin@acme.com"
              className={cn(
                'w-full rounded-lg border-[1.5px] bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 transition-shadow focus:outline-none focus:ring-2 focus:ring-accent/15',
                errors.adminEmail
                  ? 'border-red-300 focus:border-red-400'
                  : 'border-slate-200 focus:border-accent',
              )}
            />
            {errors.adminEmail && (
              <p className="mt-1 text-xs text-red-500">
                {errors.adminEmail.message}
              </p>
            )}
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">
              Admin Name
            </label>
            <input
              {...register('adminName')}
              placeholder="John Doe"
              className={cn(
                'w-full rounded-lg border-[1.5px] bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 transition-shadow focus:outline-none focus:ring-2 focus:ring-accent/15',
                errors.adminName
                  ? 'border-red-300 focus:border-red-400'
                  : 'border-slate-200 focus:border-accent',
              )}
            />
            {errors.adminName && (
              <p className="mt-1 text-xs text-red-500">
                {errors.adminName.message}
              </p>
            )}
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">
              Admin Password
            </label>
            <input
              {...register('adminPassword')}
              type="password"
              placeholder="Min 8 characters"
              className={cn(
                'w-full rounded-lg border-[1.5px] bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 transition-shadow focus:outline-none focus:ring-2 focus:ring-accent/15',
                errors.adminPassword
                  ? 'border-red-300 focus:border-red-400'
                  : 'border-slate-200 focus:border-accent',
              )}
            />
            {errors.adminPassword && (
              <p className="mt-1 text-xs text-red-500">
                {errors.adminPassword.message}
              </p>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border-[1.5px] border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLoading}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white shadow-accent-sm transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {isLoading ? 'Creating...' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function EditOrgModal({
  organization,
  onClose,
  onSubmit,
  isLoading,
}: {
  organization: Organization;
  onClose: () => void;
  onSubmit: (data: EditOrgFormData) => void;
  isLoading: boolean;
}) {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<EditOrgFormData>({
    resolver: zodResolver(editOrgSchema),
    defaultValues: {
      name: organization.name,
      status: organization.status,
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center">
      <div className="w-full max-h-[100dvh] overflow-y-auto rounded-t-2xl bg-white p-6 shadow-xl md:max-w-md md:rounded-xl">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">
            Edit Organization
          </h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">
              Organization Name
            </label>
            <input
              {...register('name')}
              className={cn(
                'w-full rounded-lg border-[1.5px] bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 transition-shadow focus:outline-none focus:ring-2 focus:ring-accent/15',
                errors.name
                  ? 'border-red-300 focus:border-red-400'
                  : 'border-slate-200 focus:border-accent',
              )}
            />
            {errors.name && (
              <p className="mt-1 text-xs text-red-500">{errors.name.message}</p>
            )}
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">
              Status
            </label>
            <select
              {...register('status')}
              className="w-full rounded-lg border-[1.5px] border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 transition-shadow focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15"
            >
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
            </select>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border-[1.5px] border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLoading}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white shadow-accent-sm transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {isLoading ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
