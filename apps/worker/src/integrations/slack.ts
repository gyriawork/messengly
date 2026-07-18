// ─── Slack Adapter ───
// Uses @slack/web-api WebClient for real Slack API interactions.
// Requires a bot or user OAuth token with appropriate scopes.

import { WebClient } from '@slack/web-api';
import type { MessengerAdapter, GetMessagesResult, HistoryMessage } from './base.js';
import { MessengerError } from './base.js';

interface SlackCredentials {
  token: string;
  botToken?: string;
  /** Personal (xoxp-) token from the OAuth callback; may be absent (manual
   * token connect, or an OAuth grant that didn't include a user token). */
  userToken?: string;
  /** Task 8: dual send mode. 'user' = post as the connecting person; default
   * ('bot' or omitted) = today's behavior, post as the app/bot. */
  sendAs?: 'bot' | 'user';
}

export class SlackAdapter implements MessengerAdapter {
  private client: WebClient | null = null;
  private status: 'connected' | 'disconnected' | 'token_expired' | 'session_expired' = 'disconnected';
  private token: string;
  private userId: string = '';
  private sendAsUser: boolean;

  constructor(credentials: SlackCredentials) {
    this.sendAsUser = credentials.sendAs === 'user';
    if (this.sendAsUser) {
      // Personal-account sending MUST use the real xoxp user token. Never
      // fall back to token/botToken here — a manual connection stores only
      // {token} (which may itself be an xoxb bot token), and some OAuth
      // grants never got a user token at all. Falling back would silently
      // send under the wrong identity, which is worse than failing.
      this.token = credentials.userToken ?? '';
    } else {
      // Prefer the bot token (xoxb-) so broadcasts post AS the app/bot. OAuth
      // connections also store a user token (xoxp-); using that would post under
      // the authorizing user's own name (the bug this fixes).
      this.token = credentials.botToken || credentials.token;
    }
  }

  async connect(_credentials?: Record<string, unknown>): Promise<void> {
    if (this.sendAsUser && !this.token.startsWith('xoxp-')) {
      this.status = 'disconnected';
      throw new MessengerError(
        'slack',
        null,
        'This Slack connection has no personal account token — reconnect your Slack account to send as yourself.',
      );
    }
    try {
      this.client = new WebClient(this.token);

      // Verify the token by calling auth.test
      const result = await this.client.auth.test();
      if (!result.ok) {
        throw new Error('Slack auth.test failed');
      }

      this.userId = result.user_id ?? '';
      this.status = 'connected';
    } catch (err) {
      this.status = 'disconnected';

      // Check for token expiry/revocation
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('token_revoked') || errMsg.includes('token_expired') || errMsg.includes('invalid_auth')) {
        this.status = 'token_expired';
        throw new MessengerError('slack', err, 'Slack token is expired or revoked');
      }

      throw new MessengerError('slack', err, 'Failed to connect to Slack');
    }
  }

  async disconnect(): Promise<void> {
    this.client = null;
    this.status = 'disconnected';
  }

  async listChats(): Promise<Array<{ externalChatId: string; name: string; chatType: string }>> {
    this.ensureConnected();

    try {
      // Batch-fetch all workspace users upfront so DM name resolution doesn't
      // require individual API calls (avoids rate-limit issues on large workspaces)
      const userMap = new Map<string, string>();
      try {
        let userCursor: string | undefined;
        do {
          const usersResult = await this.client!.users.list({
            limit: 200,
            cursor: userCursor,
          });
          for (const u of usersResult.members ?? []) {
            if (u.id) {
              const displayName = u.real_name
                || u.profile?.display_name
                || u.name
                || u.id;
              userMap.set(u.id, displayName);
            }
          }
          userCursor = usersResult.response_metadata?.next_cursor || undefined;
        } while (userCursor);
      } catch (err) {
        console.warn('[Slack] Failed to batch-fetch users, will fall back to individual lookups:', err);
      }

      const chats: Array<{ externalChatId: string; name: string; chatType: string }> = [];
      let cursor: string | undefined;

      // Paginate through all conversations
      do {
        const result = await this.client!.conversations.list({
          types: 'public_channel,private_channel,mpim,im',
          limit: 200,
          cursor,
        });

        if (result.channels) {
          for (const channel of result.channels) {
            if (!channel.id) continue;

            let chatType: string;
            if (channel.is_im) {
              chatType = 'direct';
            } else if (channel.is_mpim) {
              chatType = 'group';
            } else {
              chatType = 'channel';
            }

            // Resolve human-readable name for DM channels
            let name = channel.name ?? channel.id;
            if (channel.is_im) {
              const userId = (channel as Record<string, unknown>).user as string | undefined;
              if (userId) {
                // Use the pre-fetched user map first, fall back to individual lookup
                name = userMap.get(userId) || name;
                if (name === channel.id) {
                  try {
                    const userInfo = await this.client!.users.info({ user: userId });
                    name = userInfo.user?.real_name
                      || userInfo.user?.profile?.display_name
                      || userInfo.user?.name
                      || channel.id!;
                  } catch (err) {
                    console.warn(`[Slack] Failed to resolve user name for ${userId}:`, err);
                  }
                }
              }
            }

            chats.push({
              externalChatId: channel.id,
              name,
              chatType,
            });
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      return chats;
    } catch (err) {
      this.handleSlackError(err);
      throw new MessengerError('slack', err, 'Failed to list Slack conversations');
    }
  }

  async sendMessage(
    externalChatId: string,
    text: string,
    options?: {
      replyToExternalId?: string;
      attachments?: Array<{ url: string; filename: string; mimeType: string; size: number }>;
    },
  ): Promise<{ externalMessageId: string }> {
    this.ensureConnected();

    try {
      // With attachments: upload all files in one call, with the text as the
      // comment, so a mix of image + PDF (or several files) lands together in a
      // single message. Requires the bot "files:write" scope.
      if (options?.attachments && options.attachments.length > 0) {
        try {
          const fileUploads = [];
          for (const attachment of options.attachments) {
            const fileUrl = attachment.url.startsWith('http')
              ? attachment.url
              : `${process.env.API_URL || process.env.APP_URL || 'http://localhost:3000'}${attachment.url}`;
            const response = await fetch(fileUrl);
            if (!response.ok) throw new Error(`Failed to download attachment: ${response.status}`);
            const buffer = Buffer.from(await response.arrayBuffer());
            fileUploads.push({ file: buffer, filename: attachment.filename || 'file' });
          }

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const uploadArgs: any = {
            channel_id: externalChatId,
            file_uploads: fileUploads,
          };
          if (text) uploadArgs.initial_comment = text;
          if (options?.replyToExternalId) uploadArgs.thread_ts = options.replyToExternalId;

          const up = await this.client!.filesUploadV2(uploadArgs);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const files = (up as any)?.files ?? [];
          const fileId = files?.[0]?.id ?? files?.[0]?.files?.[0]?.id;
          return { externalMessageId: fileId ? String(fileId) : `slack-upload-${Date.now()}` };
        } catch (fileErr) {
          if (fileErr instanceof MessengerError) throw fileErr;
          const msg = fileErr instanceof Error ? fileErr.message : String(fileErr);
          const friendly = msg.includes('missing_scope')
            ? 'Slack file upload failed: the bot is missing the "files:write" scope. Add it under Bot Token Scopes in your Slack app (OAuth & Permissions), reinstall the app, then reconnect Slack.'
            : `Slack file upload failed: ${msg}`;
          console.warn('Failed to upload Slack attachments:', fileErr);
          throw new MessengerError('slack', fileErr, friendly);
        }
      }

      const result = await this.client!.chat.postMessage({
        channel: externalChatId,
        text,
        thread_ts: options?.replyToExternalId,
      });

      if (!result.ok || !result.ts) {
        throw new Error('Slack postMessage failed');
      }

      return { externalMessageId: result.ts };
    } catch (err) {
      // Preserve specific errors (e.g. the attachment/scope message) instead of
      // masking them with a generic one.
      if (err instanceof MessengerError) throw err;
      this.handleSlackError(err);
      throw new MessengerError('slack', err, 'Failed to send Slack message');
    }
  }

  async editMessage(
    externalChatId: string,
    externalMessageId: string,
    newText: string,
  ): Promise<void> {
    this.ensureConnected();

    try {
      const result = await this.client!.chat.update({
        channel: externalChatId,
        ts: externalMessageId,
        text: newText,
      });

      if (!result.ok) {
        throw new Error('Slack chat.update failed');
      }
    } catch (err) {
      this.handleSlackError(err);
      throw new MessengerError('slack', err, 'Failed to edit Slack message');
    }
  }

  async deleteMessage(
    externalChatId: string,
    externalMessageId: string,
  ): Promise<void> {
    this.ensureConnected();

    try {
      const result = await this.client!.chat.delete({
        channel: externalChatId,
        ts: externalMessageId,
      });

      if (!result.ok) {
        throw new Error('Slack chat.delete failed');
      }
    } catch (err) {
      this.handleSlackError(err);
      throw new MessengerError('slack', err, 'Failed to delete Slack message');
    }
  }

  async getMessages(
    externalChatId: string,
    limit = 200,
    cursor?: string,
  ): Promise<GetMessagesResult> {
    this.ensureConnected();

    try {
      const params: Record<string, unknown> = {
        channel: externalChatId,
        limit,
      };
      if (cursor) {
        params.cursor = cursor;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await this.client!.conversations.history(params as any);

      const messages: HistoryMessage[] = (result.messages ?? [])
        .filter((m) => m.ts && m.type === 'message')
        .map((m) => ({
          id: m.ts!,
          text: m.text ?? '',
          senderId: m.user ?? m.bot_id ?? '',
          date: new Date(parseFloat(m.ts!) * 1000),
          isSelf: (m.user ?? '') === this.userId,
        }))
        .reverse(); // oldest first

      const nextCursor = result.response_metadata?.next_cursor || undefined;

      return {
        messages,
        nextCursor: nextCursor && nextCursor.length > 0 ? nextCursor : undefined,
        hasMore: result.has_more ?? false,
      };
    } catch (err) {
      this.handleSlackError(err);
      throw new MessengerError('slack', err, 'Failed to get Slack messages');
    }
  }

  /**
   * Resolve a Slack user ID to a display name.
   */
  async getSenderName(senderId: string): Promise<string> {
    this.ensureConnected();
    try {
      const userInfo = await this.client!.users.info({ user: senderId });
      return userInfo.user?.real_name
        || userInfo.user?.profile?.display_name
        || userInfo.user?.name
        || senderId;
    } catch {
      return senderId;
    }
  }

  getStatus(): 'connected' | 'disconnected' | 'token_expired' | 'session_expired' {
    return this.status;
  }

  private ensureConnected(): void {
    if (this.status !== 'connected' || !this.client) {
      throw new MessengerError('slack', null, 'Slack adapter is not connected');
    }
  }

  /** Detect token-related errors and update status accordingly. */
  private handleSlackError(err: unknown): void {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (
      errMsg.includes('token_revoked') ||
      errMsg.includes('token_expired') ||
      errMsg.includes('invalid_auth') ||
      errMsg.includes('account_inactive')
    ) {
      this.status = 'token_expired';
    }
  }
}
