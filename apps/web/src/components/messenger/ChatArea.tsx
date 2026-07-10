'use client';

import {
  useRef,
  useEffect,
  useState,
  useCallback,
  useMemo,
  type FormEvent,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Send,
  Paperclip,
  Pin,
  PinOff,
  Search,
  PanelRightOpen,
  MessageSquare,
  User,
  Users,
  Megaphone,
  X,
  Reply,
  Check,
  CheckCheck,
  Pencil,
  Trash2,
  Clock,
  AlertCircle,
  Smile,
  FileText,
  ArrowLeft,
  Info,
  History,
} from 'lucide-react';
import { useIsMobile } from '@/hooks/useIsMobile';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { getAvatarColor, getInitials } from '@/lib/chat-utils';
import { ChatAvatar } from '@/components/ui/ChatAvatar';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState as UIEmptyState } from '@/components/ui/EmptyState';
import { EmailThread } from './EmailThread';
import { api } from '@/lib/api';
import { useChatStore } from '@/stores/chat';
import { useAuthStore } from '@/stores/auth';
import {
  useMessages,
  useSendMessage,
  useEditMessage,
  useDeleteMessage,
  usePinMessage,
  useSearchMessages,
  useLoadFullHistory,
  type MessageAttachment,
} from '@/hooks/useChats';
import EmojiPicker, { Theme, type EmojiClickData } from 'emoji-picker-react';
import { useReactions } from '@/hooks/useReactions';
import { useTemplates, useTemplateUse } from '@/hooks/useTemplates';
import { useIntegrations } from '@/hooks/useIntegrations';

import { ReactionsBubble } from './ReactionsBubble';
import TypingIndicator from './TypingIndicator';
import { MessageText } from './MessageText';
import { MessageAttachments } from './MessageAttachments';
import { useSocket, getSocket } from '@/hooks/useSocket';
import type { Chat, Message, MessengerType } from '@/types/chat';

// Telegram allows only a specific set of emoji for message reactions.
const TELEGRAM_ALLOWED_EMOJI: string[] = [
  '👍', '👎', '❤️', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱',
  '🤬', '😢', '🎉', '🤩', '🤮', '💩', '🙏', '👌', '🕊', '🤡',
  '🥱', '🥴', '😍', '🐳', '❤️‍🔥', '🌚', '🌭', '💯', '🤣', '⚡',
  '🍌', '🏆', '💔', '🤨', '😐', '🍓', '🍾', '💋', '🖕', '😈',
  '😴', '😭', '🤓', '👻', '👨‍💻', '👀', '🎃', '🙈', '😇', '😨',
  '🤝', '✍️', '🤗', '🫡', '🎅', '🎄', '☃️', '💅', '🤪', '🗿',
  '🆒', '💘', '🙉', '🦄', '😘', '💊', '🙊', '😎', '👾', '🤷',
  '🤷‍♂️', '🤷‍♀️', '😡',
];

function getReactionSupport(messenger: string): 'full' | 'limited' | 'none' {
  switch (messenger) {
    case 'telegram':
      return 'limited';
    case 'slack':
      return 'full';
    default:
      return 'none';
  }
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

function formatMessageTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDateSeparator(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round(
    (today.getTime() - msgDate.getTime()) / 86400000,
  );

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return date.toLocaleDateString([], {
    month: 'long',
    day: 'numeric',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  });
}

function DeliveryIcon({ status }: { status?: string }) {
  switch (status) {
    case 'sending':
      return <Clock className="h-3 w-3 text-white/40" />;
    case 'sent':
      return <Check className="h-3 w-3 text-white/60" />;
    case 'delivered':
      return <CheckCheck className="h-3 w-3 text-white/60" />;
    case 'read':
      return <CheckCheck className="h-3 w-3 text-white" />;
    case 'failed':
      return <AlertCircle className="h-3 w-3 text-red-300" />;
    default:
      return null;
  }
}

function MessageBubble({
  message,
  messenger,
  onReply,
}: {
  message: Message;
  messenger?: string;
  onReply: (message: Message) => void;
}) {
  const isSelf = message.isSelf;
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(message.text);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const emojiPickerRef = useRef<HTMLDivElement>(null);
  const emojiButtonRef = useRef<HTMLButtonElement>(null);

  const { mutate: editMessage, isPending: isEditPending } = useEditMessage();
  const { mutate: deleteMessage, isPending: isDeletePending } = useDeleteMessage();
  const { mutate: pinMessage } = usePinMessage();
  const { mutate: sendMessage, isPending: isRetrySending } = useSendMessage();

  const currentUserId = useAuthStore((s) => s.user?.id);
  const {
    addReaction,
    removeReaction,
    isAddingReaction,
    isRemovingReaction,
  } = useReactions(message.chatId, message.id);

  const reactionGroups = useMemo(() => {
    if (!message.reactions?.length) return [];
    const groups = new Map<string, { emoji: string; count: number; userReacted: boolean }>();
    for (const r of message.reactions) {
      const existing = groups.get(r.emoji);
      if (existing) {
        existing.count++;
        if (r.userId === currentUserId) existing.userReacted = true;
      } else {
        groups.set(r.emoji, { emoji: r.emoji, count: 1, userReacted: r.userId === currentUserId });
      }
    }
    return Array.from(groups.values());
  }, [message.reactions, currentUserId]);

  const handleRetry = useCallback(() => {
    sendMessage(
      { chatId: message.chatId, text: message.text },
      { onError: () => toast.error('Retry failed') },
    );
  }, [message.chatId, message.text, sendMessage]);

  const handleEdit = useCallback(() => {
    setEditText(message.text);
    setIsEditing(true);
    setTimeout(() => editRef.current?.focus(), 0);
  }, [message.text]);

  const handleEditSave = useCallback(() => {
    const trimmed = editText.trim();
    if (!trimmed || trimmed === message.text) {
      setIsEditing(false);
      return;
    }
    editMessage(
      { messageId: message.id, text: trimmed },
      {
        onSuccess: () => {
          setIsEditing(false);
          toast.success('Message edited');
        },
        onError: () => toast.error('Failed to edit message'),
      },
    );
  }, [editText, message.id, message.text, editMessage]);

  const handleEditCancel = useCallback(() => {
    setIsEditing(false);
    setEditText(message.text);
  }, [message.text]);

  const handleEditKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleEditSave();
    }
    if (e.key === 'Escape') {
      handleEditCancel();
    }
  };

  const handlePin = useCallback(() => {
    pinMessage(
      { messageId: message.id, isPinned: !message.isPinned },
      {
        onSuccess: () =>
          toast.success(message.isPinned ? 'Message unpinned' : 'Message pinned'),
        onError: () => toast.error('Failed to update pin'),
      },
    );
  }, [message.id, message.isPinned, pinMessage]);

  const handleDelete = useCallback(() => {
    deleteMessage(message.id, {
      onSuccess: () => {
        setShowDeleteConfirm(false);
        toast.success('Message deleted');
      },
      onError: () => toast.error('Failed to delete message'),
    });
  }, [message.id, deleteMessage]);

  // Close emoji picker on outside click
  useEffect(() => {
    if (!showEmojiPicker) return;
    function handleClickOutside(e: MouseEvent) {
      if (
        emojiPickerRef.current &&
        !emojiPickerRef.current.contains(e.target as Node) &&
        emojiButtonRef.current &&
        !emojiButtonRef.current.contains(e.target as Node)
      ) {
        setShowEmojiPicker(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showEmojiPicker]);

  const handleEmojiSelect = useCallback(
    (emoji: string) => {
      const normalize = (e: string) => e.replace(/\uFE0F/g, '');
      if (messenger === 'telegram' && !TELEGRAM_ALLOWED_EMOJI.some(a => normalize(a) === normalize(emoji))) {
        toast.error('This emoji is not supported in Telegram');
        return;
      }
      addReaction(emoji);
      setShowEmojiPicker(false);
    },
    [addReaction, messenger],
  );

  return (
    <div
      className={cn(
        'group relative flex max-w-[70%] flex-col',
        isSelf ? 'ml-auto items-end' : 'mr-auto items-start',
      )}
    >
      {/* Hover action bar */}
      <div
        className={cn(
          'absolute -top-3 z-10 flex items-center gap-0.5 rounded-lg border border-slate-200 bg-white px-1 py-0.5 shadow-sm transition-opacity',
          showEmojiPicker ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
          isSelf ? 'right-0' : 'left-0',
        )}
      >
        <button
          onClick={() => onReply(message)}
          className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          title="Reply"
        >
          <Reply className="h-3.5 w-3.5" />
        </button>
        {isSelf && (
          <button
            onClick={handleEdit}
            className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            title="Edit"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          onClick={handlePin}
          className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          title={message.isPinned ? 'Unpin' : 'Pin'}
        >
          {message.isPinned ? (
            <PinOff className="h-3.5 w-3.5" />
          ) : (
            <Pin className="h-3.5 w-3.5" />
          )}
        </button>
        {getReactionSupport(messenger ?? '') !== 'none' && (
          <div className="relative">
            <button
              ref={emojiButtonRef}
              onClick={() => setShowEmojiPicker(!showEmojiPicker)}
              disabled={isAddingReaction || isRemovingReaction}
              className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-40"
              title="Add reaction"
            >
              <Smile className="h-3.5 w-3.5" />
            </button>
            {showEmojiPicker && (
              <div
                ref={emojiPickerRef}
                className={cn(
                  'absolute bottom-full mb-2 z-50 shadow-lg rounded-lg overflow-hidden',
                  isSelf ? 'right-0' : 'left-0',
                )}
              >
                {messenger === 'telegram' ? (
                  <div className="grid grid-cols-7 gap-0.5 bg-white p-2 border border-slate-200 rounded-lg" style={{ width: 280 }}>
                    {TELEGRAM_ALLOWED_EMOJI.map((emoji) => (
                      <button
                        key={emoji}
                        onClick={() => handleEmojiSelect(emoji)}
                        className="flex h-8 w-8 items-center justify-center rounded hover:bg-slate-100 text-lg"
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                ) : (
                  <EmojiPicker
                    onEmojiClick={(emojiData) => handleEmojiSelect(emojiData.emoji)}
                    theme={Theme.LIGHT}
                    width={350}
                    height={400}
                    searchPlaceHolder="Search emoji..."
                  />
                )}
              </div>
            )}
          </div>
        )}
        {isSelf && (
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-red-50 hover:text-red-500"
            title="Delete"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Delete confirmation */}
      {showDeleteConfirm && (
        <div
          className={cn(
            'mb-1 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs',
            isSelf ? 'flex-row-reverse' : '',
          )}
        >
          <span className="text-red-700">Delete this message?</span>
          <button
            onClick={handleDelete}
            disabled={isDeletePending}
            className="rounded bg-red-600 px-2 py-1 text-white hover:bg-red-700 disabled:opacity-50"
          >
            {isDeletePending ? 'Deleting...' : 'Delete'}
          </button>
          <button
            onClick={() => setShowDeleteConfirm(false)}
            className="rounded bg-white px-2 py-1 text-slate-600 hover:bg-slate-100"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Reply quote */}
      {message.replyToMessage && (
        <div
          className={cn(
            'mb-1 flex items-start gap-2 rounded-lg px-3 py-1.5 text-xs',
            isSelf
              ? 'bg-accent/20 text-accent-hover'
              : 'border-l-2 border-accent bg-accent-bg text-slate-600',
          )}
        >
          <Reply className="mt-0.5 h-3 w-3 flex-shrink-0" />
          <div className="min-w-0">
            <span className="font-semibold">
              {message.replyToMessage.senderName}
            </span>
            <p className="truncate">{message.replyToMessage.text}</p>
          </div>
        </div>
      )}

      <div
        className={cn(
          'relative rounded-2xl px-4 py-2.5 text-sm leading-relaxed',
          isSelf
            ? 'rounded-br-md bg-accent text-white'
            : 'rounded-bl-md bg-white text-slate-800 shadow-sm ring-1 ring-slate-100',
        )}
      >
        {/* Sender name for incoming */}
        {!isSelf && (
          <p className="mb-0.5 text-xs font-semibold text-accent">
            {message.senderName}
          </p>
        )}

        {/* Pinned indicator */}
        {message.isPinned && (
          <div
            className={cn(
              'mb-1 flex items-center gap-1 text-[10px]',
              isSelf ? 'text-white/70' : 'text-slate-400',
            )}
          >
            <Pin className="h-2.5 w-2.5" />
            Pinned
          </div>
        )}

        {/* Text or inline edit */}
        {isEditing ? (
          <div className="space-y-2">
            <textarea
              ref={editRef}
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={handleEditKeyDown}
              rows={2}
              className="w-full resize-none rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-800 outline-none focus:border-accent"
            />
            <div className="flex gap-1.5">
              <button
                onClick={handleEditSave}
                disabled={isEditPending}
                className="rounded bg-accent px-2.5 py-1 text-xs text-white hover:bg-accent-hover disabled:opacity-50"
              >
                {isEditPending ? 'Saving...' : 'Save'}
              </button>
              <button
                onClick={handleEditCancel}
                className="rounded bg-slate-100 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-200"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <MessageText
            text={message.text}
            messenger={messenger}
            className="whitespace-pre-wrap break-words"
          />
        )}

        {/* Attachments */}
        {message.attachments && message.attachments.length > 0 && (
          <MessageAttachments
            attachments={message.attachments}
            variant={isSelf ? 'self' : 'other'}
          />
        )}

        {/* Footer: time + edited + delivery */}
        <div
          className={cn(
            'mt-1 flex items-center gap-1.5 text-[10px]',
            isSelf ? 'justify-end text-white/60' : 'text-slate-400',
          )}
        >
          {message.editedAt && (
            <span className="flex items-center gap-0.5">
              <Pencil className="h-2.5 w-2.5" />
              edited
            </span>
          )}
          <span>{formatMessageTime(message.createdAt)}</span>
          {isSelf && <DeliveryIcon status={message.deliveryStatus} />}
          {isSelf && message.deliveryStatus === 'failed' && (
            <button
              onClick={handleRetry}
              disabled={isRetrySending}
              className="ml-0.5 flex items-center gap-0.5 rounded text-[10px] text-red-300 underline-offset-2 hover:text-red-100 disabled:opacity-50"
              title="Retry sending"
            >
              ↺ Retry
            </button>
          )}
        </div>

      </div>

      {/* Emoji reactions — outside bubble */}
      <ReactionsBubble
        reactions={reactionGroups}
        onAddReaction={addReaction}
        onRemoveReaction={removeReaction}
        isLoading={isAddingReaction || isRemovingReaction}
        showPicker={false}
      />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-[#f8fafc]">
      <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-xl bg-accent-bg">
        <MessageSquare className="h-7 w-7 text-accent" />
      </div>
      <h2 className="text-lg font-semibold text-slate-800">
        Select a chat to start messaging
      </h2>
      <p className="mt-1 text-sm text-slate-500">
        Choose a conversation from the list on the left
      </p>
    </div>
  );
}

function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded bg-yellow-200 px-0.5">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

function ChatHeader({
  chat,
  searchOpen,
  onToggleSearch,
}: {
  chat: Chat;
  searchOpen: boolean;
  onToggleSearch: () => void;
}) {
  const toggleInfoPanel = useChatStore((s) => s.toggleInfoPanel);
  const ChatTypeIcon = getChatTypeIcon(chat.chatType);
  const loadFullHistory = useLoadFullHistory();
  const canLoadHistory =
    !chat.hasFullHistory &&
    chat.syncStatus !== 'syncing' &&
    chat.messenger !== 'gmail'; // Gmail auto-imports full threads

  return (
    <div className="hidden h-[60px] flex-shrink-0 items-center justify-between border-b border-slate-200 bg-white px-5 md:flex">
      <div className="flex items-center gap-3">
        {/* Avatar */}
        <ChatAvatar name={chat.name} messenger={chat.messenger} size={36} />

        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-slate-800">
              {chat.name}
            </h3>
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium',
                getMessengerBgClass(chat.messenger),
              )}
            >
              {getMessengerLabel(chat.messenger)}
            </span>
            <ChatTypeIcon className="h-3.5 w-3.5 text-slate-400" />
          </div>
          {chat.ownerName && (
            <p className="text-xs text-slate-500">
              Assigned to {chat.ownerName}
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1">
        {canLoadHistory && (
          <button
            onClick={() => loadFullHistory.mutate(chat.id)}
            disabled={loadFullHistory.isPending}
            className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:opacity-60"
            title="Load full message history"
          >
            <History className="h-4 w-4" />
            <span className="hidden lg:inline">
              {loadFullHistory.isPending ? 'Loading…' : 'Full history'}
            </span>
          </button>
        )}
        {chat.syncStatus === 'syncing' && (
          <span className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-slate-500">
            <div className="h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
            <span className="hidden lg:inline">Loading history…</span>
          </span>
        )}
        <button
          className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
          title="Pin"
        >
          <Pin className="h-4 w-4" />
        </button>
        <button
          onClick={onToggleSearch}
          className={cn(
            'flex h-8 w-8 items-center justify-center rounded-lg transition-colors',
            searchOpen
              ? 'bg-accent-bg text-accent'
              : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600',
          )}
          title="Search messages"
        >
          <Search className="h-4 w-4" />
        </button>
        <button
          onClick={toggleInfoPanel}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
          title="Toggle info panel"
        >
          <PanelRightOpen className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function SearchBar({
  chatId,
  onClose,
}: {
  chatId: string;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const { data: searchResults, isLoading } = useSearchMessages(chatId, query);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="relative flex-shrink-0 border-b border-slate-200 bg-white px-5 py-2">
      <div className="flex items-center gap-2">
        <Search className="h-4 w-4 flex-shrink-0 text-slate-400" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search messages..."
          className="flex-1 bg-transparent text-sm text-slate-700 placeholder-slate-400 outline-none"
        />
        {isLoading && (
          // Small skeleton block while the search query is running.
          <Skeleton className="h-4 w-16" />
        )}
        <button
          onClick={onClose}
          className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Search results dropdown */}
      {query.length >= 2 && searchResults?.messages && (
        <div className="absolute left-0 right-0 top-full z-20 max-h-64 overflow-y-auto border-b border-slate-200 bg-white shadow-lg">
          {searchResults.messages.length === 0 ? (
            <div className="px-5 py-4 text-center text-sm text-slate-400">
              No messages found
            </div>
          ) : (
            searchResults.messages.map((msg) => (
              <div
                key={msg.id}
                className="cursor-pointer border-b border-slate-100 px-5 py-3 transition-colors last:border-0 hover:bg-slate-50"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-accent">
                    {msg.senderName}
                  </span>
                  <span className="text-[10px] text-slate-400">
                    {formatMessageTime(msg.createdAt)}
                  </span>
                </div>
                <p className="mt-0.5 line-clamp-2 text-sm text-slate-700">
                  {highlightMatch(msg.text, query)}
                </p>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function ComposeBar({ chatId, messenger }: { chatId: string; messenger?: string }) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile();
  const [showComposerEmoji, setShowComposerEmoji] = useState(false);
  const composerEmojiRef = useRef<HTMLDivElement>(null);
  const composerEmojiBtnRef = useRef<HTMLButtonElement>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [templateSearch, setTemplateSearch] = useState('');
  const templatesRef = useRef<HTMLDivElement>(null);
  const templatesBtnRef = useRef<HTMLButtonElement>(null);
  const { data: templatesData } = useTemplates(showTemplates ? (templateSearch || undefined) : undefined);
  const { mutate: trackTemplateUse } = useTemplateUse();
  const replyingTo = useChatStore((s) => s.replyingTo);
  const setReplyingTo = useChatStore((s) => s.setReplyingTo);
  const { mutate: sendMessage, isPending } = useSendMessage();
  const { sendTyping } = useSocket();

  // Check if user has a connected integration for this messenger.
  // The actual `hasIntegration` early return lives at the bottom of the
  // function, so that all hooks below are still called regardless — otherwise
  // toggling between chats with/without an integration violates the Rules of
  // Hooks and crashes with "Rendered fewer hooks than expected".
  const { data: integrationsData } = useIntegrations();
  const hasIntegration = useMemo(() => {
    if (!messenger || !integrationsData?.integrations) return true;
    return integrationsData.integrations.some(
      (i) => i.messenger === messenger && i.status === 'connected',
    );
  }, [messenger, integrationsData]);

  // Notify server when user is typing
  useEffect(() => {
    if (text.trim()) {
      sendTyping(chatId);
    }
  }, [text, chatId, sendTyping]);

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !isPending && !isUploading;

  const handleSubmit = useCallback(
    (e?: FormEvent) => {
      e?.preventDefault();
      if (!canSend) return;

      sendMessage(
        {
          chatId,
          text: text.trim(),
          replyToId: replyingTo?.id,
          attachments: attachments.length > 0 ? attachments : undefined,
        },
        {
          onSuccess: () => {
            setText('');
            setAttachments([]);
            setReplyingTo(null);
            textareaRef.current?.focus();
          },
        },
      );
    },
    [text, attachments, chatId, replyingTo, canSend, isPending, sendMessage, setReplyingTo],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length === 0) return;
      e.target.value = '';

      setIsUploading(true);
      try {
        for (const file of files) {
          const result = await api.upload<{ file: MessageAttachment }>('/api/uploads', file);
          setAttachments((prev) => [...prev, result.file]);
        }
      } catch {
        toast.error('Failed to upload file');
      } finally {
        setIsUploading(false);
      }
    },
    [],
  );

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
    }
  }, [text]);

  // Close emoji picker on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        showComposerEmoji &&
        composerEmojiRef.current &&
        !composerEmojiRef.current.contains(e.target as Node) &&
        composerEmojiBtnRef.current &&
        !composerEmojiBtnRef.current.contains(e.target as Node)
      ) {
        setShowComposerEmoji(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showComposerEmoji]);

  // Insert emoji at cursor position
  const handleComposerEmojiSelect = useCallback((emojiData: EmojiClickData) => {
    const emoji = emojiData.emoji;
    const textarea = textareaRef.current;
    if (textarea) {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const newText = text.slice(0, start) + emoji + text.slice(end);
      setText(newText);
      requestAnimationFrame(() => {
        textarea.selectionStart = textarea.selectionEnd = start + emoji.length;
        textarea.focus();
      });
    } else {
      setText((prev) => prev + emoji);
    }
    setShowComposerEmoji(false);
  }, [text]);

  // Close templates dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        showTemplates &&
        templatesRef.current &&
        !templatesRef.current.contains(e.target as Node) &&
        templatesBtnRef.current &&
        !templatesBtnRef.current.contains(e.target as Node)
      ) {
        setShowTemplates(false);
        setTemplateSearch('');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showTemplates]);

  // Insert template text into composer
  const handleTemplateSelect = useCallback((template: { id: string; messageText: string }) => {
    setText(template.messageText);
    trackTemplateUse(template.id);
    setShowTemplates(false);
    setTemplateSearch('');
    textareaRef.current?.focus();
  }, [trackTemplateUse]);

  // ── No integration connected → show CTA instead of composer ──
  // Placed AFTER all hooks above to satisfy the Rules of Hooks.
  if (!hasIntegration) {
    const messengerLabel = messenger ? messenger.charAt(0).toUpperCase() + messenger.slice(1) : 'this messenger';
    return (
      <div className="border-t border-slate-200 bg-slate-50 px-5 py-4 text-center">
        <p className="text-sm text-slate-500">
          Connect {messengerLabel} in{' '}
          <a href="/settings" className="font-medium text-accent hover:text-accent-hover">Settings</a>
          {' '}to send messages
        </p>
      </div>
    );
  }

  return (
    <div className="flex-shrink-0 border-t border-slate-200 bg-white px-5 pb-4 pt-3">
      {/* Reply preview */}
      {replyingTo && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border-l-2 border-accent bg-accent-bg px-3 py-2">
          <Reply className="h-4 w-4 flex-shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-accent">
              {replyingTo.senderName}
            </p>
            <p className="truncate text-xs text-slate-600">
              {replyingTo.text}
            </p>
          </div>
          <button
            onClick={() => setReplyingTo(null)}
            className="flex-shrink-0 text-slate-400 hover:text-slate-600"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Attachment previews */}
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {attachments.map((att, i) => (
            <div
              key={i}
              className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-700"
            >
              <Paperclip className="h-3 w-3 flex-shrink-0 text-slate-400" />
              <span className="max-w-[140px] truncate">{att.filename}</span>
              <span className="text-slate-400">
                {att.size < 1024 * 1024
                  ? `${(att.size / 1024).toFixed(0)}KB`
                  : `${(att.size / 1024 / 1024).toFixed(1)}MB`}
              </span>
              <button
                type="button"
                onClick={() => removeAttachment(i)}
                className="ml-0.5 text-slate-400 hover:text-red-500"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex items-end gap-2">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileChange}
          accept="image/*,application/pdf,text/plain,text/csv,.doc,.docx,.xls,.xlsx,.zip,.mp4,.mp3"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={isUploading}
          className={cn(
            'mb-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg transition-colors',
            isUploading
              ? 'text-accent animate-pulse'
              : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600',
          )}
          title="Attach file"
        >
          <Paperclip className="h-5 w-5" />
        </button>

        {/* Emoji picker button */}
        <div className="relative">
          <button
            ref={composerEmojiBtnRef}
            type="button"
            onClick={() => setShowComposerEmoji(!showComposerEmoji)}
            className="mb-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
            title="Insert emoji"
          >
            <Smile className="h-5 w-5" />
          </button>
          {showComposerEmoji && (
            isMobile ? (
              <>
                <div className="fixed inset-0 z-40 bg-black/20" onClick={() => setShowComposerEmoji(false)} />
                <div
                  ref={composerEmojiRef}
                  className="fixed inset-x-0 bottom-0 z-50 max-h-[50vh] overflow-y-auto rounded-t-2xl bg-white p-4 shadow-lg"
                >
                  <EmojiPicker
                    onEmojiClick={handleComposerEmojiSelect}
                    theme={Theme.LIGHT}
                    width="100%"
                    height={360}
                    searchPlaceHolder="Search emoji..."
                  />
                </div>
              </>
            ) : (
              <div
                ref={composerEmojiRef}
                className="absolute bottom-full left-0 mb-2 z-50 shadow-lg rounded-lg overflow-hidden"
              >
                <EmojiPicker
                  onEmojiClick={handleComposerEmojiSelect}
                  theme={Theme.LIGHT}
                  width={350}
                  height={400}
                  searchPlaceHolder="Search emoji..."
                />
              </div>
            )
          )}
        </div>

        {/* Templates button */}
        <div className="relative">
          <button
            ref={templatesBtnRef}
            type="button"
            onClick={() => setShowTemplates(!showTemplates)}
            className="mb-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
            title="Insert template"
          >
            <FileText className="h-5 w-5" />
          </button>
          {showTemplates && (
            <div
              ref={templatesRef}
              className="absolute bottom-full left-0 mb-2 z-50 w-72 rounded-lg border border-slate-200 bg-white shadow-lg"
            >
              <div className="border-b border-slate-100 p-2">
                <input
                  type="text"
                  value={templateSearch}
                  onChange={(e) => setTemplateSearch(e.target.value)}
                  placeholder="Search templates..."
                  className="w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm outline-none focus:border-accent focus:bg-white"
                  autoFocus
                />
              </div>
              <div className="max-h-60 overflow-y-auto p-1">
                {templatesData?.templates?.length ? (
                  templatesData.templates.map((tpl) => (
                    <button
                      key={tpl.id}
                      type="button"
                      onClick={() => handleTemplateSelect(tpl)}
                      className="flex w-full flex-col gap-0.5 rounded-md px-3 py-2 text-left transition-colors hover:bg-slate-50"
                    >
                      <span className="text-sm font-medium text-slate-700">{tpl.name}</span>
                      <span className="line-clamp-2 text-xs text-slate-400">{tpl.messageText}</span>
                    </button>
                  ))
                ) : (
                  <div className="px-3 py-4 text-center text-sm text-slate-400">
                    {templateSearch ? 'Nothing found' : 'No templates yet'}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={attachments.length > 0 ? 'Add a caption...' : 'Type a message...'}
          rows={1}
          className="min-h-[36px] min-w-0 flex-1 resize-none rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-700 placeholder-slate-400 outline-none transition-shadow focus:border-accent focus:bg-white focus:shadow-focus-ring"
        />

        <button
          type="submit"
          disabled={!canSend}
          className={cn(
            'mb-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg transition-all',
            canSend
              ? 'bg-accent text-white shadow-accent-sm hover:bg-accent-hover'
              : 'bg-slate-100 text-slate-300',
          )}
        >
          <Send className="h-4 w-4" />
        </button>
      </form>
    </div>
  );
}

// Single chat-bubble placeholder used while messages are loading. Mimics
// the MessageBubble layout (avatar + rounded bubble body) so the feed
// keeps its visual rhythm instead of jumping when real data arrives.
function MessageBubbleSkeleton({
  side,
  width,
}: {
  side: 'left' | 'right';
  width: string;
}) {
  const isRight = side === 'right';
  return (
    <div
      className={cn(
        'flex items-end gap-2',
        isRight ? 'flex-row-reverse' : 'flex-row',
      )}
    >
      {!isRight && <Skeleton className="h-8 w-8 flex-shrink-0 rounded-full" />}
      <Skeleton className={cn('h-10 rounded-2xl', width)} />
    </div>
  );
}

function MessageFeed({ chatId, messenger }: { chatId: string; messenger?: string }) {
  const feedRef = useRef<HTMLDivElement>(null);
  const setReplyingTo = useChatStore((s) => s.setReplyingTo);
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useMessages(chatId);

  const messages = useMemo(() => {
    if (!data?.pages) return [];
    // API returns desc (newest first), reverse to chronological order (oldest first)
    return data.pages.flatMap((p) => p.messages).reverse();
  }, [data]);

  // Group messages by date
  const groupedMessages = useMemo(() => {
    const groups: Array<{ date: string; messages: Message[] }> = [];
    let currentDate = '';

    for (const msg of messages) {
      const msgDate = new Date(msg.createdAt).toDateString();
      if (msgDate !== currentDate) {
        currentDate = msgDate;
        groups.push({ date: msg.createdAt, messages: [msg] });
      } else {
        groups[groups.length - 1].messages.push(msg);
      }
    }
    return groups;
  }, [messages]);

  // Scroll to bottom on new messages (only if already near bottom)
  const prevLengthRef = useRef(0);

  useEffect(() => {
    if (feedRef.current && messages.length > prevLengthRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = feedRef.current;
      const wasNearBottom = scrollHeight - scrollTop - clientHeight < 150;
      if (wasNearBottom || prevLengthRef.current === 0) {
        feedRef.current.scrollTop = feedRef.current.scrollHeight;
      }
    }
    prevLengthRef.current = messages.length;
  }, [messages.length]);

  // Scroll up to load more
  const handleScroll = useCallback(() => {
    if (!feedRef.current || !hasNextPage || isFetchingNextPage) return;
    if (feedRef.current.scrollTop < 100) {
      fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  if (isLoading) {
    // Content-shaped placeholder: a header strip plus alternating
    // left/right bubble skeletons of varying widths so the area doesn't
    // collapse into a spinner while messages are loading.
    return (
      <div
        className="flex flex-1 flex-col bg-[#f8fafc]"
        aria-busy="true"
        aria-live="polite"
      >
        {/* Header strip skeleton */}
        <div className="flex h-[60px] flex-shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-5">
          <Skeleton className="h-9 w-9 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3 w-24" />
          </div>
        </div>

        {/* Message bubble skeletons — alternating sides, varying widths */}
        <div className="flex-1 space-y-3 overflow-hidden px-5 py-4">
          <MessageBubbleSkeleton side="left" width="w-56" />
          <MessageBubbleSkeleton side="right" width="w-40" />
          <MessageBubbleSkeleton side="left" width="w-72" />
          <MessageBubbleSkeleton side="right" width="w-52" />
          <MessageBubbleSkeleton side="left" width="w-32" />
          <MessageBubbleSkeleton side="right" width="w-64" />
        </div>
      </div>
    );
  }

  // ── Gmail-specific rendering: accordion email thread ──
  // Skips bubble-style grouping, date separators and MessageBubble entirely.
  if (messenger === 'gmail') {
    return <EmailThread messages={messages} isLoading={isLoading} />;
  }

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center bg-[#f8fafc]">
        <UIEmptyState
          icon={<MessageSquare className="h-12 w-12" />}
          title="No messages yet"
          description="Send the first message in this chat"
        />
      </div>
    );
  }

  return (
    <div
      ref={feedRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto bg-[#f8fafc] px-5 py-4"
    >
      {isFetchingNextPage && (
        // Skeleton bubble at the top while older messages are fetched in.
        <div className="py-2">
          <MessageBubbleSkeleton side="left" width="w-48" />
        </div>
      )}

      {groupedMessages.map((group) => (
        <div key={group.date}>
          {/* Date separator */}
          <div className="my-4 flex items-center gap-3">
            <div className="h-px flex-1 bg-slate-200" />
            <span className="rounded-full bg-white px-3 py-1 text-[11px] font-medium text-slate-500 shadow-xs">
              {formatDateSeparator(group.date)}
            </span>
            <div className="h-px flex-1 bg-slate-200" />
          </div>

          {/* Messages */}
          <div className="space-y-3">
            {group.messages.map((msg) => (
              <MessageBubble
                key={msg.id}
                message={msg}
                messenger={messenger}
                onReply={setReplyingTo}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function ChatArea() {
  const activeChat = useChatStore((s) => s.activeChat);
  const isMobile = useIsMobile();
  const setMobileView = useChatStore((s) => s.setMobileView);
  const [searchOpen, setSearchOpen] = useState(false);
  const [typingUsers, setTypingUsers] = useState<Array<{ userId: string; userName: string; timestamp: number }>>([]);
  const queryClient = useQueryClient();
  const { joinChat, leaveChat, markRead } = useSocket();

  // Join/leave WebSocket room when active chat changes & mark as read
  useEffect(() => {
    if (!activeChat?.id) return;
    joinChat(activeChat.id);
    // Mark chat as read when opening it
    markRead(activeChat.id, '');
    // Optimistically clear unread badge instantly (before server roundtrip)
    queryClient.setQueriesData<{ chats: Array<{ id: string; preferences?: { unread?: boolean } }>; total: number }>(
      { queryKey: ['chats'] },
      (old) => {
        if (!old?.chats) return old;
        return {
          ...old,
          chats: old.chats.map((c) =>
            c.id === activeChat.id
              ? { ...c, preferences: { ...c.preferences, unread: false } }
              : c
          ),
        };
      },
    );
    return () => leaveChat(activeChat.id);
  }, [activeChat?.id, joinChat, leaveChat, markRead, queryClient]);

  // Listen for typing events for the active chat
  useEffect(() => {
    const s = getSocket();
    if (!s || !activeChat?.id) return;

    const handler = (data: { chatId: string; userId: string; userName: string }) => {
      if (data.chatId !== activeChat.id) return;
      setTypingUsers((prev) => {
        const filtered = prev.filter((u) => u.userId !== data.userId);
        return [...filtered, { userId: data.userId, userName: data.userName, timestamp: Date.now() }];
      });
    };

    s.on('typing', handler);
    return () => { s.off('typing', handler); };
  }, [activeChat?.id]);

  // Auto-expire typing indicators after 3 seconds
  useEffect(() => {
    if (typingUsers.length === 0) return;
    const timer = setInterval(() => {
      setTypingUsers((prev) => prev.filter((u) => Date.now() - u.timestamp < 3000));
    }, 1000);
    return () => clearInterval(timer);
  }, [typingUsers.length]);

  // Clear typing users when switching chats
  useEffect(() => {
    setTypingUsers([]);
  }, [activeChat?.id]);

  // Close search when switching chats
  useEffect(() => {
    setSearchOpen(false);
  }, [activeChat?.id]);

  // Mark chat as read when it is opened
  useEffect(() => {
    if (!activeChat?.id) return;
    api.patch(`/api/chats/${activeChat.id}/read`).then(() => {
      queryClient.invalidateQueries({ queryKey: ['chats'] });
    }).catch(() => {
      // fire-and-forget — silently ignore errors
    });
  }, [activeChat?.id, queryClient]);

  // Re-mark active chat as read when new messages arrive while viewing
  useEffect(() => {
    const s = getSocket();
    if (!s || !activeChat?.id) return;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const handler = (data: { chatId: string }) => {
      if (data.chatId !== activeChat.id) return;
      if (debounceTimer) return; // already scheduled
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        markRead(activeChat.id, '');
        api.patch(`/api/chats/${activeChat.id}/read`).catch(() => {});
      }, 500);
    };

    s.on('new_message', handler);
    return () => {
      s.off('new_message', handler);
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [activeChat?.id, markRead]);

  if (!activeChat) {
    return <EmptyState />;
  }

  return (
    <div className="flex flex-1 flex-col">
      {/* Mobile header */}
      {isMobile && activeChat && (
        <div className="flex h-12 flex-shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-3 md:hidden">
          <button
            onClick={() => setMobileView('list')}
            className="flex h-9 w-9 items-center justify-center rounded-full text-slate-600 hover:bg-slate-100"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-slate-900">{activeChat.name}</p>
          </div>
          <button
            onClick={() => setMobileView('info')}
            className="flex h-9 w-9 items-center justify-center rounded-full text-slate-600 hover:bg-slate-100"
          >
            <Info className="h-5 w-5" />
          </button>
        </div>
      )}
      <ChatHeader
        chat={activeChat}
        searchOpen={searchOpen}
        onToggleSearch={() => setSearchOpen((v) => !v)}
      />
      {searchOpen && (
        <SearchBar
          chatId={activeChat.id}
          onClose={() => setSearchOpen(false)}
        />
      )}
      <MessageFeed chatId={activeChat.id} messenger={activeChat.messenger} />
      <TypingIndicator typingUsers={typingUsers} />
      <ComposeBar chatId={activeChat.id} messenger={activeChat.messenger} />
    </div>
  );
}
