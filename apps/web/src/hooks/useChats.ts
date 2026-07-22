'use client';

import { useEffect, useMemo } from 'react';
import {
  useQuery,
  useMutation,
  useInfiniteQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { api } from '@/lib/api';
import type {
  Chat,
  Message,
  ChatFilters,
} from '@/types/chat';

interface ChatsResponse {
  chats: Chat[];
  total: number;
  /** Org-wide reachability counts, independent of the filter bar. */
  statusCounts?: Record<string, number>;
}

interface MessagesResponse {
  messages: Message[];
  nextCursor?: string;
}

export function useChats(filters?: ChatFilters) {
  return useQuery({
    queryKey: ['chats', filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters?.search) params.set('search', filters.search);
      if (filters?.searchScope) params.set('searchScope', filters.searchScope);
      if (filters?.messenger) params.set('messenger', filters.messenger);
      if (filters?.status) params.set('status', filters.status);
      if (filters?.owner) params.set('owner', filters.owner);
      if (filters?.ownerId) params.set('ownerId', filters.ownerId);
      if (filters?.tagId) params.set('tagId', filters.tagId);
      if (filters?.limit) params.set('limit', String(filters.limit));
      const query = params.toString();
      return api.get<ChatsResponse>(
        `/api/chats${query ? `?${query}` : ''}`,
      );
    },
  });
}

const ALL_CHATS_PAGE_SIZE = 500;

/**
 * Loads the WHOLE chat list, page by page, instead of one capped request.
 * The old `limit: 1000` fetch silently truncated orgs with more chats; this
 * keeps loading pages in the background until `total` is reached, so
 * client-side sorting, filtering and select-all always see every chat.
 */
export function useAllChats(filters?: Omit<ChatFilters, 'limit'>) {
  const query = useInfiniteQuery({
    queryKey: ['chats', 'all', filters],
    queryFn: async ({ pageParam }: { pageParam: number }) => {
      const params = new URLSearchParams();
      if (filters?.search) params.set('search', filters.search);
      if (filters?.searchScope) params.set('searchScope', filters.searchScope);
      if (filters?.messenger) params.set('messenger', filters.messenger);
      if (filters?.status) params.set('status', filters.status);
      if (filters?.owner) params.set('owner', filters.owner);
      if (filters?.ownerId) params.set('ownerId', filters.ownerId);
      if (filters?.tagId) params.set('tagId', filters.tagId);
      params.set('page', String(pageParam));
      params.set('limit', String(ALL_CHATS_PAGE_SIZE));
      return api.get<ChatsResponse>(`/api/chats?${params.toString()}`);
    },
    initialPageParam: 1,
    getNextPageParam: (lastPage, pages) => {
      const loaded = pages.reduce((n, p) => n + p.chats.length, 0);
      return loaded < lastPage.total && lastPage.chats.length > 0 ? pages.length + 1 : undefined;
    },
  });

  // Drain remaining pages automatically — the caller just sees the list grow.
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const chats = useMemo(
    () => (query.data?.pages ?? []).flatMap((p) => p.chats),
    [query.data],
  );
  const firstPage = query.data?.pages[0];

  return {
    chats,
    total: firstPage?.total ?? 0,
    statusCounts: firstPage?.statusCounts ?? {},
    isLoading: query.isLoading,
    /** True while later pages are still streaming in. */
    isLoadingMore: Boolean(hasNextPage || isFetchingNextPage),
  };
}

export function useChat(id: string | undefined) {
  return useQuery({
    queryKey: ['chat', id],
    queryFn: () => api.get<Chat>(`/api/chats/${id}`),
    enabled: !!id,
  });
}

export function useMessages(chatId: string | undefined) {
  return useInfiniteQuery({
    queryKey: ['messages', chatId],
    queryFn: async ({ pageParam }: { pageParam?: string }) => {
      const params = new URLSearchParams();
      if (pageParam) params.set('cursor', pageParam);
      params.set('limit', '50');
      const query = params.toString();
      return api.get<MessagesResponse>(
        `/api/chats/${chatId}/messages${query ? `?${query}` : ''}`,
      );
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: !!chatId,
  });
}

export interface MessageAttachment {
  url: string;
  filename: string;
  mimeType: string;
  size: number;
}

export function useSendMessage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      chatId,
      text,
      replyToId,
      attachments,
    }: {
      chatId: string;
      text: string;
      replyToId?: string;
      attachments?: MessageAttachment[];
    }) => {
      return api.post<Message>(`/api/chats/${chatId}/messages`, {
        text,
        replyToMessageId: replyToId,
        attachments,
      });
    },
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: ['messages', variables.chatId] });

      const previousMessages = queryClient.getQueryData(['messages', variables.chatId]);

      queryClient.setQueryData(
        ['messages', variables.chatId],
        (old: { pages: Array<{ messages: Message[]; nextCursor?: string }>; pageParams: unknown[] } | undefined) => {
          if (!old?.pages) return old;
          const optimisticMessage: Message = {
            id: `optimistic-${Date.now()}`,
            chatId: variables.chatId,
            senderName: 'You',
            isSelf: true,
            text: variables.text,
            isPinned: false,
            deliveryStatus: 'sending',
            createdAt: new Date().toISOString(),
            replyToMessage: undefined,
            attachments: [],
          };
          const firstPage = old.pages[0];
          return {
            ...old,
            pages: [
              { ...firstPage, messages: [optimisticMessage, ...firstPage.messages] },
              ...old.pages.slice(1),
            ],
          };
        },
      );

      return { previousMessages };
    },
    onError: (_err, variables, context) => {
      if (context?.previousMessages) {
        queryClient.setQueryData(['messages', variables.chatId], context.previousMessages);
      }
    },
    onSuccess: (realMessage, variables) => {
      // Replace the optimistic message with the real one from the server
      queryClient.setQueryData(
        ['messages', variables.chatId],
        (old: { pages: Array<{ messages: Message[]; nextCursor?: string }>; pageParams: unknown[] } | undefined) => {
          if (!old?.pages) return old;
          return {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              messages: page.messages.map((m) =>
                m.id.startsWith('optimistic-') && m.isSelf ? realMessage : m,
              ),
            })),
          };
        },
      );
    },
    onSettled: (_data, _error, variables) => {
      // Only refresh chat list (last message preview, unread count etc.)
      // Do NOT invalidate messages — onSuccess already replaced the optimistic entry
      queryClient.invalidateQueries({ queryKey: ['chats'] });
    },
  });
}

export function useLoadFullHistory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (chatId: string) =>
      api.post<{ queued: boolean; reason?: string }>(
        `/api/chats/${chatId}/load-full-history`,
        {},
      ),
    onSuccess: (_data, chatId) => {
      queryClient.invalidateQueries({ queryKey: ['chat', chatId] });
      queryClient.invalidateQueries({ queryKey: ['chats'] });
    },
  });
}

export function useEditMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, text }: { messageId: string; text: string }) =>
      api.patch(`/api/messages/${messageId}`, { text }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['messages'] });
    },
  });
}

export function useDeleteMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (messageId: string) => api.delete(`/api/messages/${messageId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['messages'] });
    },
  });
}

export function usePinMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      messageId,
      isPinned,
    }: {
      messageId: string;
      isPinned: boolean;
    }) => api.patch(`/api/messages/${messageId}/pin`, { isPinned }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['messages'] });
    },
  });
}

export function useSearchMessages(chatId: string | undefined, query: string) {
  return useQuery({
    queryKey: ['messages-search', chatId, query],
    queryFn: () =>
      api.get<{ messages: Message[] }>(
        `/api/chats/${chatId}/messages/search?q=${encodeURIComponent(query)}&limit=20`,
      ),
    enabled: !!chatId && query.length >= 2,
  });
}

export function useDeleteChat() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (chatId: string) => api.delete(`/api/chats/${chatId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['chats'] });
    },
  });
}

export function useUpdateChat() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      chatId,
      ...data
    }: {
      chatId: string;
      ownerId?: string;
      status?: string;
      tags?: string[];
    }) => api.patch(`/api/chats/${chatId}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['chats'] });
      queryClient.invalidateQueries({ queryKey: ['chat'] });
    },
  });
}

export interface RefreshStatusesResult {
  results: Record<string, { checked: number; activated: number; deactivated: number }>;
  errors: Record<string, string>;
}

/** Re-check every imported chat against its messenger and flip active/inactive. */
export function useRefreshChatStatuses() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<RefreshStatusesResult>('/api/chats/refresh-statuses', {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['chats'] });
    },
  });
}

export function useTags() {
  return useQuery({
    queryKey: ['tags'],
    queryFn: () => api.get<{ tags: Array<{ id: string; name: string; color: string }> }>('/api/tags'),
  });
}

export function useChatPreferences() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      chatId,
      preferences,
    }: {
      chatId: string;
      preferences: {
        pinned?: boolean;
        favorite?: boolean;
        muted?: boolean;
      };
    }) => {
      return api.patch<void>(
        `/api/chats/${chatId}/preferences`,
        preferences,
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['chats'] });
    },
  });
}

export function useBulkAssignChats() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { chatIds: string[]; ownerName: string }) => api.post('/api/chats/bulk/assign', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['chats'] }),
  });
}

export function useBulkTagChats() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { chatIds: string[]; tagId: string; action: 'add' | 'remove' }) => api.post('/api/chats/bulk/tag', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['chats'] }),
  });
}

export function useBulkDeleteChats() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (chatIds: string[]) => api.delete('/api/chats/bulk', { body: { chatIds } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['chats'] }),
  });
}

/**
 * "Remove from my list" — unlinks the caller from the selected chats (deletes
 * their ChatOwner links) WITHOUT deleting the shared chat for others. The chats
 * disappear from the caller's view and become re-importable from their account.
 */
export function useBulkUnlinkChats() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (chatIds: string[]) =>
      api.post<{ unlinked: number }>('/api/chats/bulk/unlink', { chatIds }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['chats'] });
      qc.invalidateQueries({ queryKey: ['pending-imports'] });
    },
  });
}
