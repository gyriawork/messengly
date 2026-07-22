'use client';

import { useEffect, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { toast } from 'sonner';
import { useAuthStore } from '@/stores/auth';
import { useQueryClient } from '@tanstack/react-query';
import type { Message } from '@/types/chat';


const SOCKET_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

let socket: Socket | null = null;

export function getSocket(): Socket | null {
  return socket;
}

export function useSocket() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const queryClient = useQueryClient();
  const queryClientRef = useRef(queryClient);
  const connectedRef = useRef(false);
  const everConnectedRef = useRef(false);
  const chatUpdateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep queryClient ref up to date without triggering socket reconnection
  queryClientRef.current = queryClient;

  useEffect(() => {
    if (!isAuthenticated || !accessToken) {
      if (socket) {
        socket.disconnect();
        socket = null;
        connectedRef.current = false;
      }
      return;
    }

    // Disconnect existing socket if token changed
    if (socket) {
      socket.disconnect();
      socket = null;
      connectedRef.current = false;
    }

    socket = io(SOCKET_URL, {
      path: '/socket.io',
      auth: { token: accessToken },
      transports: ['websocket', 'polling'],
      reconnection: true,
      // Never give up: after a laptop sleep or an API deploy the socket must
      // come back on its own, or live updates silently die until a reload.
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
    });

    socket.on('connect', () => {
      const isReconnect = everConnectedRef.current;
      connectedRef.current = true;
      everConnectedRef.current = true;
      console.log('[WS] Connected');
      // On a RECONNECT, catch up on anything that reached a terminal state while
      // we were offline — e.g. a broadcast that finished mid-disconnect, whose
      // one-shot status event we missed (m25). Refetching surfaces the real
      // current status even though the missed toast itself can't be replayed.
      if (isReconnect) {
        queryClientRef.current.invalidateQueries({ queryKey: ['broadcasts'] });
        queryClientRef.current.invalidateQueries({ queryKey: ['broadcast'] });
        queryClientRef.current.invalidateQueries({ queryKey: ['integrations'] });
      }
    });

    socket.on('disconnect', (reason) => {
      connectedRef.current = false;
      console.log('[WS] Disconnected:', reason);
    });

    let refreshingAuth = false;
    socket.on('connect_error', (err) => {
      console.error('[WS] Connection error:', err.message);
      // A 15-minute access token outlives idle tabs. Refresh it once per
      // failure wave; the store update re-runs this effect and reconnects
      // with the fresh token.
      if (!refreshingAuth && /auth|token|unauthorized|jwt/i.test(err.message)) {
        refreshingAuth = true;
        useAuthStore
          .getState()
          .refreshToken()
          .finally(() => {
            refreshingAuth = false;
          });
      }
    });

    // Real-time message received → optimistically insert into cache
    socket.on('new_message', (data: { chatId: string; message: Message }) => {
      if (data.message) {
        queryClientRef.current.setQueryData(
          ['messages', data.chatId],
          (oldData: { pages: Array<{ messages: Message[]; nextCursor?: string }>; pageParams: unknown[] } | undefined) => {
            if (!oldData?.pages) return oldData;
            const firstPage = oldData.pages[0];
            if (!firstPage) return oldData;

            // Check for exact duplicate by ID
            const allMessages = oldData.pages.flatMap((p) => p.messages);
            if (allMessages.some((m) => m.id === data.message.id)) return oldData;

            // If this is our own message, it may already exist as an optimistic entry —
            // replace it instead of inserting a duplicate
            if (data.message.isSelf) {
              const hasOptimistic = allMessages.some((m) => m.id.startsWith('optimistic-') && m.isSelf);
              if (hasOptimistic) {
                return {
                  ...oldData,
                  pages: oldData.pages.map((page) => ({
                    ...page,
                    messages: page.messages.map((m) =>
                      m.id.startsWith('optimistic-') && m.isSelf ? data.message : m,
                    ),
                  })),
                };
              }
            }

            return {
              ...oldData,
              pages: [
                { ...firstPage, messages: [data.message, ...firstPage.messages] },
                ...oldData.pages.slice(1),
              ],
            };
          },
        );
      }
      // Debounce chat list refresh — message is already optimistically inserted above
      if (chatUpdateTimer.current) clearTimeout(chatUpdateTimer.current);
      chatUpdateTimer.current = setTimeout(() => {
        queryClientRef.current.invalidateQueries({ queryKey: ['chats'] });
      }, 500);
    });

    // Message updated
    socket.on('message_updated', (data: { chatId: string }) => {
      queryClientRef.current.invalidateQueries({ queryKey: ['messages', data.chatId] });
    });

    // Message deleted
    socket.on('message_deleted', (data: { chatId: string }) => {
      queryClientRef.current.invalidateQueries({ queryKey: ['messages', data.chatId] });
    });

    // Chat updated (new message count, last activity, etc.) — debounced
    socket.on('chat_updated', () => {
      if (chatUpdateTimer.current) clearTimeout(chatUpdateTimer.current);
      chatUpdateTimer.current = setTimeout(() => {
        queryClientRef.current.invalidateQueries({ queryKey: ['chats'] });
      }, 2000);
    });

    // Broadcast status update. Terminal transitions also raise a global
    // toast, so a finished/failed send is announced anywhere in the app —
    // previously you only found out by keeping the broadcast page open.
    socket.on(
      'broadcast_status',
      (data: {
        broadcastId: string;
        status: string;
        stats?: { total?: number; sent?: number; failed?: number; skipped?: number };
      }) => {
        queryClientRef.current.invalidateQueries({ queryKey: ['broadcasts'] });
        queryClientRef.current.invalidateQueries({ queryKey: ['broadcast', data.broadcastId] });

        const goToDetails = {
          label: 'View',
          onClick: () => {
            window.location.href = `/broadcast/${data.broadcastId}`;
          },
        };
        const summary = data.stats
          ? ` — ${data.stats.sent ?? 0} sent${(data.stats.failed ?? 0) > 0 ? `, ${data.stats.failed} failed` : ''}`
          : '';

        if (data.status === 'sent') {
          toast.success(`Broadcast finished${summary}`, { action: goToDetails });
        } else if (data.status === 'partially_failed') {
          toast.warning(`Broadcast partially failed${summary}`, { action: goToDetails });
        } else if (data.status === 'failed') {
          toast.error(`Broadcast failed${summary}`, { action: goToDetails });
        } else if (data.status === 'canceled') {
          toast.info(`Broadcast canceled${summary}`, { action: goToDetails });
        }
      },
    );

    // Import progress — used by ConnectAndImportWizard
    // (listened at component level via getSocket(), these are just for cache invalidation)
    socket.on('import_chat_complete', () => {
      queryClientRef.current.invalidateQueries({ queryKey: ['chats'] });
      queryClientRef.current.invalidateQueries({ queryKey: ['integrations'] });
    });

    // Integration connected/disconnected — update status badge instantly
    socket.on('integration_status_changed', () => {
      queryClientRef.current.invalidateQueries({ queryKey: ['integrations'] });
    });

    // Reactions — refresh messages to show new/removed reactions
    socket.on('reaction_added', (data: { chatId: string }) => {
      queryClientRef.current.invalidateQueries({ queryKey: ['messages', data.chatId] });
    });
    socket.on('reaction_removed', (data: { chatId: string }) => {
      queryClientRef.current.invalidateQueries({ queryKey: ['messages', data.chatId] });
    });
    socket.on('new_reaction', (data: { messageId: string }) => {
      // Inbound reaction from messenger webhook — find the chat and refresh
      queryClientRef.current.invalidateQueries({ queryKey: ['messages'] });
    });

    // Typing indicator
    socket.on('typing', (_data: { chatId: string; userId: string; userName: string }) => {
      // Typing state is handled at the component level
    });

    return () => {
      if (chatUpdateTimer.current) clearTimeout(chatUpdateTimer.current);
      if (socket) {
        socket.disconnect();
        socket = null;
        connectedRef.current = false;
      }
    };
  }, [isAuthenticated, accessToken]);

  const joinChat = useCallback((chatId: string) => {
    socket?.emit('join_chat', { chatId });
  }, []);

  const leaveChat = useCallback((chatId: string) => {
    socket?.emit('leave_chat', { chatId });
  }, []);

  const sendTyping = useCallback((chatId: string) => {
    socket?.emit('typing', { chatId });
  }, []);

  const markRead = useCallback((chatId: string, messageId: string) => {
    socket?.emit('mark_read', { chatId, messageId });
  }, []);

  return {
    isConnected: connectedRef.current,
    joinChat,
    leaveChat,
    sendTyping,
    markRead,
  };
}
