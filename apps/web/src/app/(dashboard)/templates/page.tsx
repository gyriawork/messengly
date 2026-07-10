'use client';

import { useState } from 'react';
import {
  Plus,
  Search,
  FileText,
  Copy,
  Trash2,
  Pencil,
  X,
  Loader2,
  Clock,
  BarChart3,
  Paperclip,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import {
  useTemplates,
  useCreateTemplate,
  useUpdateTemplate,
  useDeleteTemplate,
  useDuplicateTemplate,
} from '@/hooks/useTemplates';
import type { Template, TemplateAttachment } from '@/types/template';
import { RequireOrgContext } from '@/components/layout/RequireOrgContext';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState as EmptyStateUI } from '@/components/ui/EmptyState';

export default function TemplatesPage() {
  const [search, setSearch] = useState('');
  const [editingTemplate, setEditingTemplate] = useState<Template | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const { data, isLoading } = useTemplates(search || undefined);
  const createMutation = useCreateTemplate();
  const updateMutation = useUpdateTemplate();
  const deleteMutation = useDeleteTemplate();
  const duplicateMutation = useDuplicateTemplate();

  const templates = data?.templates || [];

  function handleDuplicate(id: string) {
    duplicateMutation.mutate(id, {
      onSuccess: () => toast.success('Template duplicated'),
      onError: () => toast.error('Failed to duplicate template'),
    });
  }

  function handleDelete(id: string) {
    deleteMutation.mutate(id, {
      onSuccess: () => toast.success('Template deleted'),
      onError: () => toast.error('Failed to delete template'),
    });
  }

  return (
    <RequireOrgContext>
    <div className="mx-auto max-w-4xl px-4 py-6 md:px-6 md:py-8">
      {/* Header */}
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Templates</h1>
          <p className="mt-1 text-sm text-slate-500">
            Reusable message templates for broadcasts
          </p>
        </div>
        <button
          onClick={() => setIsCreating(true)}
          className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white shadow-accent-sm transition-all hover:bg-accent-hover hover:-translate-y-px"
        >
          <Plus className="h-4 w-4" />
          New Template
        </button>
      </div>

      {/* Search */}
      <div className="relative mb-6">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          type="text"
          placeholder="Search templates..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded-lg border-[1.5px] border-slate-200 bg-white py-2 pl-9 pr-4 text-sm text-slate-900 placeholder:text-slate-400 transition-shadow focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15"
        />
      </div>

      {/* Create / Edit Modal */}
      {(isCreating || editingTemplate) && (
        <TemplateEditor
          template={editingTemplate}
          onSave={async (name, messageText, attachments) => {
            if (editingTemplate) {
              updateMutation.mutate(
                { id: editingTemplate.id, name, messageText, attachments },
                {
                  onSuccess: () => {
                    toast.success('Template updated');
                    setEditingTemplate(null);
                  },
                  onError: () => toast.error('Failed to update template'),
                },
              );
            } else {
              createMutation.mutate(
                { name, messageText, attachments },
                {
                  onSuccess: () => {
                    toast.success('Template created');
                    setIsCreating(false);
                  },
                  onError: () => toast.error('Failed to create template'),
                },
              );
            }
          }}
          onCancel={() => {
            setIsCreating(false);
            setEditingTemplate(null);
          }}
          isSaving={createMutation.isPending || updateMutation.isPending}
        />
      )}

      {/* Template grid */}
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="rounded-xl bg-white p-5 shadow-xs">
              <div className="mb-2 flex items-start justify-between">
                <Skeleton className="h-4 w-32" />
              </div>
              <Skeleton className="mb-1.5 h-3 w-full" />
              <Skeleton className="mb-1.5 h-3 w-full" />
              <Skeleton className="mb-3 h-3 w-2/3" />
              <div className="flex items-center gap-3 border-t border-slate-50 pt-3">
                <Skeleton className="h-2.5 w-20" />
                <Skeleton className="h-2.5 w-16" />
              </div>
            </div>
          ))}
        </div>
      ) : templates.length === 0 ? (
        <EmptyStateUI
          icon={<FileText className="h-12 w-12" />}
          title="No templates yet"
          description="Write a message once, reuse it in every broadcast."
          action={
            <button
              onClick={() => setIsCreating(true)}
              className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white shadow-accent-sm transition-all hover:bg-accent-hover hover:-translate-y-px"
            >
              <Plus className="h-4 w-4" />
              Create first template
            </button>
          }
        />
      ) : (
        <div className="space-y-3">
          {templates.map((template) => (
            <div
              key={template.id}
              className="group rounded-xl bg-white p-5 shadow-xs transition-shadow hover:shadow-sm"
            >
              {/* Name */}
              <div className="mb-2 flex items-start justify-between">
                <h3 className="truncate text-sm font-semibold text-slate-900">
                  {template.name}
                </h3>
                {/* Actions */}
                <div className="ml-2 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                  <button
                    onClick={() => setEditingTemplate(template)}
                    title="Edit"
                    className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => handleDuplicate(template.id)}
                    title="Duplicate"
                    className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => handleDelete(template.id)}
                    title="Delete"
                    className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-500"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              {/* Message preview */}
              <p className="mb-3 line-clamp-2 text-sm leading-relaxed text-slate-500">
                {template.messageText}
              </p>

              {/* Meta — one line, matching the Broadcasts card */}
              <div className="flex flex-wrap items-center gap-4 border-t border-slate-50 pt-3 text-xs text-slate-400">
                <span className="inline-flex items-center gap-1 font-medium text-slate-600">
                  <BarChart3 className="h-3 w-3" />
                  Used {template.usageCount} times
                </span>
                {template.createdByName && <span>by {template.createdByName}</span>}
                <span>
                  Updated{' '}
                  {new Date(template.updatedAt).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
    </RequireOrgContext>
  );
}

function TemplateEditor({
  template,
  onSave,
  onCancel,
  isSaving,
}: {
  template: Template | null;
  onSave: (name: string, messageText: string, attachments: TemplateAttachment[]) => void;
  onCancel: () => void;
  isSaving: boolean;
}) {
  const [name, setName] = useState(template?.name || '');
  const [messageText, setMessageText] = useState(template?.messageText || '');
  const [attachments, setAttachments] = useState<TemplateAttachment[]>(template?.attachments ?? []);
  const [isUploading, setIsUploading] = useState(false);

  const handleFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    e.target.value = '';
    setIsUploading(true);
    try {
      for (const file of files) {
        const result = await api.upload<{ file: { url: string; size: number; mimeType: string; originalName: string } }>(
          '/api/uploads',
          file,
        );
        setAttachments((prev) => [
          ...prev,
          { url: result.file.url, filename: result.file.originalName, mimeType: result.file.mimeType, size: result.file.size },
        ]);
      }
    } catch {
      toast.error('Failed to upload file');
    } finally {
      setIsUploading(false);
    }
  };

  const isValid = name.trim().length > 0 && messageText.trim().length > 0;
  const charCount = messageText.length;

  return (
    <div className="mb-6 rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">
          {template ? 'Edit Template' : 'New Template'}
        </h3>
        <button
          onClick={onCancel}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-4">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-700">
            Template Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Welcome Message"
            className="w-full rounded-lg border-[1.5px] border-slate-200 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15"
          />
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label className="text-sm font-medium text-slate-700">
              Message Text
            </label>
            <span
              className={cn(
                'text-xs',
                charCount > 4000 ? 'text-red-500' : 'text-slate-400',
              )}
            >
              {charCount} characters
            </span>
          </div>
          <textarea
            value={messageText}
            onChange={(e) => setMessageText(e.target.value)}
            placeholder="Type your template message..."
            rows={5}
            className="w-full resize-none rounded-lg border-[1.5px] border-slate-200 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15"
          />
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-700">
            Attachments{' '}
            <span className="font-normal text-slate-400">
              (optional — sent with every broadcast that uses this template)
            </span>
          </label>
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {attachments.map((a, i) => (
                <span
                  key={`${a.url}-${i}`}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-slate-100 px-2.5 py-1 text-xs text-slate-700"
                >
                  <Paperclip className="h-3 w-3 shrink-0" />
                  <span className="max-w-[160px] truncate">{a.filename}</span>
                  <button
                    type="button"
                    onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                    className="rounded-full p-0.5 hover:bg-black/5"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border-[1.5px] border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50">
            {isUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
            Attach files
            <input type="file" multiple className="hidden" onChange={handleFiles} disabled={isUploading} />
          </label>
        </div>

        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            onClick={() => onSave(name.trim(), messageText.trim(), attachments)}
            disabled={!isValid || isSaving}
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:bg-accent-hover disabled:opacity-50"
          >
            {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
            {template ? 'Save Changes' : 'Create Template'}
          </button>
        </div>
      </div>
    </div>
  );
}

