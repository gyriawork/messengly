'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface Organization {
  id: string;
  name: string;
  status: 'active' | 'suspended';
  globalBroadcastLimits: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  _count?: {
    users: number;
    chats: number;
    broadcasts: number;
  };
}

export interface OrganizationStats {
  userCount: number;
  chatCount: number;
  broadcastCount: number;
  messageCount: number;
  integrationCount: number;
}



interface CreateOrganizationInput {
  name: string;
  adminEmail: string;
  adminName: string;
  adminPassword: string;
}

interface UpdateOrganizationInput {
  name?: string;
  status?: 'active' | 'suspended';
  globalBroadcastLimits?: Record<string, unknown>;
}

export function useOrganizations() {
  return useQuery({
    // GET /api/organizations returns a bare array.
    queryKey: ['organizations'],
    queryFn: () => api.get<Organization[]>('/api/organizations'),
  });
}

export function useOrganizationStats(id: string | undefined) {
  return useQuery({
    queryKey: ['organization-stats', id],
    queryFn: () => api.get<OrganizationStats>(`/api/organizations/${id}/stats`),
    enabled: !!id,
  });
}

export function useCreateOrganization() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateOrganizationInput) =>
      api.post<Organization>('/api/organizations', input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
    },
  });
}

export function useUpdateOrganization() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...input }: UpdateOrganizationInput & { id: string }) =>
      api.patch<Organization>(`/api/organizations/${id}`, input),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      queryClient.invalidateQueries({
        queryKey: ['organization-stats', variables.id],
      });
    },
  });
}
