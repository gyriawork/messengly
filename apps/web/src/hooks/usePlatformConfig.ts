'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Messenger } from '@messengly/shared';

export interface PlatformConfigEntry {
  messenger: Messenger;
  configured: boolean;
  source: 'database' | 'env' | 'none_required' | null;
  enabled: boolean;
  hint?: string;
}

export function usePlatformConfig() {
  return useQuery({
    queryKey: ['platform-config'],
    queryFn: () => api.get<PlatformConfigEntry[]>('/api/admin/platform-config'),
  });
}

export function useUpdatePlatformConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      messenger,
      credentials,
    }: {
      messenger: Messenger;
      credentials: Record<string, string | number>;
    }) => {
      return api.put<PlatformConfigEntry>(
        `/api/admin/platform-config/${messenger}`,
        credentials,
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['platform-config'] });
      queryClient.invalidateQueries({ queryKey: ['integrations', 'available'] });
    },
  });
}

export function useDeletePlatformConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      messenger,
      confirm,
    }: {
      messenger: Messenger;
      confirm?: boolean;
    }) => {
      const qs = confirm ? '?confirm=true' : '';
      return api.delete<{ messenger: string; configured: boolean; fallback: string | null }>(
        `/api/admin/platform-config/${messenger}${qs}`,
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['platform-config'] });
      queryClient.invalidateQueries({ queryKey: ['integrations', 'available'] });
    },
  });
}
