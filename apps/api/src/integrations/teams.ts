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

/**
 * Consecutive failures before we stop trying. Mirrors meetsbroadcast's circuit
 * breaker: once the browser is in a bad way, every further send is a slow,
 * doomed navigation, and a long broadcast would grind through hundreds of them.
 */
const CIRCUIT_BREAKER_THRESHOLD = 5;

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
   * One adapter instance serves one messenger batch, so this state spans the whole
   * run of Teams chats in a broadcast — which is exactly what a circuit breaker
   * and a halt flag need.
   */
  private consecutiveFailures = 0;
  private halted = false;

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
   * Send one message, classifying every failure the way meetsbroadcast's
   * orchestrator does — because the wrong classification is expensive here:
   *
   *   session expired   → halt. Every further send would drive a doomed browser
   *                       navigation, so a 200-chat broadcast becomes 200 slow
   *                       failures against a dead session.
   *   chat not found    → skip. The chat is gone; that is not a delivery failure.
   *   attachment failed → no retry. Re-running the same UI fails identically.
   *   unverified        → no retry. The message may already be in the chat; a
   *                       retry would put a second copy there.
   *   anything else     → retry.
   *
   * Five consecutive failures trip the circuit breaker and halt the batch.
   */
  async sendMessage(
    externalChatId: string,
    text: string,
    options?: {
      replyToExternalId?: string;
      attachments?: Array<{ url: string; filename: string; mimeType: string; size: number }>;
    },
  ): Promise<{ externalMessageId: string }> {
    if (this.halted) {
      throw new MessengerError('teams', null, 'Teams sending halted for this broadcast', 'halt');
    }

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
      throw this.classifyAgentError(err);
    }

    if (result.ok) {
      this.consecutiveFailures = 0;
      return { externalMessageId: result.messageId };
    }

    if (!result.retriable) {
      // The compose box emptied, so the message probably went out — we just could
      // not re-match the bubble. Not a failure of the browser, so the breaker
      // stays where it is.
      throw new MessengerError('teams', null, `unverified: ${result.reason}`, 'no_retry');
    }

    // The message genuinely never left. Retriable, and it counts as a failure.
    throw this.recordFailure(new MessengerError('teams', null, result.reason, 'retry'));
  }

  /**
   * Turn an agent HTTP error into a policy. Errors that say nothing about the
   * browser's health (a missing chat) do not move the breaker.
   */
  private classifyAgentError(err: unknown): MessengerError {
    if (!(err instanceof TeamsAgentError)) {
      return this.recordFailure(
        new MessengerError('teams', err, (err as Error)?.message ?? 'Teams adapter error', 'retry'),
      );
    }

    switch (err.code) {
      case 'SESSION_EXPIRED':
        this.status = 'session_expired';
        this.halted = true;
        return new MessengerError(
          'teams',
          err,
          'Teams session expired — log in again from Settings → Integrations',
          'halt',
        );

      case 'CHAT_NOT_FOUND':
        this.consecutiveFailures = 0; // the browser is fine; this chat is not
        return new MessengerError('teams', err, err.message, 'skip');

      case 'ATTACHMENT_UNSUPPORTED':
      case 'ATTACHMENT_DOWNLOAD_FAILED':
        return this.recordFailure(new MessengerError('teams', err, `attachment: ${err.message}`, 'no_retry'));

      default:
        return this.recordFailure(new MessengerError('teams', err, err.message, 'retry'));
    }
  }

  /**
   * Count a failure against the circuit breaker, upgrading the policy to `halt`
   * once the browser has failed five times in a row.
   */
  private recordFailure(error: MessengerError): MessengerError {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures < CIRCUIT_BREAKER_THRESHOLD) return error;

    this.halted = true;
    return new MessengerError(
      'teams',
      error.originalError,
      `${CIRCUIT_BREAKER_THRESHOLD} consecutive Teams failures — halting. Last error: ${error.message}`,
      'halt',
    );
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
