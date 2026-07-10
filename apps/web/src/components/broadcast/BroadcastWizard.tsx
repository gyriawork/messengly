'use client';

import { useState, useMemo, useRef, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  FileText,
  Users,
  Clock,
  Eye,
  Send,
  Save,
  Search,
  X,
  Paperclip,
  Sliders,
  AlertCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useChats } from '@/hooks/useChats';
import {
  useCreateBroadcast,
  useUpdateBroadcast,
  useBroadcast,
  useSendBroadcast,
} from '@/hooks/useBroadcasts';
import { useTemplates, useTemplateUse } from '@/hooks/useTemplates';
import { useTags } from '@/hooks/useTags';
import type { MessengerType } from '@/types/chat';
import type { BroadcastAttachment } from '@/types/broadcast';
import { api } from '@/lib/api';

const messengerMeta: Record<
  string,
  { label: string; bgClass: string; textClass: string }
> = {
  telegram: {
    label: 'Telegram',
    bgClass: 'bg-messenger-tg-bg',
    textClass: 'text-messenger-tg-text',
  },
  slack: {
    label: 'Slack',
    bgClass: 'bg-messenger-sl-bg',
    textClass: 'text-messenger-sl-text',
  },
  whatsapp: {
    label: 'WhatsApp',
    bgClass: 'bg-messenger-wa-bg',
    textClass: 'text-messenger-wa-text',
  },
  gmail: {
    label: 'Gmail',
    bgClass: 'bg-messenger-gm-bg',
    textClass: 'text-messenger-gm-text',
  },
  teams: {
    label: 'MS Teams',
    bgClass: 'bg-messenger-mt-bg',
    textClass: 'text-messenger-mt-text',
  },
};

const broadcastSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  messageText: z.string().min(1, 'Message is required').max(4096),
  chatIds: z.array(z.string()).min(1, 'Select at least one recipient'),
  scheduleType: z.enum(['now', 'later']),
  scheduledAt: z.string().optional(),
});

type BroadcastFormData = z.infer<typeof broadcastSchema>;

const STEPS = [
  { label: 'Compose', icon: FileText },
  { label: 'Recipients', icon: Users },
  { label: 'Schedule', icon: Clock },
  { label: 'Messengers', icon: Sliders },
  { label: 'Review', icon: Eye },
] as const;

export function BroadcastWizard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const editId = searchParams.get('edit');

  const [step, setStep] = useState(0);
  const [chatSearch, setChatSearch] = useState('');
  const [messengerFilter, setMessengerFilter] = useState<MessengerType | null>(
    null,
  );
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [broadcastAttachments, setBroadcastAttachments] = useState<BroadcastAttachment[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [messengerPriority, setMessengerPriority] = useState<MessengerType[]>([
    'telegram',
    'slack',
    'whatsapp',
    'teams',
  ]);
  const fileInputRef = useRef<React.ElementRef<'input'>>(null);

  const { data: existingBroadcast } = useBroadcast(editId || undefined);
  // Load all chats (not the default 50) so every imported chat is selectable
  // as a broadcast recipient — matches the limit used by the Chats page.
  const { data: chatsData } = useChats({ limit: 1000 });
  const { data: templatesData } = useTemplates();
  const { data: tagsData } = useTags();
  const tags = tagsData?.tags ?? [];
  const templateUseMutation = useTemplateUse();
  const createMutation = useCreateBroadcast();
  const updateMutation = useUpdateBroadcast();
  const sendMutation = useSendBroadcast();

  const templates = templatesData?.templates || [];

  // Inactive chats were marked unreachable by "Update chats" — a broadcast to
  // them is guaranteed to fail, so they are not offered as recipients.
  const allChats = (chatsData?.chats || []).filter((c) => c.status !== 'inactive');

  const form = useForm<BroadcastFormData>({
    resolver: zodResolver(broadcastSchema),
    defaultValues: {
      name: existingBroadcast?.name || '',
      messageText: existingBroadcast?.messageText || '',
      chatIds:
        existingBroadcast?.chats?.map((c) => c.chatId) || [],
      scheduleType: existingBroadcast?.scheduledAt ? 'later' : 'now',
      scheduledAt: existingBroadcast?.scheduledAt || '',
    },
    values: existingBroadcast
      ? {
          name: existingBroadcast.name,
          messageText: existingBroadcast.messageText,
          chatIds:
            existingBroadcast.chats?.map((c) => c.chatId) || [],
          scheduleType: existingBroadcast.scheduledAt ? 'later' : 'now',
          scheduledAt: existingBroadcast.scheduledAt || '',
        }
      : undefined,
  });

  const {
    register,
    control,
    watch,
    trigger,
    handleSubmit,
    setValue,
    formState: { errors },
  } = form;

  const messageText = watch('messageText');
  const selectedChatIds = watch('chatIds');
  const scheduleType = watch('scheduleType');
  const scheduledAt = watch('scheduledAt');
  const name = watch('name');

  const filteredChats = useMemo(() => {
    return allChats.filter((chat) => {
      if (messengerFilter && chat.messenger !== messengerFilter) return false;
      if (tagFilter && !(chat.tags ?? []).some((t) => t.id === tagFilter))
        return false;
      if (
        chatSearch &&
        !chat.name.toLowerCase().includes(chatSearch.toLowerCase())
      )
        return false;
      return true;
    });
  }, [allChats, messengerFilter, tagFilter, chatSearch]);

  // Select every chat that matches the current filters (search + messenger +
  // tag) — handy for "send to all chats with this tag".
  const selectAllFiltered = () => {
    const ids = filteredChats.map((c) => c.id);
    const merged = Array.from(new Set([...selectedChatIds, ...ids]));
    setValue('chatIds', merged, { shouldValidate: true });
  };

  const selectedChats = useMemo(() => {
    return allChats.filter((c) => selectedChatIds.includes(c.id));
  }, [allChats, selectedChatIds]);

  const groupedSelected = useMemo(() => {
    const groups: Record<string, typeof selectedChats> = {};
    for (const chat of selectedChats) {
      if (!groups[chat.messenger]) groups[chat.messenger] = [];
      groups[chat.messenger].push(chat);
    }
    return groups;
  }, [selectedChats]);

  async function handleNext() {
    if (step === 0) {
      const valid = await trigger(['name', 'messageText']);
      if (!valid) return;
    } else if (step === 1) {
      const valid = await trigger(['chatIds']);
      if (!valid) return;
    } else if (step === 2) {
      if (scheduleType === 'later') {
        const valid = await trigger(['scheduledAt']);
        if (!valid && !scheduledAt) {
          toast.error('Please select a date and time');
          return;
        }
      }
    } else if (step === 3) {
      // Messenger priority validation - ensure at least one messenger is selected
      const hasSelectedMessengers = messengerPriority.some((m) =>
        groupedSelected[m],
      );
      if (!hasSelectedMessengers) {
        toast.error('No messengers selected for this broadcast');
        return;
      }
    }
    setStep((s) => Math.min(s + 1, 4));
  }

  function handleBack() {
    setStep((s) => Math.max(s - 1, 0));
  }

  function toggleChat(chatId: string) {
    const current = selectedChatIds;
    if (current.includes(chatId)) {
      setValue(
        'chatIds',
        current.filter((id) => id !== chatId),
        { shouldValidate: true },
      );
    } else {
      setValue('chatIds', [...current, chatId], { shouldValidate: true });
    }
  }

  const handleBroadcastFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length === 0) return;
      e.target.value = '';
      setIsUploading(true);
      try {
        for (const file of files) {
          const result = await api.upload<{ file: { key: string; url: string; size: number; mimeType: string; originalName: string } }>('/api/uploads', file);
          setBroadcastAttachments((prev) => [...prev, {
            url: result.file.url,
            filename: result.file.originalName,
            mimeType: result.file.mimeType,
            size: result.file.size,
          }]);
        }
      } catch {
        toast.error('Failed to upload file');
      } finally {
        setIsUploading(false);
      }
    },
    [],
  );

  async function onSaveDraft(data: BroadcastFormData) {
    try {
      if (editId) {
        await updateMutation.mutateAsync({
          id: editId,
          name: data.name,
          messageText: data.messageText,
          chatIds: data.chatIds,
          scheduledAt:
            data.scheduleType === 'later' && data.scheduledAt ? new Date(data.scheduledAt).toISOString() : undefined,
          attachments: broadcastAttachments.length > 0 ? broadcastAttachments : undefined,
        });
        toast.success('Broadcast updated');
      } else {
        await createMutation.mutateAsync({
          name: data.name,
          messageText: data.messageText,
          chatIds: data.chatIds,
          scheduledAt:
            data.scheduleType === 'later' && data.scheduledAt ? new Date(data.scheduledAt).toISOString() : undefined,
          attachments: broadcastAttachments.length > 0 ? broadcastAttachments : undefined,
        });
        toast.success('Broadcast saved as draft');
      }
      router.push('/broadcast');
    } catch {
      toast.error('Failed to save broadcast');
    }
  }

  async function onSendNow(data: BroadcastFormData) {
    try {
      let broadcastId = editId;
      if (editId) {
        await updateMutation.mutateAsync({
          id: editId,
          name: data.name,
          messageText: data.messageText,
          chatIds: data.chatIds,
          scheduledAt:
            data.scheduleType === 'later' && data.scheduledAt ? new Date(data.scheduledAt).toISOString() : undefined,
          attachments: broadcastAttachments.length > 0 ? broadcastAttachments : undefined,
        });
      } else {
        const created = await createMutation.mutateAsync({
          name: data.name,
          messageText: data.messageText,
          chatIds: data.chatIds,
          scheduledAt:
            data.scheduleType === 'later' && data.scheduledAt ? new Date(data.scheduledAt).toISOString() : undefined,
          attachments: broadcastAttachments.length > 0 ? broadcastAttachments : undefined,
        });
        broadcastId = created.id;
      }

      if (broadcastId && data.scheduleType === 'now') {
        await sendMutation.mutateAsync(broadcastId);
        toast.success('Broadcast is being sent');
      } else {
        toast.success('Broadcast scheduled');
      }
      router.push('/broadcast');
    } catch {
      toast.error('Failed to send broadcast');
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 md:px-6 md:py-8">
      {/* Header */}
      <div className="mb-8">
        <button
          onClick={() => router.push('/broadcast')}
          className="mb-4 flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Broadcasts
        </button>
        <h1 className="text-2xl font-semibold text-slate-900">
          {editId ? 'Edit Broadcast' : 'New Broadcast'}
        </h1>
      </div>

      {/* Step Indicator */}
      <div className="mb-8 flex items-center gap-2 overflow-x-auto pb-1">
        {STEPS.map((s, i) => {
          const Icon = s.icon;
          const isCurrent = i === step;
          const isCompleted = i < step;
          return (
            <div key={s.label} className="flex flex-shrink-0 items-center gap-2">
              {i > 0 && (
                <div
                  className={cn(
                    'h-px w-8',
                    isCompleted ? 'bg-accent' : 'bg-slate-200',
                  )}
                />
              )}
              <button
                onClick={() => {
                  if (i < step) setStep(i);
                }}
                disabled={i > step}
                className={cn(
                  'flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium transition-all',
                  isCurrent &&
                    'bg-accent text-white shadow-accent-sm',
                  isCompleted &&
                    'bg-accent-bg text-accent',
                  !isCurrent &&
                    !isCompleted &&
                    'bg-slate-100 text-slate-400',
                )}
              >
                {isCompleted ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <Icon className="h-3.5 w-3.5" />
                )}
                <span className="hidden sm:inline">{s.label}</span>
              </button>
            </div>
          );
        })}
      </div>

      {/* Step Content */}
      <div className="rounded-lg bg-white p-6 shadow-xs">
        {/* Step 1: Compose */}
        {step === 0 && (
          <div className="space-y-5">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-700">
                Broadcast Name
              </label>
              <input
                {...register('name')}
                placeholder="e.g., Weekly Update, Product Launch..."
                className={cn(
                  'w-full rounded-lg border-[1.5px] bg-white px-3 py-2 text-base text-slate-900 placeholder:text-slate-400 transition-shadow focus:outline-none focus:ring-2 focus:ring-accent/15',
                  errors.name
                    ? 'border-red-300 focus:border-red-400'
                    : 'border-slate-200 focus:border-accent',
                )}
              />
              {errors.name && (
                <p className="mt-1 text-xs text-red-500">
                  {errors.name.message}
                </p>
              )}
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-700">
                Message
              </label>
              <textarea
                {...register('messageText')}
                rows={8}
                placeholder="Type your broadcast message here..."
                className={cn(
                  'w-full resize-none rounded-lg border-[1.5px] bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 transition-shadow focus:outline-none focus:ring-2 focus:ring-accent/15',
                  errors.messageText
                    ? 'border-red-300 focus:border-red-400'
                    : 'border-slate-200 focus:border-accent',
                )}
              />
              <div className="mt-1 flex justify-between">
                {errors.messageText && (
                  <p className="text-xs text-red-500">
                    {errors.messageText.message}
                  </p>
                )}
                <p
                  className={cn(
                    'ml-auto text-xs',
                    (messageText?.length || 0) > 4000
                      ? 'text-red-500'
                      : 'text-slate-400',
                  )}
                >
                  {messageText?.length || 0} / 4096
                </p>
              </div>
            </div>

            {/* Template selector */}
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-700">
                Template (optional)
              </label>
              <select
                className="w-full rounded-lg border-[1.5px] border-slate-200 bg-white px-3 py-2 text-sm text-slate-500 transition-shadow focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15"
                defaultValue=""
                onChange={(e) => {
                  const templateId = e.target.value;
                  if (!templateId) return;
                  const template = templates.find((t) => t.id === templateId);
                  if (template) {
                    setValue('messageText', template.messageText, { shouldValidate: true });
                    // Carry the template's attachments into the broadcast so the
                    // user doesn't have to re-attach them.
                    const tplAttachments = template.attachments ?? [];
                    if (tplAttachments.length > 0) {
                      setBroadcastAttachments((prev) => {
                        const existing = new Set(prev.map((a) => a.url));
                        return [...prev, ...tplAttachments.filter((a) => !existing.has(a.url))];
                      });
                    }
                    templateUseMutation.mutate(templateId);
                    toast.success(`Template "${template.name}" applied`);
                  }
                }}
              >
                <option value="">No template</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>

            {/* File attachments */}
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-700">
                Attachments (optional)
              </label>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleBroadcastFileChange}
                accept="image/*,application/pdf,text/plain,text/csv,.doc,.docx,.xls,.xlsx,.zip,.mp4,.mp3"
              />
              {broadcastAttachments.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {broadcastAttachments.map((att, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-700"
                    >
                      <span className="max-w-[160px] truncate">{att.filename}</span>
                      <span className="text-slate-400">
                        {att.size < 1024 * 1024
                          ? `${(att.size / 1024).toFixed(0)}KB`
                          : `${(att.size / 1024 / 1024).toFixed(1)}MB`}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setBroadcastAttachments((prev) => prev.filter((_, j) => j !== i))
                        }
                        className="ml-0.5 text-slate-400 hover:text-red-500"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isUploading}
                className="flex items-center gap-2 rounded-lg border-[1.5px] border-dashed border-slate-300 px-4 py-2.5 text-sm text-slate-500 transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
              >
                <Paperclip className="h-4 w-4" />
                {isUploading ? 'Uploading...' : 'Attach files'}
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Recipients */}
        {step === 1 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">
                Select Recipients
              </h3>
              <span className="text-sm text-slate-500">
                {selectedChatIds.length} selected
              </span>
            </div>

            {errors.chatIds && (
              <p className="text-xs text-red-500">{errors.chatIds.message}</p>
            )}

            {/* Search and filter */}
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  placeholder="Search chats..."
                  value={chatSearch}
                  onChange={(e) => setChatSearch(e.target.value)}
                  className="w-full rounded-lg border-[1.5px] border-slate-200 bg-white py-2 pl-9 pr-4 text-base text-slate-900 placeholder:text-slate-400 transition-shadow focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15"
                />
              </div>
              <div className="flex gap-1">
                {(['telegram', 'slack', 'whatsapp', 'teams'] as const).map(
                  (m) => {
                    const meta = messengerMeta[m];
                    return (
                      <button
                        key={m}
                        onClick={() =>
                          setMessengerFilter(messengerFilter === m ? null : m)
                        }
                        className={cn(
                          'rounded px-2.5 py-1.5 text-xs font-medium transition-colors',
                          messengerFilter === m
                            ? `${meta.bgClass} ${meta.textClass}`
                            : 'bg-slate-100 text-slate-500 hover:bg-slate-200',
                        )}
                      >
                        {meta.label}
                      </button>
                    );
                  },
                )}
              </div>
            </div>

            {/* Tag filter + bulk select */}
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={tagFilter ?? ''}
                onChange={(e) => setTagFilter(e.target.value || null)}
                className="rounded-lg border-[1.5px] border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 focus:border-accent focus:outline-none"
              >
                <option value="">All tags</option>
                {tags.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              {filteredChats.length > 0 && (
                <button
                  type="button"
                  onClick={selectAllFiltered}
                  className="rounded-lg border-[1.5px] border-accent/30 bg-accent/5 px-3 py-2 text-sm font-medium text-accent transition-colors hover:bg-accent/10"
                >
                  Select all {filteredChats.length}
                  {(tagFilter || messengerFilter || chatSearch) ? ' filtered' : ''}
                </button>
              )}
            </div>

            {/* Selected chips */}
            {selectedChatIds.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {selectedChats.slice(0, 10).map((chat) => {
                  const meta = messengerMeta[chat.messenger];
                  return (
                    <span
                      key={chat.id}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium',
                        meta?.bgClass,
                        meta?.textClass,
                      )}
                    >
                      {chat.name}
                      <button
                        onClick={() => toggleChat(chat.id)}
                        className="ml-0.5 rounded-full p-0.5 hover:bg-black/5"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  );
                })}
                {selectedChatIds.length > 10 && (
                  <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-500">
                    +{selectedChatIds.length - 10} more
                  </span>
                )}
              </div>
            )}

            {/* Chat list */}
            <Controller
              name="chatIds"
              control={control}
              render={() => (
                <div className="max-h-[400px] overflow-auto rounded-lg border border-slate-200">
                  {filteredChats.length === 0 ? (
                    <div className="px-4 py-8 text-center text-sm text-slate-400">
                      No chats found. Import chats from the Messenger page
                      first.
                    </div>
                  ) : (
                    filteredChats.map((chat) => {
                      const isSelected = selectedChatIds.includes(chat.id);
                      const meta = messengerMeta[chat.messenger];
                      return (
                        <button
                          key={chat.id}
                          type="button"
                          onClick={() => toggleChat(chat.id)}
                          className={cn(
                            'flex w-full items-center gap-3 border-b border-slate-100 px-4 py-2.5 text-left transition-colors last:border-b-0',
                            isSelected
                              ? 'bg-accent-bg'
                              : 'hover:bg-slate-50',
                          )}
                        >
                          <div
                            className={cn(
                              'flex h-5 w-5 shrink-0 items-center justify-center rounded border-[1.5px] transition-all',
                              isSelected
                                ? 'border-accent bg-accent'
                                : 'border-slate-300 bg-white',
                            )}
                          >
                            {isSelected && (
                              <Check className="h-3 w-3 text-white" />
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-slate-900">
                              {chat.name}
                            </p>
                          </div>
                          <span
                            className={cn(
                              'rounded-full px-2 py-0.5 text-xs font-medium',
                              meta?.bgClass,
                              meta?.textClass,
                            )}
                          >
                            {meta?.label}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            />

            {/* Select all / deselect */}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() =>
                  setValue(
                    'chatIds',
                    filteredChats.map((c) => c.id),
                    { shouldValidate: true },
                  )
                }
                className="text-xs font-medium text-accent hover:text-accent-hover"
              >
                Select all visible
              </button>
              <span className="text-slate-300">|</span>
              <button
                type="button"
                onClick={() =>
                  setValue('chatIds', [], { shouldValidate: true })
                }
                className="text-xs font-medium text-slate-500 hover:text-slate-700"
              >
                Clear selection
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Schedule */}
        {step === 2 && (
          <div className="space-y-6">
            <h3 className="text-sm font-semibold text-slate-900">
              When to send?
            </h3>

            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setValue('scheduleType', 'now')}
                className={cn(
                  'flex flex-1 flex-col items-center gap-2 rounded-lg border-[1.5px] p-6 transition-all',
                  scheduleType === 'now'
                    ? 'border-accent bg-accent-bg shadow-focus-ring'
                    : 'border-slate-200 hover:border-slate-300',
                )}
              >
                <Send
                  className={cn(
                    'h-8 w-8',
                    scheduleType === 'now'
                      ? 'text-accent'
                      : 'text-slate-400',
                  )}
                />
                <span
                  className={cn(
                    'text-sm font-medium',
                    scheduleType === 'now'
                      ? 'text-accent'
                      : 'text-slate-600',
                  )}
                >
                  Send Now
                </span>
                <span className="text-xs text-slate-400">
                  Start delivering immediately
                </span>
              </button>

              <button
                type="button"
                onClick={() => setValue('scheduleType', 'later')}
                className={cn(
                  'flex flex-1 flex-col items-center gap-2 rounded-lg border-[1.5px] p-6 transition-all',
                  scheduleType === 'later'
                    ? 'border-accent bg-accent-bg shadow-focus-ring'
                    : 'border-slate-200 hover:border-slate-300',
                )}
              >
                <Clock
                  className={cn(
                    'h-8 w-8',
                    scheduleType === 'later'
                      ? 'text-accent'
                      : 'text-slate-400',
                  )}
                />
                <span
                  className={cn(
                    'text-sm font-medium',
                    scheduleType === 'later'
                      ? 'text-accent'
                      : 'text-slate-600',
                  )}
                >
                  Schedule for Later
                </span>
                <span className="text-xs text-slate-400">
                  Pick a specific date and time
                </span>
              </button>
            </div>

            {scheduleType === 'later' && (
              <div>
                <label className="mb-1.5 block text-sm font-medium text-slate-700">
                  Date & Time
                </label>
                <input
                  type="datetime-local"
                  {...register('scheduledAt')}
                  min={(() => { const now = new Date(); return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16); })()}
                  className="w-full rounded-lg border-[1.5px] border-slate-200 bg-white px-3 py-2 text-base text-slate-900 transition-shadow focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15"
                />
                {scheduledAt && (
                  <p className="mt-2 text-sm text-slate-500">
                    Scheduled for{' '}
                    {new Date(scheduledAt).toLocaleString('en-GB', {
                      weekday: 'long',
                      month: 'long',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Step 4: Messenger Priority & Antiban Settings */}
        {step === 3 && (
          <div className="space-y-6">
            <h3 className="text-sm font-semibold text-slate-900">
              Messenger Priority & Antiban Settings
            </h3>

            {/* Risk meter visualization */}
            <div className="rounded-lg border border-slate-200 p-4">
              <p className="text-xs font-medium uppercase text-slate-400 mb-3">
                Delivery Risk Level
              </p>
              <div className="space-y-2">
                {/* Risk bar */}
                <div className="flex h-8 gap-1 rounded-lg overflow-hidden bg-slate-100">
                  <div className="flex-1 bg-green-400" />
                  <div className="flex-1 bg-yellow-400" />
                  <div className="flex-1 bg-red-400" />
                </div>
                <div className="flex justify-between text-xs text-slate-500">
                  <span>Safe</span>
                  <span>Moderate</span>
                  <span>Aggressive</span>
                </div>
              </div>
              <div className="mt-3 inline-flex items-center gap-2 rounded-lg bg-green-50 px-3 py-1.5 text-xs text-green-700">
                <AlertCircle className="h-3.5 w-3.5" />
                <span>Current settings: Low risk</span>
              </div>
            </div>

            {/* Messenger priority list */}
            <div className="space-y-3">
              <p className="text-xs font-medium uppercase text-slate-400">
                Messenger Delivery Order
              </p>
              <div className="rounded-lg border border-slate-200 divide-y">
                {messengerPriority.map((messenger, index) => {
                  const meta = messengerMeta[messenger];
                  const chatCount = groupedSelected[messenger]?.length || 0;
                  const hasChats = chatCount > 0;

                  return (
                    <div
                      key={messenger}
                      className={cn(
                        'p-4 transition-colors',
                        !hasChats && 'opacity-50 bg-slate-50',
                      )}
                    >
                      <div className="flex items-start justify-between gap-4 mb-3">
                        <div className="flex items-center gap-3">
                          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-sm font-semibold text-slate-600">
                            {index + 1}
                          </div>
                          <div>
                            <p className="text-sm font-medium text-slate-900">
                              {meta.label}
                            </p>
                            <p className="text-xs text-slate-500 mt-0.5">
                              {chatCount} chat{chatCount !== 1 ? 's' : ''} selected
                            </p>
                          </div>
                        </div>
                        {hasChats && (
                          <span className={cn(
                            'rounded-full px-2 py-0.5 text-xs font-medium',
                            meta.bgClass,
                            meta.textClass,
                          )}>
                            Ready
                          </span>
                        )}
                      </div>

                      {/* Antiban settings display */}
                      <div className="ml-11 grid grid-cols-2 gap-2 text-xs">
                        <div className="rounded bg-slate-50 p-2">
                          <p className="text-slate-500 mb-0.5">Batch Size</p>
                          <p className="font-semibold text-slate-900">10 msgs</p>
                        </div>
                        <div className="rounded bg-slate-50 p-2">
                          <p className="text-slate-500 mb-0.5">Delay</p>
                          <p className="font-semibold text-slate-900">5s</p>
                        </div>
                        <div className="rounded bg-slate-50 p-2">
                          <p className="text-slate-500 mb-0.5">Per Hour</p>
                          <p className="font-semibold text-slate-900">300 msgs</p>
                        </div>
                        <div className="rounded bg-slate-50 p-2">
                          <p className="text-slate-500 mb-0.5">Per Day</p>
                          <p className="font-semibold text-slate-900">2000 msgs</p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Summary */}
            <div className="rounded-lg bg-blue-50 border border-blue-200 p-3">
              <p className="text-xs text-blue-600">
                <span className="font-medium">Estimated delivery time:</span> Based on your settings, this broadcast will be fully delivered within ~2-4 hours depending on messenger rate limits.
              </p>
            </div>
          </div>
        )}

        {/* Step 5: Review */}
        {step === 4 && (
          <div className="space-y-6">
            <h3 className="text-sm font-semibold text-slate-900">
              Review Your Broadcast
            </h3>

            {/* Name & Message */}
            <div className="rounded-lg border border-slate-200 p-4">
              <p className="text-xs font-medium uppercase text-slate-400">
                Broadcast Name
              </p>
              <p className="mt-1 text-sm font-semibold text-slate-900">
                {name}
              </p>
              <p className="mt-4 text-xs font-medium uppercase text-slate-400">
                Message
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">
                {messageText}
              </p>
            </div>

            {/* Recipients */}
            <div className="rounded-lg border border-slate-200 p-4">
              <p className="text-xs font-medium uppercase text-slate-400">
                Recipients ({selectedChatIds.length} chats)
              </p>
              <div className="mt-3 space-y-2">
                {Object.entries(groupedSelected).map(
                  ([messenger, chats]) => {
                    const meta = messengerMeta[messenger];
                    return (
                      <div key={messenger} className="flex items-center gap-2">
                        <span
                          className={cn(
                            'rounded-full px-2 py-0.5 text-xs font-medium',
                            meta?.bgClass,
                            meta?.textClass,
                          )}
                        >
                          {meta?.label}
                        </span>
                        <span className="text-sm text-slate-600">
                          {chats.length} chat{chats.length > 1 ? 's' : ''}
                        </span>
                      </div>
                    );
                  },
                )}
              </div>
            </div>

            {/* Schedule */}
            <div className="rounded-lg border border-slate-200 p-4">
              <p className="text-xs font-medium uppercase text-slate-400">
                Schedule
              </p>
              <p className="mt-1 text-sm font-medium text-slate-900">
                {scheduleType === 'now'
                  ? 'Send immediately'
                  : scheduledAt
                    ? `Scheduled for ${new Date(scheduledAt).toLocaleString(
                        'en-GB',
                        {
                          weekday: 'long',
                          month: 'long',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        },
                      )}`
                    : 'No time selected'}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Navigation */}
      <div className="mt-6 flex items-center justify-between">
        <button
          onClick={step === 0 ? () => router.push('/broadcast') : handleBack}
          className="flex items-center gap-1.5 rounded px-4 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100"
        >
          <ArrowLeft className="h-4 w-4" />
          {step === 0 ? 'Cancel' : 'Back'}
        </button>

        <div className="flex gap-2">
          {step === 4 ? (
            <>
              <button
                onClick={handleSubmit(onSaveDraft)}
                disabled={
                  createMutation.isPending || updateMutation.isPending
                }
                className="flex items-center gap-1.5 rounded border-[1.5px] border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50"
              >
                <Save className="h-4 w-4" />
                Save as Draft
              </button>
              <button
                onClick={handleSubmit(onSendNow)}
                disabled={
                  createMutation.isPending ||
                  updateMutation.isPending ||
                  sendMutation.isPending
                }
                className="flex items-center gap-1.5 rounded bg-accent px-5 py-2 text-sm font-medium text-white shadow-accent-sm transition-colors hover:bg-accent-hover disabled:opacity-50"
              >
                <Send className="h-4 w-4" />
                {scheduleType === 'later' ? 'Schedule' : 'Send Now'}
              </button>
            </>
          ) : (
            <button
              onClick={handleNext}
              className="flex items-center gap-1.5 rounded bg-accent px-5 py-2 text-sm font-medium text-white shadow-accent-sm transition-colors hover:bg-accent-hover"
            >
              Next
              <ArrowRight className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
