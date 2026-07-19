'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Integration, ConnectPayload, MessengerType } from '@/types/integration';

interface IntegrationsResponse {
  integrations: Integration[];
}

export function useIntegrations() {
  return useQuery({
    queryKey: ['integrations'],
    queryFn: () => api.get<IntegrationsResponse>('/api/integrations'),
  });
}

export function useConnectIntegration() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      messenger,
      payload,
      forUserId,
    }: {
      messenger: MessengerType;
      payload: ConnectPayload;
      /** Admin+ connecting on behalf of another org member (Team card). */
      forUserId?: string;
    }) => {
      const result = await api.post<Integration>(
        `/api/integrations/${messenger}/connect`,
        forUserId ? { ...payload, forUserId } : payload,
      );
      await queryClient.invalidateQueries({ queryKey: ['integrations'] });
      return result;
    },
  });
}

export function useDisconnectIntegration() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (messenger: MessengerType) => {
      return api.post<void>(`/api/integrations/${messenger}/disconnect`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['integrations'] });
    },
  });
}

/**
 * Disconnect a specific integration by id, regardless of owner (Task 5: admin
 * manages a user's connections from their Team card). A plain `user` may only
 * target their own row — the API enforces this; useDisconnectIntegration()
 * above (by messenger, always self) is what a self-connecting user should use.
 */
export function useDisconnectIntegrationById() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (integrationId: string) => {
      return api.delete<{ integration: Integration }>(`/api/integrations/by-id/${integrationId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['integrations'] });
    },
  });
}

export function useReconnectIntegration() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (messenger: MessengerType) => {
      const result = await api.post<Integration>(
        `/api/integrations/${messenger}/reconnect`, {},
      );
      // Trigger a resync after successful reconnect so chats are re-imported
      await api.post(`/api/integrations/${messenger}/resync`, {}).catch(() => {
        // Resync is best-effort — don't fail the reconnect if it errors
      });
      await queryClient.invalidateQueries({ queryKey: ['integrations'] });
      await queryClient.invalidateQueries({ queryKey: ['chats'] });
      return result;
    },
  });
}

export function useSlackOAuthStatus() {
  return useQuery({
    queryKey: ['slack-oauth-status'],
    queryFn: () => api.get<{ oauthConfigured: boolean }>('/api/oauth/slack/status'),
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
  });
}

export function useGmailOAuthAvailable() {
  return useQuery({
    queryKey: ['gmail-oauth-available'],
    queryFn: () => api.get<{ available: boolean }>('/api/oauth/gmail/available'),
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
  });
}

/** Whether "Sign in with Google" should show on the login page. */
export function useGoogleLoginStatus() {
  return useQuery({
    queryKey: ['google-login-status'],
    queryFn: () => api.get<{ available: boolean }>('/api/auth/google/status'),
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
  });
}

export function useUpdateIntegrationSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ messenger, settings }: { messenger: string; settings: Record<string, unknown> }) =>
      api.patch(`/api/integrations/${messenger}/settings`, { settings }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['integrations'] }),
  });
}

// ─── Telegram multi-step auth hooks ───

interface TelegramSendCodeResponse {
  phoneCodeHash: string;
  phoneNumber: string;
}

interface TelegramVerifyCodeResponse {
  integration: Integration;
}

interface TelegramCheckSessionResponse {
  valid: boolean;
  reason?: string;
}

export function useTelegramSendCode() {
  return useMutation({
    mutationFn: async (payload: { phoneNumber: string }) => {
      return api.post<TelegramSendCodeResponse>(
        '/api/integrations/telegram/send-code',
        {
          phoneNumber: payload.phoneNumber,
        },
      );
    },
  });
}

export function useTelegramVerifyCode() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: {
      phoneNumber: string;
      phoneCodeHash: string;
      code: string;
      password?: string;
      /** Admin+ connecting on behalf of another org member (Team card). */
      forUserId?: string;
    }) => {
      const result = await api.post<TelegramVerifyCodeResponse>(
        '/api/integrations/telegram/verify-code',
        payload,
      );
      await queryClient.invalidateQueries({ queryKey: ['integrations'] });
      return result;
    },
  });
}

export function useTelegramConnectSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: { session: string; phoneNumber?: string; forUserId?: string }) => {
      const result = await api.post<TelegramVerifyCodeResponse>(
        '/api/integrations/telegram/connect-session',
        payload,
      );
      await queryClient.invalidateQueries({ queryKey: ['integrations'] });
      return result;
    },
  });
}

export interface TelegramQrStatus {
  status: 'idle' | 'pending' | 'connected' | 'error';
  qr?: string;
  needs2FA?: boolean;
  error?: string;
}

export function useTelegramQrStart() {
  return useMutation({
    mutationFn: async (forUserId?: string) =>
      api.post<{ status: string }>('/api/integrations/telegram/qr/start', forUserId ? { forUserId } : {}),
  });
}

export function useTelegramQrStatus(enabled: boolean) {
  return useQuery<TelegramQrStatus>({
    queryKey: ['telegram-qr-status'],
    queryFn: () => api.get<TelegramQrStatus>('/api/integrations/telegram/qr/status'),
    enabled,
    refetchInterval: enabled ? 2000 : false,
    gcTime: 0,
  });
}

export function useTelegramQr2fa() {
  return useMutation({
    mutationFn: async (password: string) =>
      api.post('/api/integrations/telegram/qr/2fa', { password }),
  });
}

export function useTelegramCheckSession() {
  return useMutation({
    mutationFn: async () => {
      return api.post<TelegramCheckSessionResponse>(
        '/api/integrations/telegram/check-session',
      );
    },
  });
}
