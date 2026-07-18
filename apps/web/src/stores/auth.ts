'use client';

import { create } from 'zustand';
import { api, setAccessToken, clearTokens, registerTokenRefreshCallback } from '@/lib/api';
import { useSuperadminStore } from '@/stores/superadmin';
import { queryClient } from '@/lib/query-client';

interface UserPermissions {
  canCreateTags: boolean;
  canSelfConnectMessengers: boolean;
  canViewAllChats: boolean;
}

interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  organizationId: string | null;
  avatar?: string | null;
  /** The user's org name + logo, used to brand the sidebar footer. */
  organization?: { id: string; name: string; logo: string | null } | null;
  /**
   * Informational only — the API enforces these server-side on every
   * request. Absent right after login (the login response doesn't include
   * them); populated moments later once the dashboard layout's fetchMe() call
   * resolves, and whenever an admin's toggle change is next fetched.
   */
  permissions?: UserPermissions;
}

interface AuthState {
  user: User | null;
  accessToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshToken: () => Promise<boolean>;
  hydrate: () => void;
  fetchMe: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  accessToken: null,
  isAuthenticated: false,
  isLoading: true,

  login: async (email: string, password: string) => {
    const data = await api.post<{
      accessToken: string;
      user: User;
    }>('/api/auth/login', { email, password });

    setAccessToken(data.accessToken);
    localStorage.setItem('user', JSON.stringify(data.user));
    // Refresh token is stored in httpOnly cookie by the server

    set({
      user: data.user,
      accessToken: data.accessToken,
      isAuthenticated: true,
    });
  },

  register: async (email: string, password: string, name: string) => {
    const data = await api.post<{
      accessToken: string;
      user: User;
    }>('/api/auth/register', { email, password, name });

    setAccessToken(data.accessToken);
    localStorage.setItem('user', JSON.stringify(data.user));
    // Refresh token is stored in httpOnly cookie by the server

    set({
      user: data.user,
      accessToken: data.accessToken,
      isAuthenticated: true,
    });
  },

  logout: async () => {
    try {
      // Server reads refresh token from httpOnly cookie
      await api.post('/api/auth/logout');
    } catch {
      // Silently ignore errors — logout should always succeed client-side
    }

    clearTokens();
    localStorage.removeItem('user');
    useSuperadminStore.getState().clearOrg();
    queryClient.clear(); // Wipe all cached server data to prevent stale data leaks
    set({
      user: null,
      accessToken: null,
      isAuthenticated: false,
    });
    window.location.href = '/login';
  },

  refreshToken: async () => {
    try {
      // Server reads refresh token from httpOnly cookie
      const data = await api.post<{
        accessToken: string;
        user: User;
      }>('/api/auth/refresh');

      setAccessToken(data.accessToken);
      localStorage.setItem('user', JSON.stringify(data.user));

      set({
        user: data.user,
        accessToken: data.accessToken,
        isAuthenticated: true,
      });
      return true;
    } catch {
      get().logout();
      return false;
    }
  },

  fetchMe: async () => {
    try {
      const user = await api.get<User>('/api/users/me');
      localStorage.setItem('user', JSON.stringify(user));
      set({ user });
    } catch {
      // Silently ignore — stale user data is acceptable as fallback
    }
  },

  hydrate: () => {
    if (typeof window === 'undefined') {
      set({ isLoading: false });
      return;
    }

    const token = localStorage.getItem('accessToken');
    const userStr = localStorage.getItem('user');

    if (token && userStr) {
      try {
        const user = JSON.parse(userStr) as User;
        setAccessToken(token); // re-set to trigger proactive refresh scheduling
        set({
          user,
          accessToken: token,
          isAuthenticated: true,
          isLoading: false,
        });
      } catch {
        clearTokens();
        localStorage.removeItem('user');
        set({ isLoading: false });
      }
    } else {
      set({ isLoading: false });
    }
  },
}));

// Tell api.ts to call us whenever it silently refreshes the access token so
// the Zustand state (and therefore useSocket) always holds a fresh token.
// Uses Zustand's static setState to avoid changing the factory signature.
registerTokenRefreshCallback((token) => {
  useAuthStore.setState({ accessToken: token, isAuthenticated: true });
});
