'use client';

import { useState } from 'react';
import {
  Plus,
  Pencil,
  Trash2,
  X,
  Loader2,
  Tag as TagIcon,
  Check,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useTags, useCreateTag, useUpdateTag, useDeleteTag } from '@/hooks/useTags';
import { RequireOrgContext } from '@/components/layout/RequireOrgContext';

// ─── Constants ───

const PRESET_COLORS = [
  '#6366f1',
  '#16a34a',
  '#d97706',
  '#dc2626',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#06b6d4',
  '#f59e0b',
  '#64748b',
];

// ─── Color Picker ───

function ColorPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (color: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {PRESET_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          onClick={() => onChange(color)}
          className={cn(
            'flex h-7 w-7 items-center justify-center rounded-full transition-all',
            value === color
              ? 'ring-2 ring-offset-2 ring-slate-400 scale-110'
              : 'hover:scale-110',
          )}
          style={{ backgroundColor: color }}
        >
          {value === color && <Check className="h-3.5 w-3.5 text-white" />}
        </button>
      ))}
    </div>
  );
}

// ─── Create / Edit Modal ───

function TagModal({
  mode,
  initialName,
  initialColor,
  onSubmit,
  onClose,
  isPending,
}: {
  mode: 'create' | 'edit';
  initialName?: string;
  initialColor?: string;
  onSubmit: (data: { name: string; color: string }) => void;
  onClose: () => void;
  isPending: boolean;
}) {
  const [name, setName] = useState(initialName ?? '');
  const [color, setColor] = useState(initialColor ?? PRESET_COLORS[0]!);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error('Tag name is required');
      return;
    }
    onSubmit({ name: trimmed, color });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm md:items-center">
      <div className="w-full max-h-[100dvh] overflow-y-auto rounded-t-2xl bg-white p-6 shadow-lg md:max-w-sm md:rounded-xl">
        <div className="mb-5 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-slate-900">
            {mode === 'create' ? 'New Tag' : 'Edit Tag'}
          </h3>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">
              Name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. VIP, Support, Urgent"
              autoFocus
              className="w-full rounded border-[1.5px] border-slate-200 px-3 py-2 text-sm transition-colors placeholder:text-slate-400 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">
              Color
            </label>
            <ColorPicker value={color} onChange={setColor} />
          </div>

          {/* Preview */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">
              Preview
            </label>
            <span
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium"
              style={{
                backgroundColor: color + '18',
                color: color,
              }}
            >
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: color }}
              />
              {name.trim() || 'Tag name'}
            </span>
          </div>

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded border-[1.5px] border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition-all hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending || !name.trim()}
              className="flex flex-1 items-center justify-center gap-2 rounded bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:bg-accent-hover hover:-translate-y-px disabled:opacity-50"
            >
              {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {mode === 'create' ? 'Create Tag' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Delete Confirmation ───

function DeleteConfirm({
  tagName,
  onConfirm,
  onCancel,
  isPending,
}: {
  tagName: string;
  onConfirm: () => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm md:items-center">
      <div className="w-full max-h-[100dvh] overflow-y-auto rounded-t-2xl bg-white p-6 shadow-lg md:max-w-sm md:rounded-xl">
        <h3 className="text-lg font-semibold text-slate-900">Delete Tag</h3>
        <p className="mt-2 text-sm text-slate-500">
          Are you sure you want to delete <span className="font-medium text-slate-700">&quot;{tagName}&quot;</span>?
          This will remove the tag from all chats.
        </p>
        <div className="mt-5 flex gap-2">
          <button
            onClick={onCancel}
            className="flex-1 rounded border-[1.5px] border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition-all hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isPending}
            className="flex flex-1 items-center justify-center gap-2 rounded bg-red-600 px-4 py-2 text-sm font-medium text-white transition-all hover:bg-red-700 disabled:opacity-50"
          >
            {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Tag Card ───

function TagCard({
  tag,
  onEdit,
  onDelete,
}: {
  tag: { id: string; name: string; color: string; chatCount?: number };
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group flex items-center justify-between rounded-lg bg-white px-4 py-3 shadow-xs transition-shadow hover:shadow-sm">
      <div className="flex min-w-0 items-center gap-3">
        <span
          className="h-3 w-3 shrink-0 rounded-full"
          style={{ backgroundColor: tag.color }}
        />
        <span
          className="text-sm font-semibold"
          style={{ color: tag.color }}
        >
          {tag.name}
        </span>
        <span className="shrink-0 text-xs text-slate-400">
          {tag.chatCount ?? 0} chat{(tag.chatCount ?? 0) !== 1 ? 's' : ''}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          onClick={onEdit}
          className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
          title="Edit tag"
        >
          <Pencil className="h-4 w-4" />
        </button>
        <button
          onClick={onDelete}
          className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-500"
          title="Delete tag"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

// ─── Main Page ───

export default function TagsPage() {
  const { data, isLoading } = useTags();
  const createMutation = useCreateTag();
  const updateMutation = useUpdateTag();
  const deleteMutation = useDeleteTag();

  const [showCreate, setShowCreate] = useState(false);
  const [editingTag, setEditingTag] = useState<{
    id: string;
    name: string;
    color: string;
  } | null>(null);
  const [deletingTag, setDeletingTag] = useState<{
    id: string;
    name: string;
  } | null>(null);

  const tags = data?.tags ?? [];

  return (
    <RequireOrgContext>
    <div className="mx-auto max-w-4xl px-4 py-6 md:px-6 md:py-8">
      {/* Header */}
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Tags</h1>
          <p className="text-sm text-slate-500">
            {tags.length} tag{tags.length !== 1 ? 's' : ''} created
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 rounded bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:bg-accent-hover hover:-translate-y-px"
        >
          <Plus className="h-4 w-4" />
          New Tag
        </button>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-accent" />
        </div>
      ) : tags.length === 0 ? (
        <div className="py-20 text-center">
          <TagIcon className="mx-auto mb-3 h-10 w-10 text-slate-300" />
          <p className="text-sm font-medium text-slate-600">No tags yet</p>
          <p className="mt-1 text-xs text-slate-400">
            Create tags to organize and categorize your chats
          </p>
          <button
            onClick={() => setShowCreate(true)}
            className="mt-4 inline-flex items-center gap-2 rounded bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:bg-accent-hover hover:-translate-y-px"
          >
            <Plus className="h-4 w-4" />
            Create First Tag
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {tags.map((tag) => (
            <TagCard
              key={tag.id}
              tag={tag}
              onEdit={() => setEditingTag(tag)}
              onDelete={() => setDeletingTag({ id: tag.id, name: tag.name })}
            />
          ))}
        </div>
      )}

      {/* Create Modal */}
      {showCreate && (
        <TagModal
          mode="create"
          isPending={createMutation.isPending}
          onClose={() => setShowCreate(false)}
          onSubmit={(data) => {
            createMutation.mutate(data, {
              onSuccess: () => {
                toast.success(`Tag "${data.name}" created`);
                setShowCreate(false);
              },
              onError: (err) =>
                toast.error(
                  err instanceof Error ? err.message : 'Failed to create tag',
                ),
            });
          }}
        />
      )}

      {/* Edit Modal */}
      {editingTag && (
        <TagModal
          mode="edit"
          initialName={editingTag.name}
          initialColor={editingTag.color}
          isPending={updateMutation.isPending}
          onClose={() => setEditingTag(null)}
          onSubmit={(data) => {
            updateMutation.mutate(
              { id: editingTag.id, ...data },
              {
                onSuccess: () => {
                  toast.success(`Tag "${data.name}" updated`);
                  setEditingTag(null);
                },
                onError: (err) =>
                  toast.error(
                    err instanceof Error ? err.message : 'Failed to update tag',
                  ),
              },
            );
          }}
        />
      )}

      {/* Delete Confirm */}
      {deletingTag && (
        <DeleteConfirm
          tagName={deletingTag.name}
          isPending={deleteMutation.isPending}
          onCancel={() => setDeletingTag(null)}
          onConfirm={() => {
            deleteMutation.mutate(deletingTag.id, {
              onSuccess: () => {
                toast.success(`Tag "${deletingTag.name}" deleted`);
                setDeletingTag(null);
              },
              onError: (err) =>
                toast.error(
                  err instanceof Error ? err.message : 'Failed to delete tag',
                ),
            });
          }}
        />
      )}
    </div>
    </RequireOrgContext>
  );
}
