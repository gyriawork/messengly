'use client';

import React, { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Search,
  Pin,
  PinOff,
  Volume2,
  VolumeX,
  Star,
  Loader2,
  MessageCircle,
  Plus,
} from 'lucide-react';
import { ImportChatsModal } from './ImportChatsModal';
import { cn } from '@/lib/utils';
import { ChatAvatar } from '@/components/ui/ChatAvatar';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { useChatStore } from '@/stores/chat';
import { useChats, useChatPreferences } from '@/hooks/useChats';
import { useTags } from '@/hooks/useTags';
import { previewText } from '@/lib/messageFormatters';
import type { Chat, MessengerType } from '@/types/chat';

const MESSENGER_FILTERS: Array<{
  key: MessengerType;
  label: string;
}> = [
  { key: 'telegram', label: 'Telegram' },
  { key: 'slack', label: 'Slack' },
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'gmail', label: 'Gmail' },
];

function formatTime(dateStr?: string): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffDays === 0) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) {
    return date.toLocaleDateString([], { weekday: 'short' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

const ChatItem = React.memo(function ChatItem({ chat, isActive }: { chat: Chat; isActive: boolean }) {
  const setActiveChat = useChatStore((s) => s.setActiveChat);
  const isUnread = chat.preferences?.unread;
  const isPinned = chat.preferences?.pinned;
  const isMuted = chat.preferences?.muted;
  const isFavorite = chat.preferences?.favorite;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { mutate: updatePreferences } = useChatPreferences();

  useEffect(() => {
    if (!menu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenu(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menu]);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  };

  const pref = (patch: { pinned?: boolean; favorite?: boolean; muted?: boolean }) => {
    updatePreferences({ chatId: chat.id, preferences: patch });
    setMenu(null);
  };

  return (
    <>
    <button
      onClick={() => setActiveChat(chat)}
      onContextMenu={handleContextMenu}
      className={cn(
        'group flex w-full items-start gap-3 px-4 py-3 text-left transition-colors duration-150',
        isActive
          ? 'border-l-[3px] border-accent bg-accent-bg'
          : isUnread
            ? 'border-l-[3px] border-accent/60 bg-accent/[0.04] hover:bg-accent/[0.07]'
            : 'border-l-[3px] border-transparent hover:bg-slate-50',
      )}
    >
      {/* Avatar */}
      <div className="relative flex-shrink-0">
        <ChatAvatar name={chat.name} messenger={chat.messenger} size={40} />
        {/* Sync indicator */}
        {chat.syncStatus && chat.syncStatus !== 'synced' && (
          <span className="absolute -top-0.5 -left-0.5">
            <Loader2 className="h-3 w-3 animate-spin text-accent" />
          </span>
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span
            className={cn(
              'truncate text-sm',
              isUnread ? 'font-semibold text-slate-900' : 'font-medium text-slate-700',
            )}
          >
            {chat.name}
            {chat.syncStatus && chat.syncStatus !== 'synced' && (
              <span className="ml-1 text-[10px] text-accent">Syncing...</span>
            )}
          </span>
          <div className="flex flex-shrink-0 items-center gap-1">
            {isPinned && (
              <Pin className="h-3 w-3 text-slate-400" />
            )}
            {isFavorite && (
              <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
            )}
            {isMuted && (
              <Volume2 className="h-3 w-3 text-slate-300" />
            )}
            <span className={cn(
              'text-[10px]',
              isUnread ? 'font-semibold text-accent' : 'text-slate-400',
            )}>
              {formatTime(chat.lastMessage?.createdAt || chat.lastActivityAt)}
            </span>
          </div>
        </div>

        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className={cn(
            'truncate text-xs',
            isUnread ? 'font-medium text-slate-700' : 'text-slate-500',
          )}>
            {chat.lastMessage
              ? `${chat.lastMessage.senderName}: ${previewText(chat.lastMessage.text, chat.messenger) || '📎 Attachment'}`
              : 'No messages yet'}
          </p>
          {isUnread && (
            <div className="flex h-2.5 w-2.5 flex-shrink-0 rounded-full bg-accent" />
          )}
        </div>

        {/* Tags */}
        {chat.tags && chat.tags.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {chat.tags.slice(0, 3).map((tag) => (
              <span
                key={tag.id}
                className="inline-block rounded-full px-1.5 py-0 text-[9px] font-medium"
                style={{
                  backgroundColor: `${tag.color}20`,
                  color: tag.color,
                }}
              >
                {tag.name}
              </span>
            ))}
          </div>
        )}
      </div>
    </button>

    {/* Context menu */}
    {menu && (
      <div
        ref={menuRef}
        style={{ top: menu.y, left: menu.x }}
        className="fixed z-50 min-w-[160px] overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
      >
        <button
          onClick={() => pref({ pinned: !isPinned })}
          className="flex w-full items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
        >
          {isPinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
          {isPinned ? 'Unpin' : 'Pin'}
        </button>
        <button
          onClick={() => pref({ favorite: !isFavorite })}
          className="flex w-full items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
        >
          <Star className={cn('h-3.5 w-3.5', isFavorite && 'fill-amber-400 text-amber-400')} />
          {isFavorite ? 'Remove from favorites' : 'Add to favorites'}
        </button>
        <button
          onClick={() => pref({ muted: !isMuted })}
          className="flex w-full items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
        >
          {isMuted ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
          {isMuted ? 'Unmute' : 'Mute'}
        </button>
      </div>
    )}
    </>
  );
});

export function ChatList() {
  const [sortBy, setSortBy] = useState<'lastActivityAt' | 'lastMessageDate' | 'name' | 'messageCount'>('lastActivityAt');
  const [showImport, setShowImport] = useState(false);
  const {
    activeChat,
    searchQuery,
    setSearchQuery,
    messengerFilter,
    setMessengerFilter,
    tagFilter,
    setTagFilter,
  } = useChatStore();

  const [localSearch, setLocalSearch] = useState(searchQuery);

  // Seed search from ?search=... URL param (set by /chats group rows
  // navigating to /messenger?search=<domain>). Runs once on mount only —
  // intentional, because the only entry point that uses this param is a full
  // navigation from /chats. If client-side ?search= changes ever become a
  // requirement, switch to depending on `searchParams`.
  const searchParams = useSearchParams();
  useEffect(() => {
    const fromUrl = searchParams?.get('search');
    if (fromUrl && fromUrl !== searchQuery) {
      setSearchQuery(fromUrl);
      setLocalSearch(fromUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const debounceRef = useRef<NodeJS.Timeout>();
  const handleSearchChange = useCallback((value: string) => {
    setLocalSearch(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setSearchQuery(value), 300);
  }, [setSearchQuery]);

  const { data: tagsData } = useTags();
  const tags = tagsData?.tags ?? [];

  const { data, isLoading } = useChats({
    search: searchQuery || undefined,
    messenger: messengerFilter,
    tagId: tagFilter || undefined,
    limit: 1000,
  });

  const chats = data?.chats ?? [];

  const sortedChats = useMemo(() => {
    const sortFn = (a: Chat, b: Chat): number => {
      if (sortBy === 'name') return a.name.localeCompare(b.name);
      if (sortBy === 'messageCount') return (b.messageCount ?? 0) - (a.messageCount ?? 0);
      if (sortBy === 'lastMessageDate') {
        const aTime = a.lastMessage?.createdAt ? new Date(a.lastMessage.createdAt).getTime() : 0;
        const bTime = b.lastMessage?.createdAt ? new Date(b.lastMessage.createdAt).getTime() : 0;
        return bTime - aTime;
      }
      // lastActivityAt (default)
      const aTime = new Date(a.lastActivityAt || a.lastMessage?.createdAt || 0).getTime();
      const bTime = new Date(b.lastActivityAt || b.lastMessage?.createdAt || 0).getTime();
      return bTime - aTime;
    };

    const pinned = chats.filter((c) => c.preferences?.pinned).sort(sortFn);
    const unpinned = chats.filter((c) => !c.preferences?.pinned).sort(sortFn);

    return [...pinned, ...unpinned];
  }, [chats, sortBy]);

  return (
    <>
      <div className="flex h-full w-full flex-col border-r border-slate-200 bg-white md:w-[300px] md:flex-shrink-0">
        {/* Header */}
        <div className="flex-shrink-0 border-b border-slate-100 px-4 pb-3 pt-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-800">Messenger</h2>
            <button
              onClick={() => setShowImport(true)}
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent-bg"
              title="Import chats"
            >
              <Plus className="h-3.5 w-3.5" />
              Import
            </button>
          </div>

          {/* Search */}
          <div className="relative mt-3">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Search chats..."
              value={localSearch}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="h-9 w-full rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-3 text-sm text-slate-700 placeholder-slate-400 outline-none transition-shadow focus:border-accent focus:bg-white focus:shadow-focus-ring"
            />
          </div>

          {/* Filters */}
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <select
              value={messengerFilter ?? ''}
              onChange={(e) => setMessengerFilter((e.target.value as MessengerType) || null)}
              className="flex-1 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-600 outline-none transition-colors focus:border-accent focus:bg-white"
            >
              <option value="">All Messengers</option>
              {MESSENGER_FILTERS.map((f) => (
                <option key={f.key} value={f.key}>{f.label}</option>
              ))}
            </select>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
              className="flex-1 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-600 outline-none transition-colors focus:border-accent focus:bg-white"
            >
              <option value="lastActivityAt">Last Active</option>
              <option value="lastMessageDate">Last Message</option>
              <option value="name">Name</option>
              <option value="messageCount">Messages</option>
            </select>
            {tags.length > 0 && (
              <select
                value={tagFilter ?? ''}
                onChange={(e) => setTagFilter(e.target.value || null)}
                className="flex-1 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-600 outline-none transition-colors focus:border-accent focus:bg-white"
              >
                <option value="">All Labels</option>
                {tags.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            )}
          </div>
        </div>

        {/* Chat list */}
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            // Skeleton list: 6 chat-item shaped placeholders so the left
            // panel keeps its layout instead of collapsing into a spinner.
            <div className="flex flex-col gap-1 p-2" aria-busy="true" aria-live="polite">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-3">
                  <Skeleton className="h-10 w-10 flex-shrink-0 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-3.5 w-24" />
                    <Skeleton className="h-3 w-36" />
                  </div>
                </div>
              ))}
            </div>
          ) : sortedChats.length === 0 ? (
            <EmptyState
              icon={<MessageCircle className="h-10 w-10" />}
              title="No chats yet"
              description="Import chats from a connected messenger"
            />
          ) : (
            <div className="py-1">
              {sortedChats.map((chat) => (
                <ChatItem
                  key={chat.id}
                  chat={chat}
                  isActive={activeChat?.id === chat.id}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      {showImport && <ImportChatsModal onClose={() => setShowImport(false)} />}
    </>
  );
}
