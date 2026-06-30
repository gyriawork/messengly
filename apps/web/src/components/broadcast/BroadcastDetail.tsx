'use client';

import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  RotateCcw,
  Copy,
  Trash2,
  Send,
  CheckCircle2,
  XCircle,
  Clock,
  FileText,
  AlertTriangle,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  useBroadcast,
  useRetryBroadcast,
  useDuplicateBroadcast,
  useDeleteBroadcast,
} from '@/hooks/useBroadcasts';
import type { Broadcast, BroadcastChat, BroadcastStatus } from '@/types/broadcast';

const messengerMeta: Record<
  string,
  { label: string; bgClass: string; textClass: string; barColor: string }
> = {
  telegram: {
    label: 'Telegram',
    bgClass: 'bg-messenger-tg-bg',
    textClass: 'text-messenger-tg-text',
    barColor: 'bg-[#0c447c]',
  },
  slack: {
    label: 'Slack',
    bgClass: 'bg-messenger-sl-bg',
    textClass: 'text-messenger-sl-text',
    barColor: 'bg-[#3c3489]',
  },
  whatsapp: {
    label: 'WhatsApp',
    bgClass: 'bg-messenger-wa-bg',
    textClass: 'text-messenger-wa-text',
    barColor: 'bg-[#3b6d11]',
  },
  gmail: {
    label: 'Gmail',
    bgClass: 'bg-messenger-gm-bg',
    textClass: 'text-messenger-gm-text',
    barColor: 'bg-[#a32d2d]',
  },
};

const statusConfig: Record<
  BroadcastStatus,
  { label: string; className: string; icon: React.ReactNode }
> = {
  draft: {
    label: 'Draft',
    className: 'bg-slate-100 text-slate-600',
    icon: <FileText className="h-4 w-4" />,
  },
  scheduled: {
    label: 'Scheduled',
    className: 'bg-blue-100 text-blue-700',
    icon: <Clock className="h-4 w-4" />,
  },
  sending: {
    label: 'Sending',
    className: 'bg-amber-100 text-amber-700 animate-pulse',
    icon: <Send className="h-4 w-4" />,
  },
  sent: {
    label: 'Sent',
    className: 'bg-emerald-100 text-emerald-700',
    icon: <CheckCircle2 className="h-4 w-4" />,
  },
  partially_failed: {
    label: 'Partially Failed',
    className: 'bg-orange-100 text-orange-700',
    icon: <AlertTriangle className="h-4 w-4" />,
  },
  failed: {
    label: 'Failed',
    className: 'bg-red-100 text-red-700',
    icon: <XCircle className="h-4 w-4" />,
  },
};

interface BroadcastDetailProps {
  id: string;
}

export function BroadcastDetail({ id }: BroadcastDetailProps) {
  const router = useRouter();
  const { data: broadcast, isLoading } = useBroadcast(id);
  const retryMutation = useRetryBroadcast();
  const duplicateMutation = useDuplicateBroadcast();
  const deleteMutation = useDeleteBroadcast();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </div>
    );
  }

  if (!broadcast) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <p className="text-sm text-slate-500">Broadcast not found.</p>
        <button
          onClick={() => router.push('/broadcast')}
          className="mt-4 text-sm font-medium text-accent hover:text-accent-hover"
        >
          Back to Broadcasts
        </button>
      </div>
    );
  }

  const config = statusConfig[broadcast.status];
  const stats = (broadcast as unknown as Record<string, unknown>).stats as { total?: number; sent?: number; failed?: number; pending?: number } | undefined;
  const total = stats?.total || broadcast.chatCount || 0;
  const sent = stats?.sent || broadcast.sentCount || 0;
  const failed = stats?.failed || broadcast.failedCount || 0;
  const progress = total > 0 ? Math.round((sent / total) * 100) : 0;

  // The detail API returns recipients grouped under `chatsByStatus`; normalize
  // to a flat list so the breakdown and failed-recipients table work.
  const allChats = normalizeChats(broadcast);
  const messengerBreakdown = getMessengerBreakdown(allChats);
  const failedChats = allChats.filter((c) => c.status === 'failed');

  // Build status timeline
  const timeline = buildTimeline(broadcast);

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      {/* Back button */}
      <button
        onClick={() => router.push('/broadcast')}
        className="mb-4 flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Broadcasts
      </button>

      {/* Header */}
      <div className="mb-6 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold text-slate-900">
              {broadcast.name}
            </h1>
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium',
                config.className,
              )}
            >
              {config.icon}
              {config.label}
            </span>
          </div>
          <p className="mt-1 text-sm text-slate-500">
            Created{' '}
            {new Date(broadcast.createdAt).toLocaleString('en-GB', {
              month: 'long',
              day: 'numeric',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </p>
        </div>
        <div className="flex gap-1">
          {(broadcast.status === 'failed' ||
            broadcast.status === 'partially_failed') && (
            <button
              onClick={() =>
                retryMutation.mutate(id, {
                  onSuccess: () => toast.success('Retrying failed messages'),
                  onError: () => toast.error('Retry failed'),
                })
              }
              className="flex items-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium text-amber-600 hover:bg-amber-50"
            >
              <RotateCcw className="h-4 w-4" />
              Retry
            </button>
          )}
          <button
            onClick={() =>
              duplicateMutation.mutate(id, {
                onSuccess: () => {
                  toast.success('Broadcast duplicated');
                  router.push('/broadcast');
                },
                onError: () => toast.error('Duplicate failed'),
              })
            }
            className="flex items-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100"
          >
            <Copy className="h-4 w-4" />
            Duplicate
          </button>
          <button
            onClick={() =>
              deleteMutation.mutate(id, {
                onSuccess: () => {
                  toast.success('Broadcast deleted');
                  router.push('/broadcast');
                },
                onError: () => toast.error('Delete failed'),
              })
            }
            className="flex items-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium text-red-500 hover:bg-red-50"
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </button>
        </div>
      </div>

      {/* Message card */}
      <div className="mb-6 rounded-lg bg-white p-5 shadow-xs">
        <p className="mb-2 text-xs font-medium uppercase text-slate-400">
          Message Content
        </p>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">
          {broadcast.messageText}
        </p>
      </div>

      {/* Delivery progress */}
      <div className="mb-6 rounded-lg bg-white p-5 shadow-xs">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-sm font-semibold text-slate-900">
            Delivery Progress
          </p>
          <span className="text-sm font-medium text-slate-600">
            {sent}/{total} ({progress}%)
          </span>
        </div>
        <div className="h-3 overflow-hidden rounded-full bg-slate-100">
          <div
            className={cn(
              'h-full rounded-full transition-all duration-500',
              broadcast.status === 'sending'
                ? 'bg-amber-400'
                : failed > 0
                  ? 'bg-gradient-to-r from-emerald-500 to-emerald-500'
                  : 'bg-emerald-500',
            )}
            style={{ width: `${progress}%` }}
          />
        </div>
        {failed > 0 && (
          <div className="mt-2 flex gap-4 text-xs">
            <span className="flex items-center gap-1 text-emerald-600">
              <CheckCircle2 className="h-3 w-3" />
              {sent} sent
            </span>
            <span className="flex items-center gap-1 text-red-500">
              <XCircle className="h-3 w-3" />
              {failed} failed
            </span>
          </div>
        )}
      </div>

      {/* Per-messenger breakdown */}
      {messengerBreakdown.length > 0 && (
        <div className="mb-6 grid grid-cols-2 gap-3">
          {messengerBreakdown.map((item) => {
            const meta = messengerMeta[item.messenger];
            const pct =
              item.total > 0
                ? Math.round((item.sent / item.total) * 100)
                : 0;
            return (
              <div
                key={item.messenger}
                className={cn(
                  'rounded-lg p-4',
                  meta?.bgClass || 'bg-slate-50',
                )}
              >
                <p
                  className={cn(
                    'text-sm font-semibold',
                    meta?.textClass || 'text-slate-700',
                  )}
                >
                  {meta?.label || item.messenger}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {item.sent}/{item.total} sent ({pct}%)
                </p>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/60">
                  <div
                    className={cn(
                      'h-full rounded-full',
                      meta?.barColor || 'bg-slate-400',
                    )}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Failed recipients */}
      {failedChats.length > 0 && (
        <div className="mb-6 rounded-lg bg-white p-5 shadow-xs">
          <p className="mb-3 text-sm font-semibold text-slate-900">
            Failed Recipients ({failedChats.length})
          </p>
          <div className="overflow-hidden rounded-lg border border-slate-200">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50">
                  <th className="px-4 py-2 text-xs font-medium text-slate-500">
                    Chat
                  </th>
                  <th className="px-4 py-2 text-xs font-medium text-slate-500">
                    Messenger
                  </th>
                  <th className="px-4 py-2 text-xs font-medium text-slate-500">
                    Error
                  </th>
                </tr>
              </thead>
              <tbody>
                {failedChats.map((chat) => {
                  const meta = messengerMeta[chat.messenger];
                  return (
                    <tr
                      key={chat.chatId}
                      className="border-b border-slate-100 last:border-b-0"
                    >
                      <td className="px-4 py-2 font-medium text-slate-700">
                        {chat.chatName}
                      </td>
                      <td className="px-4 py-2">
                        <span
                          className={cn(
                            'rounded-full px-2 py-0.5 text-xs font-medium',
                            meta?.bgClass,
                            meta?.textClass,
                          )}
                        >
                          {meta?.label || chat.messenger}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-xs text-red-500">
                        {chat.error || 'Unknown error'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Status Timeline */}
      <div className="rounded-lg bg-white p-5 shadow-xs">
        <p className="mb-4 text-sm font-semibold text-slate-900">
          Status Timeline
        </p>
        <div className="space-y-0">
          {timeline.map((item, i) => (
            <div key={item.label} className="flex gap-3">
              <div className="flex flex-col items-center">
                <div
                  className={cn(
                    'flex h-6 w-6 items-center justify-center rounded-full',
                    item.active
                      ? 'bg-accent text-white'
                      : item.completed
                        ? 'bg-emerald-500 text-white'
                        : 'bg-slate-200 text-slate-400',
                  )}
                >
                  {item.completed ? (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  ) : (
                    <span className="text-xs font-medium">{i + 1}</span>
                  )}
                </div>
                {i < timeline.length - 1 && (
                  <div
                    className={cn(
                      'w-px flex-1 min-h-[24px]',
                      item.completed ? 'bg-emerald-300' : 'bg-slate-200',
                    )}
                  />
                )}
              </div>
              <div className="pb-4">
                <p
                  className={cn(
                    'text-sm font-medium',
                    item.active
                      ? 'text-accent'
                      : item.completed
                        ? 'text-slate-900'
                        : 'text-slate-400',
                  )}
                >
                  {item.label}
                </p>
                {item.time && (
                  <p className="text-xs text-slate-400">{item.time}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// The broadcast detail endpoint returns recipients grouped by status under
// `chatsByStatus`; older shapes used a flat `chats` array. Normalize both to a
// flat BroadcastChat[] so the UI can render failures and per-messenger stats.
function normalizeChats(broadcast: Broadcast): BroadcastChat[] {
  if (broadcast.chats && broadcast.chats.length > 0) return broadcast.chats;
  const cbs = (
    broadcast as unknown as {
      chatsByStatus?: Record<
        string,
        Array<{
          chatId: string;
          status: string;
          errorReason?: string | null;
          chat?: { name?: string; messenger?: string };
        }>
      >;
    }
  ).chatsByStatus;
  if (!cbs) return [];
  const out: BroadcastChat[] = [];
  for (const list of Object.values(cbs)) {
    for (const item of list ?? []) {
      out.push({
        chatId: item.chatId,
        chatName: item.chat?.name ?? 'Unknown chat',
        messenger: item.chat?.messenger ?? 'telegram',
        status: item.status as BroadcastChat['status'],
        error: item.errorReason ?? undefined,
      });
    }
  }
  return out;
}

function getMessengerBreakdown(chats: BroadcastChat[]) {
  if (!chats || chats.length === 0) return [];

  const map: Record<string, { total: number; sent: number; failed: number }> =
    {};
  for (const chat of chats) {
    if (!map[chat.messenger]) {
      map[chat.messenger] = { total: 0, sent: 0, failed: 0 };
    }
    map[chat.messenger].total++;
    if (chat.status === 'sent') map[chat.messenger].sent++;
    if (chat.status === 'failed') map[chat.messenger].failed++;
  }

  return Object.entries(map).map(([messenger, stats]) => ({
    messenger,
    ...stats,
  }));
}

function buildTimeline(broadcast: Broadcast) {
  const statusOrder: BroadcastStatus[] = [
    'draft',
    'scheduled',
    'sending',
    'sent',
  ];
  const currentIndex = statusOrder.indexOf(broadcast.status);
  const isFailed =
    broadcast.status === 'failed' ||
    broadcast.status === 'partially_failed';

  const items = [
    {
      label: 'Created',
      completed: true,
      active: false,
      time: new Date(broadcast.createdAt).toLocaleString('en-GB', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
    },
    {
      label: broadcast.scheduledAt ? 'Scheduled' : 'Ready to send',
      completed: currentIndex >= 1 || broadcast.status === 'sending' || broadcast.status === 'sent' || isFailed,
      active: broadcast.status === 'scheduled',
      time: broadcast.scheduledAt
        ? new Date(broadcast.scheduledAt).toLocaleString('en-GB', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })
        : undefined,
    },
    {
      label: 'Sending',
      completed: broadcast.status === 'sent' || broadcast.status === 'partially_failed',
      active: broadcast.status === 'sending',
      time: undefined,
    },
    {
      label: isFailed
        ? broadcast.status === 'partially_failed'
          ? 'Partially Failed'
          : 'Failed'
        : 'Delivered',
      completed: broadcast.status === 'sent',
      active: isFailed,
      time: broadcast.sentAt
        ? new Date(broadcast.sentAt).toLocaleString('en-GB', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })
        : undefined,
    },
  ];

  return items;
}
