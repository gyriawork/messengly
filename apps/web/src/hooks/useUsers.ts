'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface TeamUserPermissions {
  canCreateTags: boolean;
  canSelfConnectMessengers: boolean;
  canViewAllChats: boolean;
}

export interface TeamUser {
  id: string;
  email: string;
  name: string;
  role: 'superadmin' | 'admin' | 'user';
  status: 'active' | 'deactivated';
  avatar: string | null;
  organizationId: string | null;
  permissions: TeamUserPermissions;
  lastActiveAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Same query key WorkspaceTab's member table uses — both surfaces read/invalidate GET /api/users together. */
const TEAM_USERS_KEY = ['workspace-users'];

export function useTeamUsers() {
  return useQuery<TeamUser[]>({
    queryKey: TEAM_USERS_KEY,
    queryFn: () => api.get('/api/users'),
  });
}

export interface UpdateTeamUserInput {
  id: string;
  name?: string;
  email?: string;
  status?: 'active' | 'deactivated';
  password?: string;
  canCreateTags?: boolean;
  canSelfConnectMessengers?: boolean;
  canViewAllChats?: boolean;
}

export function useUpdateTeamUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: UpdateTeamUserInput) =>
      api.patch<TeamUser>(`/api/users/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TEAM_USERS_KEY });
    },
  });
}
