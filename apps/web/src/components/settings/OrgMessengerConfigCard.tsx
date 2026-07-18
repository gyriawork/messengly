'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  Pencil,
  Trash2,
  Building2,
  Server,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { MessengerIcon } from '@/components/ui/MessengerIcon';
import { MESSENGER_PLATFORM_FIELDS } from '@messengly/shared';
import type { Messenger } from '@messengly/shared';
import {
  useUpdateOrgMessengerConfig,
  useDeleteOrgMessengerConfig,
} from '@/hooks/useOrgMessengerConfig';
import type { OrgMessengerConfigEntry } from '@/hooks/useOrgMessengerConfig';

const messengerMeta: Partial<Record<Messenger, { name: string }>> = {
  telegram: { name: 'Telegram' },
  slack: { name: 'Slack' },
  gmail: { name: 'Gmail' },
};

function buildSchema(messenger: Messenger) {
  const fields = MESSENGER_PLATFORM_FIELDS[messenger];
  const shape: Record<string, z.ZodType> = {};
  for (const field of fields) {
    if (field.type === 'number') {
      shape[field.key] = z.coerce.number().int().positive(`${field.label} is required`);
    } else {
      shape[field.key] = z.string().min(1, `${field.label} is required`);
    }
  }
  return z.object(shape);
}

/**
 * Org-scoped messenger app credentials (Task 4 — e.g. this organization's own
 * Telegram API Hash & ID). Distinct from /admin/platform's global
 * PlatformConfig: this is what an org admin manages for their own org, and
 * takes priority over the global default at send time.
 */
export function OrgMessengerConfigCard({ entry }: { entry: OrgMessengerConfigEntry }) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const updateMutation = useUpdateOrgMessengerConfig();
  const deleteMutation = useDeleteOrgMessengerConfig();

  const meta = messengerMeta[entry.messenger];
  if (!meta) return null;
  const fields = MESSENGER_PLATFORM_FIELDS[entry.messenger];

  const schema = buildSchema(entry.messenger);
  const form = useForm({ resolver: zodResolver(schema) });

  const usingOwnCreds = entry.source === 'organization';

  const handleSave = (data: Record<string, unknown>) => {
    updateMutation.mutate(
      { messenger: entry.messenger, credentials: data as Record<string, string | number> },
      {
        onSuccess: () => {
          toast.success(`${meta.name} credentials saved for your organization`);
          setEditing(false);
          form.reset();
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : 'Failed to save');
        },
      },
    );
  };

  const handleDelete = () => {
    deleteMutation.mutate(entry.messenger, {
      onSuccess: () => {
        toast.success(`${meta.name} credentials removed — falling back to the platform default`);
        setConfirmDelete(false);
      },
      onError: (err) => {
        toast.error(err instanceof Error ? err.message : 'Failed to remove');
      },
    });
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 transition-shadow hover:shadow-xs sm:p-5">
      <div className="flex flex-wrap items-center gap-4">
        <MessengerIcon messenger={entry.messenger} size={44} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-slate-900">{meta.name}</h3>
            {usingOwnCreds ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Configured
              </span>
            ) : entry.configured ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                <Server className="h-3.5 w-3.5" />
                Using platform default
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                <XCircle className="h-3.5 w-3.5" />
                Not Configured
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-xs text-slate-500">
            {fields.map((f) => f.label).join(', ')}
          </p>
          {usingOwnCreds && entry.hint && (
            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-400">
              <Building2 className="h-3.5 w-3.5" />
              Key: <span className="font-mono text-slate-600">{entry.hint}</span>
            </div>
          )}
        </div>

        {!editing && !confirmDelete && (
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={() => setEditing(true)}
              className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:bg-accent-hover hover:-translate-y-px motion-safe:active:translate-y-0 motion-safe:active:scale-[0.98]"
            >
              <Pencil className="h-4 w-4" />
              {usingOwnCreds ? 'Edit Credentials' : 'Use own credentials'}
            </button>
            {usingOwnCreds && (
              <button
                onClick={() => setConfirmDelete(true)}
                className="flex items-center gap-2 rounded-lg border-[1.5px] border-red-200 px-3 py-2 text-sm font-medium text-red-600 transition-all hover:-translate-y-px motion-safe:active:translate-y-0 motion-safe:active:scale-[0.98] hover:bg-red-50"
              >
                <Trash2 className="h-4 w-4" />
                Remove
              </button>
            )}
          </div>
        )}
      </div>

      <div>
        {!entry.configured && !editing && (
          <div className="mt-3 flex items-start gap-2 rounded-lg bg-amber-50 p-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <p className="text-xs text-amber-700">
              {meta.name} stays unavailable in your organization until credentials are set (here or platform-wide).
            </p>
          </div>
        )}

        {editing && (
          <form onSubmit={form.handleSubmit(handleSave)} className="mt-4 space-y-3">
            {fields.map((field) => (
              <div key={field.key}>
                <label className="mb-1.5 block text-sm font-medium text-slate-700">{field.label}</label>
                <input
                  {...form.register(field.key)}
                  type={field.type === 'password' ? 'password' : 'text'}
                  placeholder={`Enter ${field.label}`}
                  className={cn(
                    'w-full rounded-lg border-[1.5px] border-slate-200 px-3 py-2 text-sm transition-colors',
                    'placeholder:text-slate-400 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15',
                    form.formState.errors[field.key] && 'border-red-300 focus:border-red-400 focus:ring-red-100',
                  )}
                />
                {form.formState.errors[field.key] && (
                  <p className="mt-1 text-xs text-red-500">
                    {form.formState.errors[field.key]?.message as string}
                  </p>
                )}
              </div>
            ))}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => { setEditing(false); form.reset(); }}
                className="flex-1 rounded-lg border-[1.5px] border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition-all hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={updateMutation.isPending}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:bg-accent-hover disabled:opacity-50"
              >
                {updateMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                Save
              </button>
            </div>
          </form>
        )}

        {confirmDelete && (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3">
            <p className="mb-2 text-xs text-red-700">
              Remove your organization&apos;s {meta.name} credentials? Sending will fall back to the platform default (if any).
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirmDelete(false)}
                className="flex-1 rounded border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleteMutation.isPending}
                className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {deleteMutation.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
                Remove
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
