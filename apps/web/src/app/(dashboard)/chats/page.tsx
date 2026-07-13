'use client';

import { useState, useMemo, useEffect, useLayoutEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Search,
  Plus,
  Filter,
  MoreHorizontal,
  Trash2,
  UserCheck,
  Tag,
  MessageSquare,
  Users,
  Hash,
  Mail,
  ChevronDown,
  X,
  Loader2,
  ArrowUpDown,
  Download,
  RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { formatDate } from '@/lib/dates';
import { downloadXls } from '@/lib/xls';
import { useChats, useBulkDeleteChats, useBulkAssignChats, useBulkTagChats, useRefreshChatStatuses } from '@/hooks/useChats';
import { useTags } from '@/hooks/useTags';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { ChatAvatar } from '@/components/ui/ChatAvatar';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import type { Chat, MessengerType } from '@/types/chat';
import { RequireOrgContext } from '@/components/layout/RequireOrgContext';
import { groupGmailChats, isChatGroup, type ChatRow, type ChatGroup } from '@/lib/chat-grouping';
import { useAuthStore } from '@/stores/auth';
import { NewChatsBanner } from '@/components/chats/NewChatsBanner';

// ─── Constants ───

const messengerConfig: Record<
  MessengerType,
  { label: string; abbr: string; bgClass: string; textClass: string; dotColor: string }
> = {
  telegram: { label: 'Telegram', abbr: 'TG', bgClass: 'bg-messenger-tg-bg', textClass: 'text-messenger-tg-text', dotColor: 'bg-[#0088cc]' },
  slack: { label: 'Slack', abbr: 'SL', bgClass: 'bg-messenger-sl-bg', textClass: 'text-messenger-sl-text', dotColor: 'bg-[#611f69]' },
  whatsapp: { label: 'WhatsApp', abbr: 'WA', bgClass: 'bg-messenger-wa-bg', textClass: 'text-messenger-wa-text', dotColor: 'bg-[#25D366]' },
  gmail: { label: 'Gmail', abbr: 'GM', bgClass: 'bg-messenger-gm-bg', textClass: 'text-messenger-gm-text', dotColor: 'bg-[#EA4335]' },
  teams: { label: 'MS Teams', abbr: 'MT', bgClass: 'bg-messenger-mt-bg', textClass: 'text-messenger-mt-text', dotColor: 'bg-[#4B53BC]' },
};

const statusChip: Record<string, { label: string; tone: 'positive' | 'negative' | 'warning' }> = {
  active: { label: 'Active', tone: 'positive' },
  inactive: { label: 'Inactive', tone: 'negative' },
  'read-only': { label: 'Read-only', tone: 'warning' },
};

const chatTypeIcons: Record<string, typeof MessageSquare> = {
  direct: MessageSquare,
  group: Users,
  channel: Hash,
};

// ─── Export chats to an Excel-openable .xls file (no external dependency) ───

function exportChatsToXls(chats: Chat[]) {
  const rows = chats.map((c) => [
    c.name,
    messengerConfig[c.messenger]?.label ?? c.messenger,
    c.chatType,
    c.ownerName ?? '',
    (c.tags ?? []).map((t) => t.name).join(', '),
    formatDate(c.createdAt),
  ]);
  downloadXls(
    `chats-${new Date().toISOString().slice(0, 10)}`,
    ['Name', 'Messenger', 'Type', 'Owner', 'Labels', 'Date created'],
    rows,
  );
}

// ─── Assign Owner Dropdown (free-text owner label) ───

function AssignOwnerDropdown({
  selectedIds,
  onDone,
}: {
  selectedIds: string[];
  onDone: () => void;
}) {
  const [ownerName, setOwnerName] = useState('');
  const assignMutation = useBulkAssignChats();

  const save = (value: string) => {
    assignMutation.mutate(
      { chatIds: selectedIds, ownerName: value },
      {
        onSuccess: () => {
          toast.success(
            value.trim()
              ? `Owner set to "${value.trim()}" for ${selectedIds.length} chat(s)`
              : `Owner cleared for ${selectedIds.length} chat(s)`,
          );
          onDone();
        },
        onError: () => toast.error('Failed to set owner'),
      },
    );
  };

  return (
    <>
      <div className="fixed inset-0 z-10" onClick={onDone} />
      <div className="absolute left-0 top-full z-20 mt-1 w-64 rounded-lg border border-slate-200 bg-white p-2 shadow-lg">
        <p className="px-1 pb-1.5 text-xs font-medium text-slate-400">Set owner (any name)</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (ownerName.trim()) save(ownerName);
          }}
          className="flex flex-col gap-2"
        >
          <input
            value={ownerName}
            onChange={(e) => setOwnerName(e.target.value)}
            placeholder="e.g. John, Sales team…"
            autoFocus
            className="w-full rounded-lg border-[1.5px] border-slate-200 px-2.5 py-1.5 text-xs transition-colors placeholder:text-slate-400 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15"
          />
          <div className="flex gap-1.5">
            <button
              type="submit"
              disabled={assignMutation.isPending || !ownerName.trim()}
              className="flex-1 rounded-lg bg-accent px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => save('')}
              disabled={assignMutation.isPending}
              className="rounded-lg border-[1.5px] border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50"
            >
              Clear
            </button>
          </div>
        </form>
      </div>
    </>
  );
}

// ─── Add/Remove Tag Dropdown ───

function AddTagDropdown({
  selectedIds,
  selectedChats,
  onDone,
}: {
  selectedIds: string[];
  selectedChats: Chat[];
  onDone: () => void;
}) {
  const { data } = useTags();
  const tagMutation = useBulkTagChats();
  const queryClient = useQueryClient();
  const tags = data?.tags ?? [];

  // Compute which tags are applied to ALL selected chats (fully applied)
  // vs some (partially applied) vs none
  const tagStates = useMemo(() => {
    const map = new Map<string, 'all' | 'some' | 'none'>();
    for (const tag of tags) {
      let count = 0;
      for (const chat of selectedChats) {
        if ((chat.tags ?? []).some((t) => t.id === tag.id)) count++;
      }
      if (count === 0) map.set(tag.id, 'none');
      else if (count === selectedChats.length) map.set(tag.id, 'all');
      else map.set(tag.id, 'some');
    }
    return map;
  }, [tags, selectedChats]);

  const handleToggleTag = (tagId: string, tagName: string) => {
    const state = tagStates.get(tagId) ?? 'none';
    const action = state === 'all' ? 'remove' : 'add';
    tagMutation.mutate(
      { chatIds: selectedIds, tagId, action },
      {
        onSuccess: () => {
          toast.success(
            action === 'add'
              ? `Tag "${tagName}" added to ${selectedIds.length} chat(s)`
              : `Tag "${tagName}" removed from ${selectedIds.length} chat(s)`,
          );
          queryClient.invalidateQueries({ queryKey: ['chats'] });
        },
        onError: () => toast.error(`Failed to ${action} tag`),
      },
    );
  };

  return (
    <>
      <div className="fixed inset-0 z-10" onClick={onDone} />
      <div className="absolute left-0 top-full z-20 mt-1 w-52 rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
        <p className="px-3 py-1.5 text-xs font-medium text-slate-400">Toggle tags</p>
        {tags.length === 0 ? (
          <p className="px-3 py-2 text-xs text-slate-400">No labels available</p>
        ) : (
          tags.map((tag) => {
            const state = tagStates.get(tag.id) ?? 'none';
            return (
              <button
                key={tag.id}
                onClick={() => handleToggleTag(tag.id, tag.name)}
                disabled={tagMutation.isPending}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50"
              >
                <div className={cn(
                  'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
                  state === 'all' ? 'border-accent bg-accent' : state === 'some' ? 'border-accent bg-accent/40' : 'border-slate-300',
                )}>
                  {(state === 'all' || state === 'some') && (
                    <svg className="h-3 w-3 text-white" viewBox="0 0 12 12" fill="none">
                      {state === 'all' ? (
                        <path d="M10 3L4.5 8.5L2 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      ) : (
                        <path d="M3 6H9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      )}
                    </svg>
                  )}
                </div>
                <span
                  className="h-3 w-3 rounded-full shrink-0"
                  style={{ backgroundColor: tag.color }}
                />
                {tag.name}
              </button>
            );
          })
        )}
      </div>
    </>
  );
}

// ─── Bulk Actions ───

function BulkActions({
  selectedIds,
  selectedChats,
  onClear,
  isSuperadmin,
}: {
  selectedIds: string[];
  selectedChats: Chat[];
  onClear: () => void;
  isSuperadmin: boolean;
}) {
  const [showAssign, setShowAssign] = useState(false);
  const [showTagMenu, setShowTagMenu] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const deleteMutation = useBulkDeleteChats();

  const handleDelete = () => {
    deleteMutation.mutate(selectedIds, {
      onSuccess: () => {
        toast.success(`${selectedIds.length} chat(s) deleted`);
        onClear();
        setShowDeleteConfirm(false);
      },
      onError: () => toast.error('Failed to delete chats'),
    });
  };

  return (
    <div className="flex items-center gap-3 rounded-lg bg-accent-bg px-4 py-2.5">
      <span className="text-sm font-medium text-accent">
        {selectedIds.length} selected
      </span>
      <div className="h-4 w-px bg-accent/20" />

      {/* Assign Owner */}
      <div className="relative">
        <button
          onClick={() => { setShowAssign(!showAssign); setShowTagMenu(false); }}
          className="flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100"
        >
          <UserCheck className="h-3.5 w-3.5" />
          Assign Owner
        </button>
        {showAssign && (
          <AssignOwnerDropdown
            selectedIds={selectedIds}
            onDone={() => { setShowAssign(false); onClear(); }}
          />
        )}
      </div>

      {/* Add Tag */}
      <div className="relative">
        <button
          onClick={() => { setShowTagMenu(!showTagMenu); setShowAssign(false); }}
          className="flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100"
        >
          <Tag className="h-3.5 w-3.5" />
          Add Label
        </button>
        {showTagMenu && (
          <AddTagDropdown
            selectedIds={selectedIds}
            selectedChats={selectedChats}
            onDone={() => { setShowTagMenu(false); }}
          />
        )}
      </div>

      {/* Delete — superadmin only */}
      {isSuperadmin && (
      <div className="relative">
        <button
          onClick={() => setShowDeleteConfirm(true)}
          disabled={deleteMutation.isPending}
          className="flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-50"
        >
          {deleteMutation.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
          Delete
        </button>
        {showDeleteConfirm && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setShowDeleteConfirm(false)} />
            <div className="absolute left-0 top-full z-20 mt-1 w-64 rounded-lg border border-slate-200 bg-white p-3 shadow-lg">
              <p className="mb-2 text-sm font-medium text-slate-700">
                Delete {selectedIds.length} chat(s)?
              </p>
              <p className="mb-3 text-xs text-slate-500">This action cannot be undone.</p>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  className="flex-1 rounded-lg border-[1.5px] border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDelete}
                  disabled={deleteMutation.isPending}
                  className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
                >
                  {deleteMutation.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
                  Delete
                </button>
              </div>
            </div>
          </>
        )}
      </div>
      )}

      <button
        onClick={onClear}
        className="flex items-center gap-1 rounded px-2.5 py-1.5 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-100"
      >
        <X className="h-3.5 w-3.5" />
        Cancel
      </button>
    </div>
  );
}

// ─── Chat Row Actions ───

function ChatRowActions({ chat }: { chat: Chat }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/api/chats/${chat.id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['chats'] });
      toast.success(`Chat "${chat.name}" deleted`);
    },
    onError: () => toast.error('Failed to delete chat'),
  });

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        aria-label="Chat actions"
        className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-1 w-44 rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
            {/* "Open in Messenger" removed — the Messenger view is disabled for now. */}
            <button
              onClick={() => {
                deleteMutation.mutate();
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete Chat
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// Relative-time formatter shared by ChatsPage and GroupRow.
// ─── GroupRow ───
// Renders a virtual row representing a group of Gmail chats from the same
// sender domain. Visually identical to a normal chat row. Click navigates
// to /messenger?search=<domain> so the existing left-panel search shows
// the constituent threads.

function GroupRow({
  group,
  selectedIds,
  onToggleGroup,
  compact = false,
}: {
  group: ChatGroup;
  selectedIds: string[];
  onToggleGroup: (chatIds: string[]) => void;
  compact?: boolean;
}) {
  const cfg = messengerConfig.gmail;
  const groupChatIds = group.chats.map((c) => c.id);
  const allSelected = groupChatIds.length > 0 && groupChatIds.every((id) => selectedIds.includes(id));
  const someSelected = !allSelected && groupChatIds.some((id) => selectedIds.includes(id));

  return (
    <tr className={cn('transition-colors hover:bg-slate-50/50', allSelected && 'bg-accent-bg/30')}>
      {/* Group checkbox — selects/deselects all chats in the group */}
      <td className="px-4 py-3">
        <input
          type="checkbox"
          checked={allSelected}
          ref={(el) => { if (el) el.indeterminate = someSelected; }}
          onChange={() => onToggleGroup(groupChatIds)}
          className="h-4 w-4 rounded border-slate-300 text-accent focus:ring-accent/30"
        />
      </td>

      {/* Chat: avatar + label (no preview — visually consistent with other rows) */}
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          {!compact && <ChatAvatar name={group.label} messenger="gmail" size={36} />}
          <div className="min-w-0">
            <a
              href={`/messenger?search=${encodeURIComponent(group.domain)}`}
              className="text-sm font-medium text-slate-800 hover:text-accent"
            >
              {group.label}
            </a>
          </div>
        </div>
      </td>

      {/* Status — N/A for groups */}
      <td className="px-4 py-3 text-xs text-slate-300">—</td>

      {/* Messenger badge */}
      <td className="px-4 py-3">
        <span
          className={cn(
            'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
            cfg.bgClass,
            cfg.textClass,
          )}
        >
          {cfg.label}
        </span>
      </td>

      {/* Type — N/A for groups */}
      <td className="px-4 py-3 text-xs text-slate-300">—</td>

      {/* Owner — N/A for groups */}
      <td className="px-4 py-3 text-xs text-slate-300">—</td>

      {/* Tags union */}
      <td className="px-4 py-3">
        <div className="flex flex-wrap gap-1">
          {group.tags.length === 0 ? (
            <span className="text-[10px] text-slate-300">—</span>
          ) : (
            group.tags.map((tag) => (
              <span
                key={tag.id}
                className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                style={{ backgroundColor: tag.color + '18', color: tag.color }}
              >
                {tag.name}
              </span>
            ))
          )}
        </div>
      </td>

      {/* Last active */}
      <td className="px-4 py-3 text-xs text-slate-500">
        {formatDate(
          new Date(
            Math.min(...group.chats.map((c) => new Date(c.createdAt ?? 0).getTime())),
          ).toISOString(),
        )}
      </td>

      {/* Actions — N/A for groups */}
      <td className="px-3 py-3" />
    </tr>
  );
}

// ─── Main Page ───

export default function ChatsPage() {
  const router = useRouter();
  // Only the superadmin manages chats (import / assign / tag / delete).
  // Regular users get a read-only view for picking broadcast recipients.
  const isSuperadmin = useAuthStore((s) => s.user?.role) === 'superadmin';

  // Compact view: a third of the row height, no avatars. Persisted per browser.
  const [compactView, setCompactView] = useState(false);
  // Rows animate ONLY on a manual toggle. Restoring the saved mode must be
  // instant, so transitions stay off until the user flips the switch.
  const [viewToggledManually, setViewToggledManually] = useState(false);
  // Layout effect: the saved mode applies before the first paint, so a
  // compact-mode visitor never sees the normal rows collapse.
  useLayoutEffect(() => {
    setCompactView(localStorage.getItem('chats-compact-view') === '1');
  }, []);
  const toggleCompactView = () => {
    setViewToggledManually(true);
    setCompactView((v) => {
      localStorage.setItem('chats-compact-view', v ? '0' : '1');
      return !v;
    });
  };
  const refreshStatuses = useRefreshChatStatuses();

  const handleRefreshStatuses = () => {
    refreshStatuses.mutate(undefined, {
      onSuccess: (data) => {
        // Disconnected messengers are skipped server-side; anything in `errors`
        // is a real failure of a connected messenger's check.
        if (Object.keys(data.errors).length > 0) {
          toast.error('Sync Failed');
        } else {
          toast.success('Success');
        }
      },
      onError: () => toast.error('Sync Failed'),
    });
  };
  const [search, setSearch] = useState('');
  const [messengerFilter, setMessengerFilter] = useState<MessengerType | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [ownerFilter, setOwnerFilter] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [sortBy, setSortBy] = useState<'createdAt' | 'lastActivityAt' | 'name' | 'messageCount' | 'chatType' | 'tags' | 'lastMessageDate' | 'ownerName' | 'status'>('createdAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [chatTypeFilter, setChatTypeFilter] = useState<string | null>(null);

  const { data: tagsData } = useTags();

  const { data, isLoading } = useChats({
    search: search || undefined,
    messenger: messengerFilter,
    status: statusFilter || undefined,
    owner: ownerFilter || undefined,
    tagId: tagFilter || undefined,
    limit: 1000,
  });

  const chats = data?.chats ?? [];
  const total = data?.total ?? 0;

  // Reachability summary over ALL chats, independent of the filter bar.
  const { data: allData } = useChats({ limit: 1000 });
  const statusCounts = useMemo(() => {
    const all = allData?.chats ?? [];
    return {
      active: all.filter((c) => c.status === 'active').length,
      inactive: all.filter((c) => c.status === 'inactive').length,
    };
  }, [allData]);

  const sorted = useMemo<ChatRow[]>(() => {
    // 1. Apply chat-type filter (existing logic).
    let filtered = chats;
    if (chatTypeFilter) {
      filtered = filtered.filter((c) => c.chatType === chatTypeFilter);
    }

    // 2. Group eligible Gmail chats by sender domain.
    const rows = groupGmailChats(filtered);

    // 3. Sort. Helper functions handle both Chat and ChatGroup.
    const getName = (r: ChatRow) => (isChatGroup(r) ? r.label : r.name);
    const getMessageCount = (r: ChatRow) =>
      isChatGroup(r) ? r.totalMessages : (r.messageCount ?? 0);
    const getChatType = (r: ChatRow) => (isChatGroup(r) ? '' : (r.chatType ?? ''));
    const getFirstTagName = (r: ChatRow) =>
      isChatGroup(r) ? r.tags[0]?.name : r.tags?.[0]?.name;
    const getLastMessageTime = (r: ChatRow) => {
      if (isChatGroup(r)) return new Date(r.lastActivityAt).getTime();
      return r.lastMessage?.createdAt ? new Date(r.lastMessage.createdAt).getTime() : 0;
    };
    const getLastActivity = (r: ChatRow) =>
      new Date(r.lastActivityAt ?? 0).getTime();

    return [...rows].sort((a, b) => {
      let cmp = 0;
      if (sortBy === 'name') {
        cmp = getName(a).localeCompare(getName(b));
      } else if (sortBy === 'messageCount') {
        cmp = getMessageCount(a) - getMessageCount(b);
      } else if (sortBy === 'chatType') {
        cmp = getChatType(a).localeCompare(getChatType(b));
      } else if (sortBy === 'tags') {
        const aTag = getFirstTagName(a);
        const bTag = getFirstTagName(b);
        if (!aTag && !bTag) cmp = 0;
        else if (!aTag) cmp = 1;
        else if (!bTag) cmp = -1;
        else cmp = aTag.localeCompare(bTag);
      } else if (sortBy === 'ownerName') {
        const aOwner = isChatGroup(a) ? '' : (a.ownerName ?? '');
        const bOwner = isChatGroup(b) ? '' : (b.ownerName ?? '');
        // Chats without an owner sink to the bottom in both directions.
        if (!aOwner && !bOwner) cmp = 0;
        else if (!aOwner) cmp = 1;
        else if (!bOwner) cmp = -1;
        else cmp = aOwner.localeCompare(bOwner);
      } else if (sortBy === 'status') {
        const aStatus = isChatGroup(a) ? '' : (a.status ?? '');
        const bStatus = isChatGroup(b) ? '' : (b.status ?? '');
        cmp = aStatus.localeCompare(bStatus);
      } else if (sortBy === 'lastMessageDate') {
        cmp = getLastMessageTime(a) - getLastMessageTime(b);
      } else if (sortBy === 'createdAt') {
        // A gmail group is as old as its oldest chat.
        const getCreated = (r: ChatRow) =>
          isChatGroup(r)
            ? Math.min(...r.chats.map((c) => new Date(c.createdAt ?? 0).getTime()))
            : new Date(r.createdAt ?? 0).getTime();
        cmp = getCreated(a) - getCreated(b);
      } else {
        cmp = getLastActivity(a) - getLastActivity(b);
      }
      return sortDir === 'desc' ? -cmp : cmp;
    });
    // `search` intentionally absent from deps: server-side filtering already
    // narrows `chats` for that input, so adding it would only cause redundant
    // recomputes.
  }, [chats, chatTypeFilter, sortBy, sortDir]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const toggleSelectAll = () => {
    // Collect ALL selectable IDs: individual chats + chats inside groups
    const selectableIds: string[] = [];
    for (const r of sorted) {
      if (isChatGroup(r)) {
        for (const c of r.chats) selectableIds.push(c.id);
      } else {
        selectableIds.push((r as Chat).id);
      }
    }
    if (selectedIds.length === selectableIds.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(selectableIds);
    }
  };

  const toggleGroup = (chatIds: string[]) => {
    setSelectedIds((prev) => {
      const allIn = chatIds.every((id) => prev.includes(id));
      if (allIn) {
        // Deselect all in group
        const remove = new Set(chatIds);
        return prev.filter((id) => !remove.has(id));
      }
      // Select all in group (add missing)
      const existing = new Set(prev);
      return [...prev, ...chatIds.filter((id) => !existing.has(id))];
    });
  };

  return (
    <RequireOrgContext>
    <div className="px-4 py-6 md:px-6 md:py-8">
      {/* Header */}
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Chats</h1>
          <p className="text-sm text-slate-500">
            {total} chat{total !== 1 ? 's' : ''} across all messengers
          </p>
          <div className="mt-2 flex gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-700 shadow-xs">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              {statusCounts.active} active
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-700 shadow-xs">
              <span className="inline-flex h-2 w-2 rounded-full bg-rose-500" />
              {statusCounts.inactive} inactive
            </span>
          </div>
        </div>
        {/* Importing chats from a connected account is available to every user. */}
        <div className="flex gap-2 self-start">
        <button
          type="button"
          role="switch"
          aria-checked={compactView}
          onClick={toggleCompactView}
          title="Compact view: denser rows, no avatars"
          className="group inline-flex items-center gap-2.5 rounded-lg border-[1.5px] border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 transition-all hover:bg-slate-50 hover:-translate-y-px motion-safe:active:translate-y-0 motion-safe:active:scale-[0.98]"
        >
          <span
            className={cn(
              'relative h-5 w-9 shrink-0 rounded-full transition-colors duration-300 ease-out',
              compactView ? 'bg-accent' : 'bg-slate-300 group-hover:bg-slate-400',
            )}
          >
            <span
              className={cn(
                'absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-300 ease-out',
                compactView && 'translate-x-4',
              )}
            />
          </span>
          <span className="w-[6.75rem] text-left">
            {compactView ? 'Compact view' : 'Normal view'}
          </span>
        </button>
        <button
          onClick={handleRefreshStatuses}
          disabled={refreshStatuses.isPending}
          title="Re-check every chat against its messenger and mark unreachable ones inactive"
          className="inline-flex items-center gap-2 rounded-lg border-[1.5px] border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition-all hover:bg-slate-50 hover:-translate-y-px motion-safe:active:translate-y-0 motion-safe:active:scale-[0.98] disabled:opacity-60"
        >
          <RefreshCw className={cn('h-4 w-4', refreshStatuses.isPending && 'animate-spin')} />
          {refreshStatuses.isPending ? 'Updating…' : 'Update chats'}
        </button>
        <button
          onClick={() => router.push('/import')}
          className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white shadow-accent-sm transition-all hover:bg-accent-hover hover:-translate-y-px motion-safe:active:translate-y-0 motion-safe:active:scale-[0.98]"
        >
          <Download className="h-4 w-4" />
          Import chats
        </button>
        </div>
      </div>

      <NewChatsBanner />

      {/* Filters bar */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        {/* Search */}
        <div className="relative min-w-0 flex-1 sm:min-w-[200px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search chats..."
            className="w-full rounded-lg border-[1.5px] border-slate-200 py-2 pl-9 pr-3 text-sm transition-colors placeholder:text-slate-400 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15"
          />
        </div>

        {/* Messenger filter */}
        <select
          value={messengerFilter ?? ''}
          onChange={(e) => setMessengerFilter((e.target.value as MessengerType) || null)}
          className="rounded-lg border-[1.5px] border-slate-200 px-3 py-2 text-xs text-slate-600 focus:border-accent focus:outline-none"
        >
          <option value="">All Messengers</option>
          {(Object.keys(messengerConfig) as MessengerType[])
            .filter((m) => m !== 'gmail') // Gmail hidden — broadcast-focused service
            .map((m) => (
              <option key={m} value={m}>{messengerConfig[m].label}</option>
            ))}
        </select>

        {/* Status filter */}
        <select
          value={statusFilter ?? ''}
          onChange={(e) => setStatusFilter(e.target.value || null)}
          className="rounded-lg border-[1.5px] border-slate-200 px-3 py-2 text-xs text-slate-600 focus:border-accent focus:outline-none"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="read-only">Read-only</option>
        </select>

        {/* Chat type filter */}
        <select
          value={chatTypeFilter ?? ''}
          onChange={(e) => setChatTypeFilter(e.target.value || null)}
          className="rounded-lg border-[1.5px] border-slate-200 px-3 py-2 text-xs text-slate-600 focus:border-accent focus:outline-none"
        >
          <option value="">All types</option>
          <option value="direct">Direct</option>
          <option value="group">Group</option>
          <option value="channel">Channel</option>
        </select>

        {/* Tag filter */}
        <select
          value={tagFilter ?? ''}
          onChange={(e) => setTagFilter(e.target.value || null)}
          className="rounded-lg border-[1.5px] border-slate-200 px-3 py-2 text-xs text-slate-600 focus:border-accent focus:outline-none"
        >
          <option value="">All labels</option>
          {(tagsData?.tags ?? []).map((tag) => (
            <option key={tag.id} value={tag.id}>{tag.name}</option>
          ))}
        </select>

        {/* Owner filter */}
        <input
          value={ownerFilter ?? ''}
          onChange={(e) => setOwnerFilter(e.target.value || null)}
          placeholder="Filter by owner..."
          className="rounded-lg border-[1.5px] border-slate-200 py-2 pl-3 pr-3 text-xs text-slate-600 placeholder:text-slate-400 focus:border-accent focus:outline-none w-full sm:w-36"
        />

        {/* Sort dropdown */}
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
          className="rounded-lg border-[1.5px] border-slate-200 px-3 py-2 text-xs text-slate-600 focus:border-accent focus:outline-none"
        >
          <option value="createdAt">Sort: Date Created</option>
          <option value="lastMessageDate">Sort: Last Message</option>
          <option value="name">Sort: Name</option>
          <option value="chatType">Sort: Type</option>
          <option value="tags">Sort: Labels</option>
          <option value="ownerName">Sort: Owner</option>
          <option value="status">Sort: Status</option>
        </select>

        {/* Sort direction toggle */}
        <button
          onClick={() => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))}
          className="flex items-center gap-1 rounded-lg border-[1.5px] border-slate-200 px-2.5 py-2 text-xs text-slate-600 transition-colors hover:bg-slate-50"
          title={sortDir === 'desc' ? 'Descending' : 'Ascending'}
        >
          <ArrowUpDown className="h-3.5 w-3.5" />
          {sortDir === 'desc' ? '\u2193' : '\u2191'}
        </button>

        {/* Export to Excel \u2014 available to all roles */}
        <button
          onClick={() => exportChatsToXls(chats)}
          disabled={chats.length === 0}
          className="flex items-center gap-1.5 rounded-lg border-[1.5px] border-slate-200 px-2.5 py-2 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50"
          title="Export chats to Excel"
        >
          <Download className="h-3.5 w-3.5" />
          Export
        </button>
      </div>

      {/* Bulk actions — tags + owner for all roles; delete is superadmin-only */}
      {selectedIds.length > 0 && (
        <div className="mb-4">
          <BulkActions
            selectedIds={selectedIds}
            selectedChats={chats.filter((c) => selectedIds.includes(c.id))}
            onClear={() => setSelectedIds([])}
            isSuperadmin={isSuperadmin}
          />
        </div>
      )}

      {/* Mobile card list */}
      <div className="flex flex-col gap-2 md:hidden">
        {isLoading &&
          Array.from({ length: 6 }).map((_, i) => (
            <div
              key={`sk-${i}`}
              className="rounded-xl border border-slate-200 bg-white p-3"
            >
              <div className="flex items-center gap-3">
                <Skeleton className="h-2 w-2 rounded-full" />
                <Skeleton className="h-3.5 flex-1" />
                <Skeleton className="h-2.5 w-12" />
              </div>
              <Skeleton className="mt-2 ml-5 h-2.5 w-3/4" />
            </div>
          ))}
        {!isLoading && sorted.length === 0 && (
          <EmptyState
            icon={<MessageSquare className="h-10 w-10" />}
            title="No chats yet"
            description={
              isSuperadmin
                ? 'Connect a messenger and your chats will show up here.'
                : 'No chats have been imported yet. Ask your administrator to connect a messenger.'
            }
            compact
            action={
              isSuperadmin ? (
                <a
                  href="/settings"
                  className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:bg-accent-hover"
                >
                  <Plus className="h-4 w-4" />
                  Connect messenger
                </a>
              ) : undefined
            }
          />
        )}
        {sorted.map((row) => {
          if (isChatGroup(row)) {
            const cfg = messengerConfig.gmail;
            const groupChatIds = row.chats.map((c) => c.id);
            const allSel = groupChatIds.every((id) => selectedIds.includes(id));
            return (
              <div
                key={`group-${row.domain}`}
                className={cn(
                  'rounded-xl border border-slate-200 bg-white p-3 transition-colors',
                  allSel && 'border-accent bg-accent/5',
                )}
                onClick={() => toggleGroup(groupChatIds)}
              >
                <div className="flex items-center gap-3">
                  <div className={cn('h-2 w-2 rounded-full', cfg.dotColor)} />
                  <span className="flex-1 truncate text-sm font-medium text-slate-900">
                    {row.label}
                  </span>
                  <span className="text-xs text-slate-400">
                    {row.totalMessages} msgs
                  </span>
                </div>
              </div>
            );
          }
          const chat = row;
          const cfg = messengerConfig[chat.messenger];
          const isSelected = selectedIds.includes(chat.id);
          return (
            <div
              key={chat.id}
              className={cn(
                'rounded-xl border border-slate-200 bg-white p-3 transition-colors',
                isSelected && 'border-accent bg-accent/5',
              )}
              onClick={() => toggleSelect(chat.id)}
            >
              <div className="flex items-center gap-3">
                <div className={cn('h-2 w-2 rounded-full', cfg.dotColor)} />
                <span className="flex-1 truncate text-sm font-medium text-slate-900">
                  {chat.name}
                </span>
                <span className="text-xs text-slate-400">
                  {chat.lastMessage?.createdAt
                    ? new Date(chat.lastMessage.createdAt).toLocaleDateString()
                    : ''}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Table */}
      <div className="hidden overflow-hidden rounded-lg bg-white shadow-xs md:block">
        {isLoading ? (
          <div className="divide-y divide-slate-100">
            {/* Header skeleton */}
            <div className="flex items-center gap-4 bg-slate-50/50 px-4 py-3">
              <Skeleton className="h-4 w-4 rounded" />
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-14" />
              <Skeleton className="h-3 w-16" />
              <Skeleton className="ml-auto h-3 w-20" />
            </div>
            {/* Row skeletons */}
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-4 py-3">
                <Skeleton className="h-4 w-4 rounded" />
                <Skeleton className="h-9 w-9 rounded-full" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-40" />
                  <Skeleton className="h-2.5 w-24" />
                </div>
                <Skeleton className="h-5 w-16 rounded-full" />
                <Skeleton className="h-3 w-14" />
                <Skeleton className="h-3 w-10" />
                <Skeleton className="h-3 w-16" />
              </div>
            ))}
          </div>
        ) : sorted.length === 0 ? (
          <EmptyState
            icon={<MessageSquare className="h-12 w-12" />}
            title="No chats yet"
            description={
              isSuperadmin
                ? 'Connect a messenger and your chats will show up here.'
                : 'No chats have been imported yet. Ask your administrator to connect a messenger.'
            }
            action={
              isSuperadmin ? (
                <a
                  href="/settings"
                  className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:bg-accent-hover hover:-translate-y-px motion-safe:active:translate-y-0 motion-safe:active:scale-[0.98]"
                >
                  <Plus className="h-4 w-4" />
                  Connect messenger
                </a>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
          <table
            className={cn(
              'w-full min-w-[860px]',
              viewToggledManually && '[&_tbody_td]:transition-[padding] [&_tbody_td]:duration-200',
              compactView && '[&_tbody_td]:py-1',
            )}
          >
            <thead className="sticky top-0 z-10">
              <tr className="border-b border-slate-100 bg-slate-50">
                <th className="w-10 px-4 py-3">
                  <input
                    type="checkbox"
                    checked={
                      selectedIds.length > 0 &&
                      selectedIds.length === sorted.filter((r) => !isChatGroup(r)).length
                    }
                    onChange={toggleSelectAll}
                    className="h-4 w-4 rounded border-slate-300 text-accent focus:ring-accent/30"
                  />
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500">
                  Chat
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500">
                  Status
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500">
                  Messenger
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500">
                  Type
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500">
                  Owner
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500">
                  Labels
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500">
                  Date Created
                </th>
                <th className="w-10 px-3 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sorted.map((row) => {
                if (isChatGroup(row)) {
                  return <GroupRow key={`group-${row.domain}`} group={row} selectedIds={selectedIds} onToggleGroup={toggleGroup} compact={compactView} />;
                }
                const chat = row;
                const mcfg = messengerConfig[chat.messenger];
                const TypeIcon = chatTypeIcons[chat.chatType] ?? MessageSquare;
                const isSelected = selectedIds.includes(chat.id);

                return (
                  <tr
                    key={chat.id}
                    className={cn(
                      'transition-colors hover:bg-slate-50/50',
                      isSelected && 'bg-accent-bg/30',
                    )}
                  >
                    {/* Checkbox */}
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(chat.id)}
                        className="h-4 w-4 rounded border-slate-300 text-accent focus:ring-accent/30"
                      />
                    </td>

                    {/* Chat name + avatar */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {!compactView && (
                          <ChatAvatar name={chat.name} messenger={chat.messenger} size={36} />
                        )}
                        <div>
                          {/* Messenger view is disabled — chat name is not a link for now. */}
                          <span className="text-sm font-medium text-slate-800">
                            {chat.name}
                          </span>

                        </div>
                      </div>
                    </td>

                    {/* Status */}
                    <td className="px-4 py-3">
                      <StatusBadge tone={(statusChip[chat.status] ?? statusChip.active).tone}>
                        {(statusChip[chat.status] ?? statusChip.active).label}
                      </StatusBadge>
                    </td>

                    {/* Messenger */}
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
                          mcfg.bgClass,
                          mcfg.textClass,
                        )}
                      >
                        {mcfg.label}
                      </span>
                    </td>

                    {/* Type */}
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1 text-xs text-slate-500">
                        <TypeIcon className="h-3.5 w-3.5" />
                        {chat.chatType.charAt(0).toUpperCase() + chat.chatType.slice(1)}
                      </span>
                    </td>

                    {/* Owner */}
                    <td className="px-4 py-3 text-xs text-slate-500">
                      {chat.ownerName ?? '—'}
                    </td>

                    {/* Tags */}
                    <td className="px-4 py-3">
                      <div className="flex gap-1 flex-wrap">
                        {(chat.tags ?? []).map((tag) => (
                          <span
                            key={tag.id}
                            className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                            style={{
                              backgroundColor: tag.color + '18',
                              color: tag.color,
                            }}
                          >
                            {tag.name}
                          </span>
                        ))}
                        {(!chat.tags || chat.tags.length === 0) && (
                          <span className="text-[10px] text-slate-300">—</span>
                        )}
                      </div>
                    </td>

                    {/* Date created */}
                    <td className="px-4 py-3 text-xs text-slate-500">
                      {formatDate(chat.createdAt)}
                    </td>

                    {/* Actions — superadmin only (chat management) */}
                    <td className="px-3 py-3">
                      {isSuperadmin && <ChatRowActions chat={chat} />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </div>

    </div>
    </RequireOrgContext>
  );
}
