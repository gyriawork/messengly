'use client';

import { useState, useMemo, useRef, useCallback } from 'react';
import Link from 'next/link';
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
  AlertCircle,
  AlertTriangle,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useAllChats } from '@/hooks/useChats';
import {
  useCreateBroadcast,
  useUpdateBroadcast,
  useBroadcast,
  useSendBroadcast,
  useAntibanSettings,
} from '@/hooks/useBroadcasts';
import { useTemplates, useTemplateUse } from '@/hooks/useTemplates';
import { useTags } from '@/hooks/useTags';
import type { MessengerType } from '@/types/chat';
import type { BroadcastAttachment, AntibanSettings } from '@/types/broadcast';
import { api } from '@/lib/api';
import { estimateMessenger, formatDuration, formatFinishTime } from '@/lib/broadcast-estimate';

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
  const fileInputRef = useRef<React.ElementRef<'input'>>(null);

  const { data: existingBroadcast } = useBroadcast(editId || undefined);
  // Stream in ALL chats page by page so every imported chat is selectable as
  // a recipient — a hard limit here would silently drop recipients past it.
  const { chats: loadedChats } = useAllChats();
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
  const allChats = loadedChats.filter((c) => c.status !== 'inactive');

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

  // A broadcast is one day's send, so a messenger cannot deliver more than its
  // daily anti-ban limit in one go — the rest would stall. Block the wizard
  // until the operator raises the limit or trims recipients.
  // Poll every 10s so the Review-step duration estimate follows settings
  // changes made in the Broadcast Settings panel without a reload.
  const { data: antibanData } = useAntibanSettings({ refetchInterval: 10_000 });
  const dailyLimits = useMemo(() => {
    const map: Record<string, number> = {};
    for (const st of antibanData?.settings ?? []) map[st.messenger] = st.maxMessagesPerDay;
    return map;
  }, [antibanData]);
  const overLimit = useMemo(() => {
    const out: { messenger: string; count: number; limit: number }[] = [];
    for (const [messenger, chats] of Object.entries(groupedSelected)) {
      const limit = dailyLimits[messenger];
      if (typeof limit === 'number' && chats.length > limit) {
        out.push({ messenger, count: chats.length, limit });
      }
    }
    return out;
  }, [groupedSelected, dailyLimits]);

  // Live duration estimate per messenger, driven by the same anti-ban settings
  // the worker will use. Recomputes whenever recipients change or the settings
  // query refreshes (e.g. after editing Broadcast Settings), so the numbers on
  // the Review step always match the current configuration.
  const pacingByMessenger = useMemo(() => {
    const map: Record<string, AntibanSettings> = {};
    for (const st of antibanData?.settings ?? []) map[st.messenger] = st;
    return map;
  }, [antibanData]);
  const estimates = useMemo(() => {
    const perMessenger = Object.entries(groupedSelected).map(([messenger, chats]) => ({
      messenger,
      count: chats.length,
      ...estimateMessenger(messenger, chats.length, pacingByMessenger[messenger]),
    }));
    // Messengers send in parallel — the broadcast ends with the slowest one.
    const totalSeconds = perMessenger.reduce((m, e) => Math.max(m, e.seconds), 0);
    return { perMessenger, totalSeconds };
  }, [groupedSelected, pacingByMessenger]);

  async function handleNext() {
    if (step === 0) {
      const valid = await trigger(['name', 'messageText']);
      if (!valid) return;
    } else if (step === 1) {
      const valid = await trigger(['chatIds']);
      if (!valid) return;
      if (overLimit.length > 0) {
        toast.error('Some messengers have more chats than their daily limit allows');
        return;
      }
    } else if (step === 2) {
      if (scheduleType === 'later') {
        const valid = await trigger(['scheduledAt']);
        if (!valid && !scheduledAt) {
          toast.error('Please select a date and time');
          return;
        }
      }
    }
    setStep((s) => Math.min(s + 1, 3));
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
    <div className="mx-auto max-w-4xl px-4 py-6 md:px-6 md:py-8">
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
          <div className="space-y-5 motion-safe:animate-step-in">
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
          <div className="space-y-4 motion-safe:animate-step-in">
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

            {overLimit.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                <div className="flex gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                  <div className="text-xs text-amber-800">
                    <p className="font-medium">Too many chats for the daily limit</p>
                    <ul className="mt-1 space-y-0.5">
                      {overLimit.map((o) => (
                        <li key={o.messenger}>
                          <span className="font-medium">{messengerMeta[o.messenger]?.label ?? o.messenger}</span>:{" "}
                          {o.count} selected, but only {o.limit}/day allowed
                        </li>
                      ))}
                    </ul>
                    <p className="mt-1.5">
                      Raise the daily limit in{" "}
                      <Link
                        href="/broadcast?settings=antiban"
                        className="font-semibold text-accent underline underline-offset-2 hover:text-accent-hover"
                      >
                        Broadcast Settings
                      </Link>{" "}
                      or remove some recipients to continue.
                    </p>
                  </div>
                </div>
              </div>
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
                <option value="">All labels</option>
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
                      No chats found. Bring some in from the Import section
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
                              'flex h-5 w-5 shrink-0 items-center justify-center rounded-lg border-[1.5px] transition-all',
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
          <div className="space-y-6 motion-safe:animate-step-in">
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

        {/* Step 4: Review */}
        {step === 3 && (
          <div className="space-y-6 motion-safe:animate-step-in">
            <h3 className="text-sm font-semibold text-slate-900">
              Review Your Broadcast
            </h3>

            {/* Recipients + duration estimate — the numbers the operator
                actually checks before hitting Send, so they come first. */}
            {(() => {
              const startAt =
                scheduleType === 'later' && scheduledAt ? new Date(scheduledAt) : new Date();
              const finishAt = new Date(startAt.getTime() + estimates.totalSeconds * 1000);
              return (
            <div className="rounded-lg border border-slate-200 p-4">
              <p className="text-xs font-medium uppercase text-slate-400">
                Recipients ({selectedChatIds.length} chats)
              </p>
              <div className="mt-3 space-y-2">
                {estimates.perMessenger.map((e) => {
                  const meta = messengerMeta[e.messenger];
                  return (
                    <div key={e.messenger} className="flex flex-wrap items-center gap-2">
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
                        {e.count} chat{e.count > 1 ? 's' : ''}
                      </span>
                      <span className="text-xs text-slate-400">·</span>
                      <span className="text-sm text-slate-500">
                        ~{formatDuration(e.seconds)}
                      </span>
                      {e.dailyCapHit && (
                        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                          daily limit: {e.sentToday} today, {e.count - e.sentToday} next day
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
              {estimates.totalSeconds > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-slate-100 pt-3 text-sm">
                  <span className="text-slate-500">
                    Total (messengers run in parallel):{' '}
                    <span className="font-semibold text-slate-800">
                      ~{formatDuration(estimates.totalSeconds)}
                    </span>
                  </span>
                  <span className="text-slate-500">
                    Estimated finish:{' '}
                    <span className="font-semibold text-slate-800">
                      {formatFinishTime(finishAt)}
                    </span>
                  </span>
                </div>
              )}
              <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
                Based on your current Broadcast Settings — change the pacing there and this
                estimate updates.
              </p>
            </div>
              );
            })()}

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
          {step === 3 ? (
            <>
              <button
                onClick={handleSubmit(onSaveDraft)}
                disabled={
                  createMutation.isPending || updateMutation.isPending
                }
                className="flex items-center gap-1.5 rounded-lg border-[1.5px] border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50"
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
                className="flex items-center gap-1.5 rounded-lg bg-accent px-5 py-2 text-sm font-medium text-white shadow-accent-sm transition-colors hover:bg-accent-hover disabled:opacity-50"
              >
                <Send className="h-4 w-4" />
                {scheduleType === 'later' ? 'Schedule' : 'Send Now'}
              </button>
            </>
          ) : (
            <button
              onClick={handleNext}
              disabled={step === 1 && overLimit.length > 0}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-5 py-2 text-sm font-medium text-white shadow-accent-sm transition-colors hover:bg-accent-hover disabled:opacity-50 disabled:hover:bg-accent"
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
