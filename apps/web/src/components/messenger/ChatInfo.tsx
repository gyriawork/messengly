'use client';

import { useState, useCallback } from 'react';
import {
  X,
  Pin,
  Star,
  Volume2,
  VolumeX,
  Trash2,
  FileText,
  Users,
  Tag,
  User,
  Megaphone,
  Plus,
  Check,
  ArrowLeft,
} from 'lucide-react';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import { useChatStore } from '@/stores/chat';
import {
  useChatPreferences,
  useDeleteChat,
  useUpdateChat,
  useTags,
} from '@/hooks/useChats';
import type { Chat, MessengerType } from '@/types/chat';
import { ChatAvatar } from '@/components/ui/ChatAvatar';

function getMessengerDotColor(messenger: MessengerType): string {
  const map: Record<MessengerType, string> = {
    telegram: '#0088cc',
    slack: '#611f69',
    whatsapp: '#25D366',
    gmail: '#EA4335',
    teams: '#4B53BC',
  };
  return map[messenger];
}

function getMessengerLabel(messenger: MessengerType): string {
  const map: Record<MessengerType, string> = {
    telegram: 'Telegram',
    slack: 'Slack',
    whatsapp: 'WhatsApp',
    gmail: 'Gmail',
    teams: 'Microsoft Teams',
  };
  return map[messenger];
}

function getMessengerBgClass(messenger: MessengerType): string {
  const map: Record<MessengerType, string> = {
    telegram: 'bg-messenger-tg-bg text-messenger-tg-text',
    slack: 'bg-messenger-sl-bg text-messenger-sl-text',
    whatsapp: 'bg-messenger-wa-bg text-messenger-wa-text',
    gmail: 'bg-messenger-gm-bg text-messenger-gm-text',
    teams: 'bg-messenger-mt-bg text-messenger-mt-text',
  };
  return map[messenger];
}

function getAvatarColor(name: string): string {
  const colors = [
    '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
    '#ec4899', '#f43f5e', '#ef4444', '#f97316',
    '#eab308', '#84cc16', '#22c55e', '#14b8a6',
    '#06b6d4', '#3b82f6', '#2563eb',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

function getChatTypeLabel(chatType: string): string {
  switch (chatType) {
    case 'group':
      return 'Group chat';
    case 'channel':
      return 'Channel';
    default:
      return 'Direct message';
  }
}

function getChatTypeIcon(chatType: string) {
  switch (chatType) {
    case 'group':
      return Users;
    case 'channel':
      return Megaphone;
    default:
      return User;
  }
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
      {children}
    </h4>
  );
}

export function ChatInfo() {
  const activeChat = useChatStore((s) => s.activeChat);
  const setActiveChat = useChatStore((s) => s.setActiveChat);
  const infoPanelOpen = useChatStore((s) => s.infoPanelOpen);
  const setInfoPanelOpen = useChatStore((s) => s.setInfoPanelOpen);
  const isMobile = useIsMobile();
  const setMobileView = useChatStore((s) => s.setMobileView);
  const { mutate: updatePreferences } = useChatPreferences();
  const { mutate: deleteChat, isPending: isDeleting } = useDeleteChat();
  const { mutate: updateChat } = useUpdateChat();
  const { data: tagsData } = useTags();

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isEditingOwner, setIsEditingOwner] = useState(false);
  const [ownerInput, setOwnerInput] = useState('');
  const [showAddTag, setShowAddTag] = useState(false);

  const { data: pinnedData } = useQuery({
    queryKey: ['pinned-messages', activeChat?.id],
    queryFn: () =>
      api.get<{
        messages: Array<{
          id: string;
          text: string;
          senderName: string;
          createdAt: string;
        }>;
      }>(`/api/chats/${activeChat!.id}/messages?pinned=true`),
    enabled: !!activeChat?.id,
  });

  const pinnedMessages = pinnedData?.messages ?? [];

  if (!activeChat || !infoPanelOpen) return null;

  const chat = activeChat;
  const prefs = chat.preferences;
  const ChatTypeIcon = getChatTypeIcon(chat.chatType);
  const availableTags = tagsData?.tags ?? [];
  const chatTagIds = new Set(chat.tags?.map((t) => t.id) ?? []);
  const unassignedTags = availableTags.filter((t) => !chatTagIds.has(t.id));

  const togglePref = (key: 'pinned' | 'favorite' | 'muted') => {
    updatePreferences({
      chatId: chat.id,
      preferences: { [key]: !prefs?.[key] },
    });
  };

  const handleDeleteChat = () => {
    deleteChat(chat.id, {
      onSuccess: () => {
        setActiveChat(null);
        setInfoPanelOpen(false);
        setShowDeleteConfirm(false);
        toast.success('Chat deleted');
      },
      onError: () => toast.error('Failed to delete chat'),
    });
  };

  const handleSaveOwner = () => {
    const trimmed = ownerInput.trim();
    if (!trimmed) {
      setIsEditingOwner(false);
      return;
    }
    updateChat(
      { chatId: chat.id, ownerId: trimmed },
      {
        onSuccess: () => {
          setIsEditingOwner(false);
          toast.success('Owner updated');
        },
        onError: () => toast.error('Failed to update owner'),
      },
    );
  };

  const handleToggleStatus = () => {
    const newStatus = chat.status === 'active' ? 'read-only' : 'active';
    updateChat(
      { chatId: chat.id, status: newStatus },
      {
        onSuccess: () => toast.success(`Status changed to ${newStatus}`),
        onError: () => toast.error('Failed to update status'),
      },
    );
  };

  const handleRemoveTag = (tagId: string) => {
    const currentTagIds = chat.tags?.map((t) => t.id).filter((id) => id !== tagId) ?? [];
    updateChat(
      { chatId: chat.id, tags: currentTagIds },
      {
        onSuccess: () => toast.success('Tag removed'),
        onError: () => toast.error('Failed to remove tag'),
      },
    );
  };

  const handleAddTag = (tagId: string) => {
    const currentTagIds = chat.tags?.map((t) => t.id) ?? [];
    updateChat(
      { chatId: chat.id, tags: [...currentTagIds, tagId] },
      {
        onSuccess: () => {
          setShowAddTag(false);
          toast.success('Tag added');
        },
        onError: () => toast.error('Failed to add tag'),
      },
    );
  };

  return (
    <div className="flex h-full w-full flex-col border-l border-slate-200 bg-white md:w-[320px] md:flex-shrink-0">
      {isMobile && (
        <div className="flex h-12 flex-shrink-0 items-center gap-3 border-b border-slate-200 px-3 md:hidden">
          <button
            onClick={() => setMobileView('chat')}
            className="flex h-9 w-9 items-center justify-center rounded-full text-slate-600 hover:bg-slate-100"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <span className="text-base font-semibold text-slate-900">Chat Info</span>
        </div>
      )}
      {/* Header */}
      <div className="flex h-[60px] flex-shrink-0 items-center justify-between border-b border-slate-100 px-5">
        <h3 className="text-sm font-semibold text-slate-800">Chat Details</h3>
        <button
          onClick={() => setInfoPanelOpen(false)}
          className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Profile section */}
        <div className="flex flex-col items-center border-b border-slate-100 px-5 pb-5 pt-6">
          <ChatAvatar name={chat.name} messenger={chat.messenger} size={64} />

          <h3 className="mt-3 text-base font-semibold text-slate-800">
            {chat.name}
          </h3>

          <div className="mt-1.5 flex items-center gap-2">
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium',
                getMessengerBgClass(chat.messenger),
              )}
            >
              {getMessengerLabel(chat.messenger)}
            </span>
          </div>

          <div className="mt-2 flex items-center gap-1 text-xs text-slate-500">
            <ChatTypeIcon className="h-3.5 w-3.5" />
            <span>{getChatTypeLabel(chat.chatType)}</span>
          </div>

          {/* Owner (editable) */}
          <div className="mt-2 w-full">
            {isEditingOwner ? (
              <div className="flex items-center gap-1.5">
                <input
                  value={ownerInput}
                  onChange={(e) => setOwnerInput(e.target.value)}
                  placeholder="Enter user ID..."
                  className="flex-1 rounded border border-slate-200 px-2 py-1 text-xs text-slate-700 outline-none focus:border-accent"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveOwner();
                    if (e.key === 'Escape') setIsEditingOwner(false);
                  }}
                  autoFocus
                />
                <button
                  onClick={handleSaveOwner}
                  className="flex h-6 w-6 items-center justify-center rounded bg-accent text-white hover:bg-accent-hover"
                >
                  <Check className="h-3 w-3" />
                </button>
                <button
                  onClick={() => setIsEditingOwner(false)}
                  className="flex h-6 w-6 items-center justify-center rounded bg-slate-100 text-slate-500 hover:bg-slate-200"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ) : (
              <button
                onClick={() => {
                  setOwnerInput(chat.ownerId ?? '');
                  setIsEditingOwner(true);
                }}
                className="w-full text-center text-xs text-slate-400 hover:text-accent"
              >
                {chat.ownerName ? (
                  <>
                    Assigned to{' '}
                    <span className="font-medium text-slate-600">
                      {chat.ownerName}
                    </span>{' '}
                    (click to change)
                  </>
                ) : (
                  'Click to assign owner'
                )}
              </button>
            )}
          </div>
        </div>

        {/* Status toggle */}
        <div className="border-b border-slate-100 p-4">
          <SectionTitle>Status</SectionTitle>
          <button
            onClick={handleToggleStatus}
            className={cn(
              'flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-xs font-medium transition-colors',
              chat.status === 'active'
                ? 'bg-green-50 text-green-700'
                : 'bg-slate-100 text-slate-500',
            )}
          >
            <span>{chat.status === 'active' ? 'Active' : 'Read-only'}</span>
            <span className="text-[10px] opacity-70">Click to toggle</span>
          </button>
        </div>

        {/* Metadata */}
        <div className="border-b border-slate-100 p-4">
          <SectionTitle>Details</SectionTitle>
          <div className="space-y-2 text-xs">
            {chat.createdAt && (
              <div className="flex justify-between">
                <span className="text-slate-500">Created</span>
                <span className="text-slate-700">
                  {new Date(chat.createdAt).toLocaleDateString()}
                </span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-slate-500">Messages</span>
              <span className="text-slate-700">{chat.messageCount ?? 0}</span>
            </div>
            {chat.importedByName && (
              <div className="flex justify-between">
                <span className="text-slate-500">Imported by</span>
                <span className="text-slate-700">{chat.importedByName}</span>
              </div>
            )}
            {chat.externalChatId && (
              <div className="flex justify-between">
                <span className="text-slate-500">External ID</span>
                <span
                  className="truncate max-w-[160px] font-mono text-slate-500"
                  title={chat.externalChatId}
                >
                  {chat.externalChatId}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Quick actions */}
        <div className="border-b border-slate-100 p-4">
          <SectionTitle>Quick Actions</SectionTitle>
          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={() => togglePref('muted')}
              className={cn(
                'flex flex-col items-center gap-1.5 rounded-lg py-3 text-xs transition-colors',
                prefs?.muted
                  ? 'bg-red-50 text-red-600'
                  : 'bg-slate-50 text-slate-600 hover:bg-slate-100',
              )}
            >
              {prefs?.muted ? (
                <VolumeX className="h-4 w-4" />
              ) : (
                <Volume2 className="h-4 w-4" />
              )}
              {prefs?.muted ? 'Unmute' : 'Mute'}
            </button>
            <button
              onClick={() => togglePref('favorite')}
              className={cn(
                'flex flex-col items-center gap-1.5 rounded-lg py-3 text-xs transition-colors',
                prefs?.favorite
                  ? 'bg-amber-50 text-amber-600'
                  : 'bg-slate-50 text-slate-600 hover:bg-slate-100',
              )}
            >
              <Star
                className={cn(
                  'h-4 w-4',
                  prefs?.favorite && 'fill-amber-400',
                )}
              />
              {prefs?.favorite ? 'Unfavorite' : 'Favorite'}
            </button>
            <button
              onClick={() => togglePref('pinned')}
              className={cn(
                'flex flex-col items-center gap-1.5 rounded-lg py-3 text-xs transition-colors',
                prefs?.pinned
                  ? 'bg-accent-bg text-accent'
                  : 'bg-slate-50 text-slate-600 hover:bg-slate-100',
              )}
            >
              <Pin className="h-4 w-4" />
              {prefs?.pinned ? 'Unpin' : 'Pin'}
            </button>
          </div>
        </div>

        {/* Participants */}
        <div className="border-b border-slate-100 p-4">
          <SectionTitle>Participants</SectionTitle>
          {chat.participants && chat.participants.length > 0 ? (
            <div className="space-y-2">
              {chat.participants.map((p) => (
                <div key={p.id} className="flex items-center gap-2">
                  <div
                    className="flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-semibold text-white"
                    style={{ backgroundColor: getAvatarColor(p.name) }}
                  >
                    {getInitials(p.name)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-slate-700">
                      {p.name}
                    </p>
                    {p.role && (
                      <p className="text-[10px] text-slate-400">{p.role}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-slate-400">
              No participant data available
            </p>
          )}
        </div>

        {/* Tags (editable) */}
        <div className="border-b border-slate-100 p-4">
          <SectionTitle>Tags</SectionTitle>
          {chat.tags && chat.tags.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {chat.tags.map((tag) => (
                <span
                  key={tag.id}
                  className="group/tag inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium"
                  style={{
                    backgroundColor: `${tag.color}15`,
                    color: tag.color,
                  }}
                >
                  <Tag className="h-3 w-3" />
                  {tag.name}
                  <button
                    onClick={() => handleRemoveTag(tag.id)}
                    className="ml-0.5 hidden rounded-full p-0.5 opacity-70 transition-opacity hover:opacity-100 group-hover/tag:inline-flex"
                    title="Remove tag"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="text-xs text-slate-400">No tags assigned</p>
          )}

          {/* Add tag */}
          {showAddTag ? (
            <div className="mt-2 space-y-1">
              {unassignedTags.length === 0 ? (
                <p className="text-xs text-slate-400">No more tags available</p>
              ) : (
                unassignedTags.map((tag) => (
                  <button
                    key={tag.id}
                    onClick={() => handleAddTag(tag.id)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-slate-600 transition-colors hover:bg-slate-50"
                  >
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: tag.color }}
                    />
                    {tag.name}
                  </button>
                ))
              )}
              <button
                onClick={() => setShowAddTag(false)}
                className="mt-1 text-xs text-slate-400 hover:text-slate-600"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowAddTag(true)}
              className="mt-2 flex items-center gap-1 text-xs text-accent hover:text-accent-hover"
            >
              <Plus className="h-3 w-3" />
              Add tag
            </button>
          )}
        </div>

        {/* Pinned messages */}
        <div className="border-b border-slate-100 p-4">
          <SectionTitle>
            Pinned Messages ({pinnedMessages.length})
          </SectionTitle>
          {pinnedMessages.length > 0 ? (
            <div className="space-y-2">
              {pinnedMessages.slice(0, 5).map((msg) => (
                <div key={msg.id} className="rounded-lg bg-slate-50 p-2.5">
                  <p className="text-xs font-medium text-accent">
                    {msg.senderName}
                  </p>
                  <p className="mt-0.5 line-clamp-2 text-xs text-slate-600">
                    {msg.text}
                  </p>
                  <p className="mt-1 text-[10px] text-slate-400">
                    {new Date(msg.createdAt).toLocaleDateString()}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-lg bg-slate-50 p-3">
              <Pin className="h-4 w-4 flex-shrink-0 text-slate-400" />
              <p className="text-xs text-slate-500">No pinned messages</p>
            </div>
          )}
        </div>

        {/* Shared files */}
        <div className="border-b border-slate-100 p-4">
          <SectionTitle>Shared Files</SectionTitle>
          <div className="flex items-center gap-2 rounded-lg bg-slate-50 p-3">
            <FileText className="h-4 w-4 flex-shrink-0 text-slate-400" />
            <p className="text-xs text-slate-500">No shared files yet</p>
          </div>
        </div>

        {/* Danger zone */}
        <div className="p-4">
          {showDeleteConfirm ? (
            <div className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-3">
              <p className="text-xs font-medium text-red-700">
                Are you sure you want to delete this chat? This action cannot be
                undone.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={handleDeleteChat}
                  disabled={isDeleting}
                  className="flex-1 rounded-lg bg-red-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
                >
                  {isDeleting ? 'Deleting...' : 'Yes, Delete'}
                </button>
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  className="flex-1 rounded-lg bg-white px-3 py-2 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowDeleteConfirm(true)}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-100"
            >
              <Trash2 className="h-4 w-4" />
              Delete Chat
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
