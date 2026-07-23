'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type {
  Broadcast,
  BroadcastFilters,
  BroadcastAnalytics,
  AntibanSettings,
  RiskScore,
  CreateBroadcastInput,
  UpdateBroadcastInput,
} from '@/types/broadcast';

interface BroadcastsResponse {
  broadcasts: Broadcast[];
  total: number;
}

export function useBroadcasts(filters?: BroadcastFilters) {
  return useQuery({
    queryKey: ['broadcasts', filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters?.status) params.set('status', filters.status);
      if (filters?.search) params.set('search', filters.search);
      const query = params.toString();
      return api.get<BroadcastsResponse>(
        `/api/broadcasts${query ? `?${query}` : ''}`,
      );
    },
  });
}

export function useBroadcast(id: string | undefined) {
  return useQuery({
    queryKey: ['broadcast', id],
    queryFn: () => api.get<Broadcast>(`/api/broadcasts/${id}`),
    enabled: !!id,
    // Live updates come from the lightweight /stats poll (useBroadcastStats);
    // this full object (every recipient row) is only refetched on transitions.
  });
}

export interface BroadcastStats {
  id: string;
  status: Broadcast['status'];
  deliveryRate: number | null;
  sentAt: string | null;
  total: number;
  counts: Record<string, number>;
  /** Live per-messenger totals so the breakdown cards stay in sync with the poll. */
  byMessenger: Array<{ messenger: string; total: number; sent: number; failed: number }>;
  recent: Array<{
    chatId: string;
    chatName: string;
    messenger: string;
    status: string;
    error?: string;
    sentAt: string | null;
    updatedAt: string | null;
  }>;
}

/**
 * Cheap live view of a broadcast: counts + the latest delivery events. Polled
 * while a send is in flight instead of re-fetching every recipient row each
 * tick (which on a 1000-chat send re-shipped the whole list every 4s).
 */
export function useBroadcastStats(id: string | undefined, live: boolean) {
  return useQuery({
    queryKey: ['broadcast-stats', id],
    queryFn: () => api.get<BroadcastStats>(`/api/broadcasts/${id}/stats`),
    enabled: !!id && live,
    refetchInterval: live ? 3000 : false,
  });
}

export function useCreateBroadcast() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateBroadcastInput) =>
      api.post<Broadcast>('/api/broadcasts', input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['broadcasts'] });
    },
  });
}

export function useUpdateBroadcast() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...input }: UpdateBroadcastInput & { id: string }) =>
      api.patch<Broadcast>(`/api/broadcasts/${id}`, input),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['broadcasts'] });
      queryClient.invalidateQueries({
        queryKey: ['broadcast', variables.id],
      });
    },
  });
}

export function useSendBroadcast() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      api.post<Broadcast>(`/api/broadcasts/${id}/send`),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ['broadcasts'] });
      queryClient.invalidateQueries({ queryKey: ['broadcast', id] });
    },
  });
}

export function useRetryBroadcast() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      api.post<Broadcast>(`/api/broadcasts/${id}/retry`),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ['broadcasts'] });
      queryClient.invalidateQueries({ queryKey: ['broadcast', id] });
    },
  });
}

export function useCancelBroadcast() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ success: boolean; status: string }>(`/api/broadcasts/${id}/cancel`),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ['broadcasts'] });
      queryClient.invalidateQueries({ queryKey: ['broadcast', id] });
    },
  });
}

export function useDuplicateBroadcast() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      api.post<Broadcast>(`/api/broadcasts/${id}/duplicate`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['broadcasts'] });
    },
  });
}

export function useDeleteBroadcast() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      api.delete<void>(`/api/broadcasts/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['broadcasts'] });
    },
  });
}

export function useBroadcastAnalytics(period: '7d' | '30d' | '90d') {
  return useQuery({
    queryKey: ['broadcast-analytics', period],
    queryFn: () =>
      api.get<BroadcastAnalytics>(
        `/api/broadcasts/analytics?period=${period}`,
      ),
  });
}

export function useAntibanSettings(options?: { refetchInterval?: number }) {
  return useQuery({
    queryKey: ['antiban-settings'],
    queryFn: async () => {
      // API returns an object keyed by messenger; transform to array
      const data = await api.get<Record<string, AntibanSettings>>('/api/settings/antiban');
      const settings = Object.values(data).filter(
        (v) => v && typeof v === 'object' && 'messenger' in v,
      ) as AntibanSettings[];
      return { settings };
    },
    // The broadcast wizard polls so its duration estimate tracks settings
    // edited elsewhere (another tab, the settings panel) near-live.
    refetchInterval: options?.refetchInterval ?? false,
  });
}

export function useUpdateAntiban() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (settings: AntibanSettings) =>
      api.patch<AntibanSettings>(
        `/api/settings/antiban/${settings.messenger}`,
        settings,
      ),
    // The PATCH is an idempotent upsert — one silent retry rides out a
    // transient network blip or an API container swap during a deploy.
    retry: 1,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['antiban-settings'] });
    },
  });
}

export function useRiskScore(params: Partial<AntibanSettings> | null) {
  const [debouncedParams, setDebouncedParams] = useState(params);

  const debounce = useCallback(() => {
    const timer = setTimeout(() => setDebouncedParams(params), 300);
    return () => clearTimeout(timer);
  }, [params]);

  useEffect(() => {
    return debounce();
  }, [debounce]);

  return useQuery({
    queryKey: ['risk-score', debouncedParams],
    queryFn: () => {
      const p = new URLSearchParams();
      if (debouncedParams?.messenger)
        p.set('messenger', debouncedParams.messenger);
      if (debouncedParams?.messagesPerBatch != null)
        p.set('messagesPerBatch', String(debouncedParams.messagesPerBatch));
      if (debouncedParams?.delayBetweenMessages != null)
        p.set(
          'delayBetweenMessages',
          String(debouncedParams.delayBetweenMessages),
        );
      if (debouncedParams?.delayBetweenBatches != null)
        p.set(
          'delayBetweenBatches',
          String(debouncedParams.delayBetweenBatches),
        );
      if (debouncedParams?.maxMessagesPerHour != null)
        p.set(
          'maxMessagesPerHour',
          String(debouncedParams.maxMessagesPerHour),
        );
      if (debouncedParams?.maxMessagesPerDay != null)
        p.set(
          'maxMessagesPerDay',
          String(debouncedParams.maxMessagesPerDay),
        );
      return api.get<RiskScore>(
        `/api/settings/antiban/risk-score?${p.toString()}`,
      );
    },
    enabled: !!debouncedParams?.messenger,
  });
}
