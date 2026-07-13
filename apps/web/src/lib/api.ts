import { useSuperadminStore } from '@/stores/superadmin';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

const ORG_PARAM_EXCLUDE = ['/api/auth/', '/api/organizations'];

function injectOrgId(endpoint: string): string {
  if (typeof window === 'undefined') return endpoint;
  const orgId = useSuperadminStore.getState().selectedOrgId;
  if (!orgId) return endpoint;
  // Only superadmins should inject org context — defense in depth
  try {
    const userStr = localStorage.getItem('user');
    if (!userStr) return endpoint;
    const user = JSON.parse(userStr);
    if (user.role !== 'superadmin') return endpoint;
  } catch { return endpoint; }
  if (ORG_PARAM_EXCLUDE.some((prefix) => endpoint.startsWith(prefix))) return endpoint;
  // An explicit organizationId in the call wins over the sidebar selection —
  // admin pages inspect orgs other than the selected one.
  if (endpoint.includes('organizationId=')) return endpoint;
  const separator = endpoint.includes('?') ? '&' : '?';
  return `${endpoint}${separator}organizationId=${encodeURIComponent(orgId)}`;
}

type RequestOptions = Omit<RequestInit, 'body'> & {
  body?: unknown;
};

// Callback registered by the auth store so api.ts can notify it when a silent
// token refresh succeeds.  This avoids a circular import (api ↔ auth).
let onTokenRefreshed: ((token: string) => void) | null = null;

export function registerTokenRefreshCallback(cb: (token: string) => void) {
  onTokenRefreshed = cb;
}

class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function getAccessToken(): Promise<string | null> {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('accessToken');
}

function setAccessToken(token: string) {
  localStorage.setItem('accessToken', token);
  scheduleProactiveRefresh(token);
}

function clearTokens() {
  localStorage.removeItem('accessToken');
}

// Singleton promise lock — prevents multiple concurrent refresh calls
let refreshPromise: Promise<string | null> | null = null;

// ─── Proactive token refresh ───
// Schedules a refresh 2 minutes before the JWT access token expires, so the
// user never hits a 401 during normal usage. Also refreshes when the browser
// tab becomes visible after being hidden (covers laptop-lid-close scenarios).
let proactiveRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleProactiveRefresh(token: string) {
  if (proactiveRefreshTimer) clearTimeout(proactiveRefreshTimer);
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    const expiresAt = payload.exp * 1000;
    const refreshAt = expiresAt - 2 * 60 * 1000; // 2 min before expiry
    const delay = refreshAt - Date.now();
    if (delay > 0) {
      proactiveRefreshTimer = setTimeout(() => {
        refreshAccessToken();
      }, delay);
    }
  } catch {
    // Ignore JWT parse errors — reactive refresh will still work
  }
}

// Refresh on tab visibility change (covers returning after sleep/idle)
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const token = localStorage.getItem('accessToken');
    if (!token) return;
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      const expiresAt = payload.exp * 1000;
      // If token expires within 3 minutes, refresh now
      if (expiresAt - Date.now() < 3 * 60 * 1000) {
        refreshAccessToken();
      }
    } catch {
      // Ignore — reactive refresh handles it
    }
  });
}

async function refreshAccessToken(): Promise<string | null> {
  try {
    const response = await fetch(`${BASE_URL}/api/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    if (!response.ok) return null;

    const data = await response.json();
    if (data.accessToken) {
      setAccessToken(data.accessToken);
      onTokenRefreshed?.(data.accessToken);
      return data.accessToken;
    }
    return null;
  } catch {
    return null;
  }
}

async function request<T>(
  endpoint: string,
  options: RequestOptions = {},
): Promise<T> {
  const { body, headers: customHeaders, ...rest } = options;

  const token = await getAccessToken();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...customHeaders as Record<string, string>,
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const config: RequestInit = {
    ...rest,
    headers,
    credentials: 'include',
  };

  if (body !== undefined) {
    config.body = JSON.stringify(body);
  } else if (rest.method === 'POST' || rest.method === 'PATCH') {
    // Send empty object to avoid Fastify "Unexpected end of JSON input" on empty body
    config.body = '{}';
  }

  const finalEndpoint = injectOrgId(endpoint);

  let response = await fetch(`${BASE_URL}${finalEndpoint}`, config);

  if (response.status === 401 && token) {
    if (!refreshPromise) {
      refreshPromise = refreshAccessToken().finally(() => { refreshPromise = null; });
    }
    const newToken = await refreshPromise;
    if (newToken) {
      headers['Authorization'] = `Bearer ${newToken}`;
      config.headers = headers;
      response = await fetch(`${BASE_URL}${finalEndpoint}`, config);
      // If retried request still returns 401, session is broken — force logout
      if (response.status === 401) {
        clearTokens();
        if (typeof window !== 'undefined') {
          window.location.href = '/login';
        }
        throw new ApiError(401, 'AUTH_TOKEN_EXPIRED', 'Session expired');
      }
    } else {
      clearTokens();
      if (typeof window !== 'undefined') {
        window.location.href = '/login';
      }
      throw new ApiError(401, 'AUTH_TOKEN_EXPIRED', 'Session expired');
    }
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({
      error: { code: 'UNKNOWN', message: 'An unexpected error occurred' },
    }));
    throw new ApiError(
      response.status,
      errorData.error?.code || 'UNKNOWN',
      errorData.error?.message || 'An unexpected error occurred',
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

export const api = {
  get: <T>(endpoint: string, options?: RequestOptions) =>
    request<T>(endpoint, { ...options, method: 'GET' }),

  post: <T>(endpoint: string, body?: unknown, options?: RequestOptions) =>
    request<T>(endpoint, { ...options, method: 'POST', body }),

  put: <T>(endpoint: string, body?: unknown, options?: RequestOptions) =>
    request<T>(endpoint, { ...options, method: 'PUT', body }),

  patch: <T>(endpoint: string, body?: unknown, options?: RequestOptions) =>
    request<T>(endpoint, { ...options, method: 'PATCH', body }),

  delete: <T>(endpoint: string, options?: RequestOptions) =>
    request<T>(endpoint, { ...options, method: 'DELETE' }),

  /**
   * GET an endpoint that answers with binary data rather than JSON.
   *
   * Used by the Teams remote-login screen, which polls JPEG frames and reads the
   * agent's login verdict out of a response header.
   */
  getBinary: async (endpoint: string): Promise<{ blob: Blob; headers: Headers }> => {
    const token = await getAccessToken();
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const response = await fetch(`${BASE_URL}${injectOrgId(endpoint)}`, {
      method: 'GET',
      headers,
      credentials: 'include',
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const err = (body as { error?: { code?: string; message?: string } }).error ?? {};
      throw new ApiError(response.status, err.code ?? 'REQUEST_FAILED', err.message ?? `Request failed (${response.status})`);
    }

    return { blob: await response.blob(), headers: response.headers };
  },

  upload: async <T>(endpoint: string, file: File): Promise<T> => {
    const token = await getAccessToken();
    const formData = new FormData();
    formData.append('file', file);
    const uploadEndpoint = injectOrgId(endpoint);

    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    let response = await fetch(`${BASE_URL}${uploadEndpoint}`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: formData,
    });

    // Retry on 401 with refreshed token
    if (response.status === 401 && token) {
      if (!refreshPromise) {
        refreshPromise = refreshAccessToken().finally(() => { refreshPromise = null; });
      }
      const newToken = await refreshPromise;
      if (newToken) {
        const retryFormData = new FormData();
        retryFormData.append('file', file);
        response = await fetch(`${BASE_URL}${uploadEndpoint}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${newToken}` },
          credentials: 'include',
          body: retryFormData,
        });
      } else {
        clearTokens();
        if (typeof window !== 'undefined') window.location.href = '/login';
        throw new ApiError(401, 'AUTH_TOKEN_EXPIRED', 'Session expired');
      }
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({
        error: { code: 'UNKNOWN', message: 'Upload failed' },
      }));
      throw new ApiError(
        response.status,
        errorData.error?.code || 'UNKNOWN',
        errorData.error?.message || 'Upload failed',
      );
    }
    return response.json();
  },
};

export { ApiError, getAccessToken, setAccessToken, clearTokens };
