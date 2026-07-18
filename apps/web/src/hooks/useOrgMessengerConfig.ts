'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Messenger } from '@messengly/shared';

export interface OrgMessengerConfigEntry {
  messenger: Messenger;
  configured: boolean;
  source: 'organization' | 'database' | 'env' | 'none_required' | null;
  enabled: boolean;
  hint?: string;
}

export function useOrgMessengerConfig() {
  return useQuery({
    queryKey: ['org-messenger-config'],
    queryFn: () => api.get<OrgMessengerConfigEntry[]>('/api/organizations/messenger-config'),
  });
}

export function useUpdateOrgMessengerConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      messenger,
      credentials,
    }: {
      messenger: Messenger;
      credentials: Record<string, string | number>;
    }) => {
      return api.put<OrgMessengerConfigEntry>(
        `/api/organizations/messenger-config/${messenger}`,
        credentials,
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org-messenger-config'] });
      queryClient.invalidateQueries({ queryKey: ['integrations', 'available'] });
    },
  });
}

export function useDeleteOrgMessengerConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (messenger: Messenger) => {
      return api.delete<{ messenger: string; configured: boolean; source: string | null }>(
        `/api/organizations/messenger-config/${messenger}`,
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org-messenger-config'] });
      queryClient.invalidateQueries({ queryKey: ['integrations', 'available'] });
    },
  });
}
