// ─── Teams Agent HTTP Client ───
// Typed HTTP client for the teams-agent sidecar (services/teams-agent).
// Uses native fetch — no external dependencies required.
//
// The agent drives the Teams web UI with Playwright. There is no Microsoft Graph
// API involved: personal Microsoft accounts offer no Graph path for sending as
// the user, so a real browser session is the only route.
//
// Shape mirrors lib/waha-client.ts, which fronts the equivalent sidecar for
// WhatsApp. Kept duplicated between apps/api and apps/worker on purpose — the
// same convention as waha-client.ts and crypto.ts, to avoid workspace-dependency
// problems in Railway builds.

// ─── Configuration ───

const TEAMS_AGENT_URL = process.env.TEAMS_AGENT_URL ?? 'http://localhost:3004';
const TEAMS_AGENT_API_KEY = process.env.TEAMS_AGENT_API_KEY ?? '';

// ─── Types: Session ───

export type TeamsSessionStatus = 'active' | 'expired' | 'unknown';

export interface TeamsSessionInfo {
  status: TeamsSessionStatus;
  lastCheckAt: string | null;
}

export interface TeamsRemoteStartResult {
  started: boolean;
  viewport: { width: number; height: number };
}

export interface TeamsScreenshot {
  /** Raw JPEG bytes. */
  image: Buffer;
  /** The agent auto-saves the session the moment login is confirmed. */
  loggedIn: boolean;
}

// ─── Types: Chats ───

export interface TeamsChat {
  /** Stable Teams conversation id. Becomes Chat.externalChatId. */
  threadId: string;
  name: string;
  /** direct | group | channel, or null when the agent couldn't determine it. */
  type: 'direct' | 'group' | 'channel' | null;
}

// ─── Types: Messaging ───

export interface TeamsAttachment {
  url: string;
  filename: string;
  mimeType: string;
}

export interface TeamsSendBody {
  threadId: string;
  text: string;
  html?: string;
  attachments?: TeamsAttachment[];
  requestId?: string;
}

/**
 * Three outcomes, and the middle one is the dangerous one.
 *
 * `ok: false, retriable: false` means the message may well have been delivered —
 * the compose box emptied but the agent could not re-match the bubble. Retrying
 * would put a second copy in a real chat.
 */
export type TeamsSendResult =
  | { ok: true; messageId: string }
  | { ok: false; reason: string; retriable: boolean };

// ─── Errors ───

export class TeamsAgentError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TeamsAgentError';
  }

  /** The Teams session died; the operator must log in again. */
  get isSessionExpired(): boolean {
    return this.code === 'SESSION_EXPIRED';
  }
}

// ─── Client ───

export class TeamsAgentClient {
  constructor(
    private baseUrl: string = TEAMS_AGENT_URL,
    private apiKey: string = TEAMS_AGENT_API_KEY,
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.apiKey ? { 'X-Api-Key': this.apiKey, ...extra } : { ...extra };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new TeamsAgentError(0, 'AGENT_UNREACHABLE', `Teams agent unreachable at ${this.baseUrl}: ${String(err)}`);
    }

    if (res.status === 204) return undefined as T;

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { error: { code: 'BAD_RESPONSE', message: text.slice(0, 200) } };
    }

    if (!res.ok) {
      const e = (parsed as { error?: { code?: string; message?: string } }).error ?? {};
      throw new TeamsAgentError(res.status, e.code ?? 'AGENT_ERROR', e.message ?? `Teams agent returned ${res.status}`);
    }

    return parsed as T;
  }

  // ─── Session ───

  getSessionStatus(): Promise<TeamsSessionInfo> {
    return this.request<TeamsSessionInfo>('GET', '/session/status');
  }

  /** Forces a real navigation rather than reading the cached verdict. */
  checkSession(): Promise<TeamsSessionInfo> {
    return this.request<TeamsSessionInfo>('POST', '/session/check');
  }

  destroySession(): Promise<{ destroyed: boolean }> {
    return this.request<{ destroyed: boolean }>('POST', '/session/destroy');
  }

  // ─── Remote browser login ───

  remoteStart(): Promise<TeamsRemoteStartResult> {
    return this.request<TeamsRemoteStartResult>('POST', '/session/remote/start');
  }

  /** Returns raw JPEG bytes plus the agent's login verdict from a response header. */
  async remoteScreenshot(): Promise<TeamsScreenshot> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/session/remote/screenshot`, { headers: this.headers() });
    } catch (err) {
      throw new TeamsAgentError(0, 'AGENT_UNREACHABLE', `Teams agent unreachable: ${String(err)}`);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const e = (body as { error?: { code?: string; message?: string } }).error ?? {};
      throw new TeamsAgentError(res.status, e.code ?? 'AGENT_ERROR', e.message ?? `Screenshot failed (${res.status})`);
    }
    return {
      image: Buffer.from(await res.arrayBuffer()),
      loggedIn: res.headers.get('X-Logged-In') === 'true',
    };
  }

  remoteClick(x: number, y: number): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>('POST', '/session/remote/click', { x, y });
  }

  remoteType(text: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>('POST', '/session/remote/type', { text });
  }

  remoteKey(key: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>('POST', '/session/remote/key', { key });
  }

  remoteSave(): Promise<{ saved: boolean; url: string }> {
    return this.request<{ saved: boolean; url: string }>('POST', '/session/remote/save');
  }

  remoteStop(): Promise<{ stopped: boolean }> {
    return this.request<{ stopped: boolean }>('POST', '/session/remote/stop');
  }

  // ─── Chats & messages ───

  async listChats(): Promise<TeamsChat[]> {
    const { chats } = await this.request<{ chats: TeamsChat[] }>('GET', '/chats');
    return chats;
  }

  sendMessage(body: TeamsSendBody): Promise<TeamsSendResult> {
    return this.request<TeamsSendResult>('POST', '/messages', body);
  }
}

export const teamsAgent = new TeamsAgentClient();
