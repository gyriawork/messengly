// ─── Microsoft Teams Adapter ───
// Talks to the teams-agent sidecar (services/teams-agent), which drives the
// Teams web UI with Playwright.
//
// There is exactly one Teams session for the whole system, owned by the sidecar
// — the same shape as WhatsApp on WAHA Core's single `default` session. The
// per-organization Integration row records that the session is connected; it does
// not hold the session itself.
//
// Reading messages is deliberately not implemented. meetsbroadcast, the source of
// this port, never read Teams messages either. Omitting `getMessages` is safe:
// the worker checks for it and marks such chats `synced` rather than failing.

import type { MessengerAdapter } from './base.js';
import { MessengerError } from './base.js';
import { teamsAgent, TeamsAgentError } from '../lib/teams-client.js';

/** Broadcast attachments may carry app-relative URLs; the agent needs absolute ones. */
function absoluteUrl(url: string): string {
  if (url.startsWith('http')) return url;
  const base = process.env.API_URL || process.env.APP_URL || 'http://localhost:3000';
  return `${base}${url}`;
}

/** Teams exposes only `direct | group | channel` shaped names; anything else is direct. */
function toChatType(type: string): string {
  return type === 'group' || type === 'channel' ? type : 'direct';
}

export class TeamsAdapter implements MessengerAdapter {
  private status: 'connected' | 'disconnected' | 'session_expired' = 'disconnected';

  /**
   * The sidecar owns the browser, so "connecting" means asserting that its Teams
   * session is alive. A half-booted or signed-out session reports `expired`.
   */
  async connect(): Promise<void> {
    try {
      const info = await teamsAgent.getSessionStatus();
      if (info.status !== 'active') {
        this.status = 'session_expired';
        throw new MessengerError(
          'teams',
          null,
          info.status === 'expired'
            ? 'Teams session expired — log in again from Settings → Integrations'
            : 'Teams is not connected yet — log in from Settings → Integrations',
        );
      }
      this.status = 'connected';
    } catch (err) {
      this.status = err instanceof TeamsAgentError && err.isSessionExpired ? 'session_expired' : 'disconnected';
      if (err instanceof MessengerError) throw err;
      throw new MessengerError('teams', err, `Teams agent is unreachable: ${(err as Error).message}`);
    }
  }

  /** No-op: the sidecar keeps one long-lived browser across requests. */
  async disconnect(): Promise<void> {
    this.status = 'disconnected';
  }

  async listChats(): Promise<Array<{ externalChatId: string; name: string; chatType: string }>> {
    try {
      const chats = await teamsAgent.listChats();
      return chats.map((c) => ({
        externalChatId: c.threadId,
        name: c.name,
        chatType: toChatType(c.type),
      }));
    } catch (err) {
      throw this.wrap(err);
    }
  }

  /**
   * Send one message.
   *
   * The agent reports three outcomes and they must not be collapsed:
   *   - delivered
   *   - never left the compose box  → safe to retry
   *   - possibly delivered, unconfirmed → retrying would duplicate it in a real chat
   *
   * The last case is surfaced by prefixing the error with `unverified:`, which lands
   * in `BroadcastChat.errorReason` and tells the UI to withhold Retry.
   */
  async sendMessage(
    externalChatId: string,
    text: string,
    options?: {
      replyToExternalId?: string;
      attachments?: Array<{ url: string; filename: string; mimeType: string; size: number }>;
    },
  ): Promise<{ externalMessageId: string }> {
    let result;
    try {
      result = await teamsAgent.sendMessage({
        threadId: externalChatId,
        text,
        attachments: (options?.attachments ?? []).map((a) => ({
          url: absoluteUrl(a.url),
          filename: a.filename,
          mimeType: a.mimeType,
        })),
      });
    } catch (err) {
      throw this.wrap(err);
    }

    if (result.ok) return { externalMessageId: result.messageId };

    const prefix = result.retriable ? '' : 'unverified: ';
    throw new MessengerError('teams', null, `${prefix}${result.reason}`);
  }

  /** Teams' web UI offers no reliable automation for editing a sent message. */
  async editMessage(): Promise<void> {
    throw new MessengerError('teams', null, 'Editing messages is not supported for Teams');
  }

  async deleteMessage(): Promise<void> {
    throw new MessengerError('teams', null, 'Deleting messages is not supported for Teams');
  }

  getStatus(): 'connected' | 'disconnected' | 'token_expired' | 'session_expired' {
    return this.status;
  }

  /** Turn a transport-level agent error into the error type the routes understand. */
  private wrap(err: unknown): MessengerError {
    if (err instanceof TeamsAgentError) {
      if (err.isSessionExpired) this.status = 'session_expired';
      return new MessengerError('teams', err, err.message);
    }
    return new MessengerError('teams', err, (err as Error)?.message ?? 'Teams adapter error');
  }
}
