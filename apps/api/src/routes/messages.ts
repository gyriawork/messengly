import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
import { authenticate } from '../middleware/auth.js';
import { getIO } from '../websocket/index.js';
import { decryptCredentials } from '../lib/crypto.js';
import { createAdapter } from '../integrations/factory.js';
import { logActivity } from '../lib/activity-logger.js';
import { getTelegramManager } from '../services/telegram-connection-manager.js';
import { CustomFile } from 'telegram/client/uploads.js';

// ─── Zod Schemas ───

const listMessagesQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const sendMessageBodySchema = z.object({
  text: z.string().min(1).max(10000),
  replyToMessageId: z.string().uuid().optional(),
  attachments: z
    .array(
      z.object({
        url: z.string().url(),
        filename: z.string().min(1).max(500),
        mimeType: z.string().min(1).max(200),
        size: z.number().int().min(0),
      }),
    )
    .max(20)
    .optional(),
});

const editMessageBodySchema = z.object({
  text: z.string().min(1).max(10000),
});

const pinMessageBodySchema = z.object({
  isPinned: z.boolean(),
});

const forwardMessageBodySchema = z.object({
  targetChatId: z.string().uuid(),
});

const searchMessagesQuerySchema = z.object({
  q: z.string().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const addReactionBodySchema = z.object({
  emoji: z.string().min(1).max(20), // Emoji can be 1-20 UTF-16 chars (skin tones, flags, compound)
});

// ─── Helpers ───

function sendError(reply: FastifyReply, code: string, message: string, statusCode: number) {
  return reply.status(statusCode).send({
    error: { code, message, statusCode },
  });
}

/**
 * Verify a chat exists and belongs to the user's organization.
 * Returns the chat or sends an error response and returns null.
 */
async function verifyChat(
  chatId: string,
  organizationId: string | null,
  reply: FastifyReply,
): Promise<{ id: string; organizationId: string; messenger: string; externalChatId: string; name: string; importedById: string | null; ownerId: string | null } | null> {
  if (!organizationId) {
    sendError(reply, 'VALIDATION_ERROR', 'User is not associated with an organization', 400);
    return null;
  }

  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    select: { id: true, organizationId: true, messenger: true, externalChatId: true, name: true, importedById: true, ownerId: true },
  });

  if (!chat) {
    sendError(reply, 'RESOURCE_NOT_FOUND', `Chat with id ${chatId} not found`, 404);
    return null;
  }

  if (chat.organizationId !== organizationId) {
    sendError(reply, 'AUTH_INSUFFICIENT_PERMISSIONS', 'You do not have access to this chat', 403);
    return null;
  }

  return chat;
}

// ─── Plugin ───

export default async function messageRoutes(fastify: FastifyInstance): Promise<void> {
  // ── GET /chats/:chatId/messages — List messages (cursor-based pagination) ──

  fastify.get(
    '/chats/:chatId/messages',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { chatId } = request.params as { chatId: string };

      const parsed = listMessagesQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid query', 422);
      }

      const { cursor, limit } = parsed.data;

      const chat = await verifyChat(chatId, request.user.organizationId, reply);
      if (!chat) return;

      // Build cursor-based query
      const where: Record<string, unknown> = { chatId };

      if (cursor) {
        const cursorMessage = await prisma.message.findUnique({
          where: { id: cursor },
          select: { createdAt: true },
        });

        if (cursorMessage) {
          where.createdAt = { lt: cursorMessage.createdAt };
        }
      }

      const messages = await prisma.message.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit + 1, // fetch one extra to determine nextCursor
        include: {
          replyToMessage: {
            select: {
              id: true,
              senderName: true,
              text: true,
            },
          },
          reactions: {
            select: {
              id: true,
              emoji: true,
              userId: true,
            },
          },
          attachmentFiles: {
            select: {
              id: true,
              url: true,
              filename: true,
              mimeType: true,
              size: true,
            },
          },
        },
      });

      let nextCursor: string | null = null;

      if (messages.length > limit) {
        const lastMessage = messages.pop()!;
        nextCursor = lastMessage.id;
      }

      // Truncate reply preview text, project attachments (prefer relation rows;
      // fall back to legacy JSON for messages saved before the relation existed).
      const formatted = messages.map((msg) => {
        const attachments =
          msg.attachmentFiles && msg.attachmentFiles.length > 0
            ? msg.attachmentFiles
            : Array.isArray(msg.attachmentsLegacy)
              ? (msg.attachmentsLegacy as unknown as Array<{
                  id?: string;
                  url: string;
                  filename: string;
                  mimeType: string;
                  size: number;
                }>)
              : [];
        return {
          ...msg,
          attachmentFiles: undefined,
          attachments,
          replyToMessage: msg.replyToMessage
            ? {
                id: msg.replyToMessage.id,
                senderName: msg.replyToMessage.senderName,
                text:
                  msg.replyToMessage.text.length > 100
                    ? msg.replyToMessage.text.slice(0, 100) + '...'
                    : msg.replyToMessage.text,
              }
            : null,
        };
      });

      return reply.status(200).send({ messages: formatted, nextCursor });
    },
  );

  // ── POST /chats/:chatId/messages — Send a message ──

  fastify.post(
    '/chats/:chatId/messages',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { chatId } = request.params as { chatId: string };

      const parsed = sendMessageBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 422);
      }

      const { text, replyToMessageId, attachments } = parsed.data;

      const chat = await verifyChat(chatId, request.user.organizationId, reply);
      if (!chat) return;

      // User role can only send messages in chats they imported or own
      if (request.user.role === 'user' && chat.importedById !== request.user.id && chat.ownerId !== request.user.id) {
        return sendError(reply, 'AUTH_INSUFFICIENT_PERMISSIONS', 'You can only send messages in your own chats', 403);
      }

      // Verify replyToMessageId exists in this chat
      if (replyToMessageId) {
        const replyTarget = await prisma.message.findFirst({
          where: { id: replyToMessageId, chatId },
          select: { id: true },
        });

        if (!replyTarget) {
          return sendError(reply, 'RESOURCE_NOT_FOUND', 'Reply target message not found in this chat', 404);
        }
      }

      // Check integration BEFORE creating the message to avoid phantom records
      const integration = await prisma.integration.findFirst({
        where: {
          messenger: chat.messenger,
          organizationId: request.user.organizationId!,
          userId: request.user.id,
          status: 'connected',
        },
      });

      if (!integration) {
        return sendError(reply, 'MESSENGER_NOT_CONNECTED', `Connect ${chat.messenger} to send messages in this chat`, 403);
      }

      // Create message + update chat in a transaction
      const [message] = await prisma.$transaction([
        prisma.message.create({
          data: {
            chatId,
            senderName: request.user.name,
            senderExternalId: request.user.id,
            isSelf: true,
            text,
            replyToMessageId: replyToMessageId ?? null,
            attachmentsLegacy: attachments ?? undefined,
            deliveryStatus: 'sent',
          },
          include: {
            replyToMessage: {
              select: { id: true, senderName: true, text: true },
            },
          },
        }),
        prisma.chat.update({
          where: { id: chatId },
          data: {
            messageCount: { increment: 1 },
            lastActivityAt: new Date(),
          },
        }),
      ]);

      // Create Attachment records if attachments provided
      if (attachments && attachments.length > 0) {
        await prisma.attachment.createMany({
          data: attachments.map((att) => ({
            messageId: message.id,
            url: att.url,
            filename: att.filename,
            mimeType: att.mimeType,
            size: att.size,
          })),
        });
      }

      // ── Send message to real messenger ──
      let deliveryStatus = 'sent';
      let externalMessageId: string | null = null;

      // Prepare common send params
      let replyToExternalId: string | undefined;
      if (replyToMessageId) {
        const replyMsg = await prisma.message.findUnique({
          where: { id: replyToMessageId },
          select: { externalMessageId: true },
        });
        replyToExternalId = replyMsg?.externalMessageId ?? undefined;
      }

      const savedAttachments = await prisma.attachment.findMany({
        where: { messageId: message.id },
        select: { url: true, filename: true, mimeType: true },
      });

      try {
        // For Telegram, prefer the persistent connection manager to avoid
        // session conflicts with a second concurrent GramJS client.
        const telegramClient = chat.messenger === 'telegram'
          ? getTelegramManager().getClient(integration.id)
          : null;

        if (telegramClient) {
          // Use the connection manager's already-connected client.
          // Resolve peer: getDialogs() populates GramJS entity cache so that
          // sendMessage can map numeric IDs to proper InputPeer with access_hash.
          const numId = parseInt(chat.externalChatId, 10);
          let peer: number | string = !isNaN(numId) ? numId : chat.externalChatId;
          const replyTo = replyToExternalId ? parseInt(replyToExternalId, 10) : undefined;

          // Resolve Telegram peer via dialog matching.
          // The stored externalChatId uses GramJS dialog.id format (from worker sync).
          // We MUST use dialog matching because numeric ID → InputPeer conversion
          // can produce invalid peers (e.g., treating a channel as a chat).
          const dialogs = await telegramClient.getDialogs({ limit: 500 });
          const resolvedDialog = dialogs.find((d) => d.id?.toString() === chat.externalChatId);
          if (!resolvedDialog?.inputEntity) {
            throw new Error(`Telegram dialog not found for externalChatId ${chat.externalChatId}`);
          }
          const resolvedPeer = resolvedDialog.inputEntity;

          if (savedAttachments.length > 0) {
            let firstMsgId: string | undefined;
            for (let i = 0; i < savedAttachments.length; i++) {
              try {
                const response = await fetch(savedAttachments[i].url);
                const buffer = Buffer.from(await response.arrayBuffer());
                const file = new CustomFile(savedAttachments[i].filename, buffer.length, '', buffer);
                const result = await telegramClient.sendFile(resolvedPeer, {
                  file,
                  caption: i === 0 ? text : '',
                  replyTo: i === 0 ? replyTo : undefined,
                });
                if (i === 0) firstMsgId = result.id.toString();
              } catch (attachErr) {
                console.error(`[Telegram] Failed to send attachment:`, attachErr instanceof Error ? attachErr.message : attachErr);
              }
            }
            if (firstMsgId) {
              externalMessageId = firstMsgId;
            } else {
              // All attachments failed, send text only
              const result = await telegramClient.sendMessage(resolvedPeer, { message: text, replyTo });
              externalMessageId = result.id.toString();
            }
          } else {
            const result = await telegramClient.sendMessage(resolvedPeer, { message: text, replyTo });
            externalMessageId = result.id.toString();
          }
          deliveryStatus = 'delivered';
        } else if (integration.credentials) {
          // Fallback: create a new adapter (for non-Telegram or if manager has no client)
          const creds = decryptCredentials(integration.credentials as string);
          const adapter = await createAdapter(chat.messenger, creds, { organizationId: chat.organizationId });
          try {
            await adapter.connect();

            const result = await adapter.sendMessage(
              chat.externalChatId,
              text,
              {
                replyToExternalId,
                attachments: savedAttachments.length > 0 ? savedAttachments : undefined,
              },
            );
            externalMessageId = result.externalMessageId;
            deliveryStatus = 'delivered';
          } finally {
            try { await adapter.disconnect(); } catch (e) { request.log.warn(e, 'adapter disconnect error'); }
          }
        }
      } catch (err) {
        // Extract the real Slack/messenger API error from MessengerError wrapper
        const originalErr = (err as { originalError?: unknown }).originalError;
        const realError = originalErr instanceof Error ? originalErr.message : originalErr ? String(originalErr) : null;
        const errMsg = err instanceof Error ? err.message : String(err);
        const fullError = realError ? `${errMsg}: ${realError}` : errMsg;
        console.error(`Failed to send message to ${chat.messenger}:`, fullError, err);
        deliveryStatus = 'failed';
        (message as Record<string, unknown>).deliveryError = fullError;
      }

      // Update message with delivery result
      if (deliveryStatus !== 'sent' || externalMessageId) {
        await prisma.message.update({
          where: { id: message.id },
          data: {
            deliveryStatus,
            ...(externalMessageId ? { externalMessageId } : {}),
          },
        });
        (message as Record<string, unknown>).deliveryStatus = deliveryStatus;
        if (externalMessageId) {
          (message as Record<string, unknown>).externalMessageId = externalMessageId;
        }
      }

      // Emit WebSocket event
      try {
        getIO().to(`chat:${chatId}`).emit('new_message', { chatId, message });
      } catch {
        // WebSocket not initialized yet — non-fatal
      }

      // Log to activity feed
      logActivity({
        category: 'messages',
        action: 'message_sent',
        description: `sent a message in ${chat.name}`,
        targetType: 'message',
        targetId: message.id,
        userId: request.user.id,
        userName: request.user.name,
        organizationId: request.user.organizationId!,
        metadata: { chatId, chatName: chat.name, messageLength: text.length, preview: text.slice(0, 100) },
      }).catch(() => {});

      return reply.status(201).send(message);
    },
  );

  // ── PATCH /messages/:id — Edit message ──

  fastify.patch(
    '/messages/:id',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      const parsed = editMessageBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 422);
      }

      const { text } = parsed.data;

      const message = await prisma.message.findUnique({
        where: { id },
        include: { chat: { select: { organizationId: true } } },
      });

      if (!message) {
        return sendError(reply, 'RESOURCE_NOT_FOUND', `Message with id ${id} not found`, 404);
      }

      // Verify organization access
      if (message.chat.organizationId !== request.user.organizationId) {
        return sendError(reply, 'AUTH_INSUFFICIENT_PERMISSIONS', 'You do not have access to this message', 403);
      }

      // Only own messages can be edited
      if (!message.isSelf || (message.senderExternalId !== request.user.id && message.senderName !== request.user.name)) {
        return sendError(reply, 'AUTH_INSUFFICIENT_PERMISSIONS', 'You can only edit your own messages', 403);
      }

      const updated = await prisma.message.update({
        where: { id },
        data: { text, editedAt: new Date() },
      });

      // Edit message in real messenger (best-effort)
      if (message.externalMessageId) {
        try {
          const chat = await prisma.chat.findUnique({
            where: { id: message.chatId },
            select: { messenger: true, externalChatId: true, organizationId: true },
          });
          if (chat) {
            const integration = await prisma.integration.findFirst({
              where: { messenger: chat.messenger, organizationId: chat.organizationId, userId: request.user.id, status: 'connected' },
            });
            if (integration?.credentials) {
              // Prefer persistent connection for Telegram
              const tgClient = chat.messenger === 'telegram' ? getTelegramManager().getClient(integration.id) : null;
              if (tgClient) {
                let editPeer;
                try { editPeer = await tgClient.getInputEntity(parseInt(chat.externalChatId, 10) || chat.externalChatId); } catch {
                  const dlgs = await tgClient.getDialogs({ limit: 200 });
                  const m = dlgs.find((d) => d.id?.toString() === chat.externalChatId);
                  editPeer = m?.inputEntity ?? (parseInt(chat.externalChatId, 10) || chat.externalChatId);
                }
                await tgClient.editMessage(editPeer, {
                  message: parseInt(message.externalMessageId, 10),
                  text,
                }).catch(() => {});
              } else {
                const creds = decryptCredentials(integration.credentials as string);
                const adapter = await createAdapter(chat.messenger, creds, { organizationId: chat.organizationId });
                try {
                  await adapter.connect();
                  await adapter.editMessage(chat.externalChatId, message.externalMessageId, text).catch(() => {});
                } finally {
                  try { await adapter.disconnect(); } catch (e) { request.log.warn(e, 'adapter disconnect error'); }
                }
              }
            }
          }
        } catch { /* best-effort */ }
      }

      // Emit WebSocket event
      try {
        getIO().to(`chat:${message.chatId}`).emit('message_updated', {
          chatId: message.chatId,
          messageId: updated.id,
          text: updated.text,
          editedAt: updated.editedAt,
        });
      } catch {
        // WebSocket not initialized yet — non-fatal
      }

      logActivity({
        category: 'messages',
        action: 'message_edited',
        description: 'edited a message',
        targetType: 'message',
        targetId: id,
        userId: request.user.id,
        userName: request.user.name,
        organizationId: message.chat.organizationId,
        metadata: { preview: text.slice(0, 100) },
      }).catch(() => {});

      return reply.status(200).send(updated);
    },
  );

  // ── DELETE /messages/:id — Delete message ──

  fastify.delete(
    '/messages/:id',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      const message = await prisma.message.findUnique({
        where: { id },
        include: { chat: { select: { organizationId: true } } },
      });

      if (!message) {
        return sendError(reply, 'RESOURCE_NOT_FOUND', `Message with id ${id} not found`, 404);
      }

      // Verify organization access
      if (message.chat.organizationId !== request.user.organizationId) {
        return sendError(reply, 'AUTH_INSUFFICIENT_PERMISSIONS', 'You do not have access to this message', 403);
      }

      // Only own messages can be deleted
      if (!message.isSelf || (message.senderExternalId !== request.user.id && message.senderName !== request.user.name)) {
        return sendError(reply, 'AUTH_INSUFFICIENT_PERMISSIONS', 'You can only delete your own messages', 403);
      }

      // Delete message in real messenger (best-effort)
      if (message.externalMessageId) {
        try {
          const chat = await prisma.chat.findUnique({
            where: { id: message.chatId },
            select: { messenger: true, externalChatId: true, organizationId: true },
          });
          if (chat) {
            const integration = await prisma.integration.findFirst({
              where: { messenger: chat.messenger, organizationId: chat.organizationId, userId: request.user.id, status: 'connected' },
            });
            if (integration?.credentials) {
              // Prefer persistent connection for Telegram
              const tgClient = chat.messenger === 'telegram' ? getTelegramManager().getClient(integration.id) : null;
              if (tgClient) {
                let delPeer;
                try { delPeer = await tgClient.getInputEntity(parseInt(chat.externalChatId, 10) || chat.externalChatId); } catch {
                  const dlgs = await tgClient.getDialogs({ limit: 200 });
                  const m = dlgs.find((d) => d.id?.toString() === chat.externalChatId);
                  delPeer = m?.inputEntity ?? (parseInt(chat.externalChatId, 10) || chat.externalChatId);
                }
                await tgClient.deleteMessages(delPeer, [parseInt(message.externalMessageId, 10)], { revoke: true }).catch(() => {});
              } else {
                const creds = decryptCredentials(integration.credentials as string);
                const adapter = await createAdapter(chat.messenger, creds, { organizationId: chat.organizationId });
                try {
                  await adapter.connect();
                  await adapter.deleteMessage(chat.externalChatId, message.externalMessageId).catch(() => {});
                } finally {
                  try { await adapter.disconnect(); } catch (e) { request.log.warn(e, 'adapter disconnect error'); }
                }
              }
            }
          }
        } catch { /* best-effort */ }
      }

      await prisma.message.delete({ where: { id } });

      // Emit WebSocket event
      try {
        getIO().to(`chat:${message.chatId}`).emit('message_deleted', {
          chatId: message.chatId,
          messageId: id,
        });
      } catch {
        // WebSocket not initialized yet — non-fatal
      }

      logActivity({
        category: 'messages',
        action: 'message_deleted',
        description: 'deleted a message',
        targetType: 'message',
        targetId: id,
        userId: request.user.id,
        userName: request.user.name,
        organizationId: message.chat.organizationId,
        metadata: { preview: message.text?.slice(0, 100) },
      }).catch(() => {});

      return reply.status(200).send({ success: true });
    },
  );

  // ── POST /messages/:id/forward — Forward message to another chat ──

  fastify.post(
    '/messages/:id/forward',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const parsed = forwardMessageBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', 'Invalid input', 422);
      }

      const { targetChatId } = parsed.data;

      // Verify source message
      const sourceMessage = await prisma.message.findUnique({
        where: { id },
        include: { chat: { select: { organizationId: true, name: true } } },
      });

      if (!sourceMessage || sourceMessage.chat.organizationId !== request.user.organizationId) {
        return sendError(reply, 'RESOURCE_NOT_FOUND', 'Message not found', 404);
      }

      // Verify target chat
      const targetChat = await verifyChat(targetChatId, request.user.organizationId, reply);
      if (!targetChat) return;

      // Create forwarded message in target chat
      const forwardedText = `[Forwarded from ${sourceMessage.chat.name}]\n${sourceMessage.text}`;

      const [newMessage] = await prisma.$transaction([
        prisma.message.create({
          data: {
            chatId: targetChatId,
            senderName: request.user.name,
            senderExternalId: request.user.id,
            isSelf: true,
            text: forwardedText,
            deliveryStatus: 'sent',
          },
        }),
        prisma.chat.update({
          where: { id: targetChatId },
          data: { messageCount: { increment: 1 }, lastActivityAt: new Date() },
        }),
      ]);

      // Emit WebSocket event to target chat
      try {
        getIO().to(`chat:${targetChatId}`).emit('new_message', { chatId: targetChatId, message: newMessage });
      } catch {
        // WebSocket not initialized yet — non-fatal
      }

      logActivity({
        category: 'messages',
        action: 'message_forwarded',
        description: `forwarded a message to ${targetChat.name}`,
        targetType: 'message',
        targetId: newMessage.id,
        userId: request.user.id,
        userName: request.user.name,
        organizationId: request.user.organizationId!,
        metadata: { sourceChatName: sourceMessage.chat.name, targetChatId, preview: sourceMessage.text?.slice(0, 100) },
      }).catch(() => {});

      return reply.status(201).send(newMessage);
    },
  );

  // ── PATCH /messages/:id/pin — Pin/unpin message ──

  fastify.patch(
    '/messages/:id/pin',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      const parsed = pinMessageBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 422);
      }

      const { isPinned } = parsed.data;

      const message = await prisma.message.findUnique({
        where: { id },
        include: { chat: { select: { organizationId: true } } },
      });

      if (!message) {
        return sendError(reply, 'RESOURCE_NOT_FOUND', `Message with id ${id} not found`, 404);
      }

      // Verify organization access
      if (message.chat.organizationId !== request.user.organizationId) {
        return sendError(reply, 'AUTH_INSUFFICIENT_PERMISSIONS', 'You do not have access to this message', 403);
      }

      const updated = await prisma.message.update({
        where: { id },
        data: { isPinned },
      });

      return reply.status(200).send(updated);
    },
  );

  // ── GET /chats/:chatId/messages/search — Search messages ──

  fastify.get(
    '/chats/:chatId/messages/search',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { chatId } = request.params as { chatId: string };

      const parsed = searchMessagesQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid query', 422);
      }

      const { q, limit } = parsed.data;

      const chat = await verifyChat(chatId, request.user.organizationId, reply);
      if (!chat) return;

      const messages = await prisma.message.findMany({
        where: {
          chatId,
          text: { contains: q, mode: 'insensitive' },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        include: {
          replyToMessage: {
            select: { id: true, senderName: true, text: true },
          },
        },
      });

      return reply.status(200).send({ messages });
    },
  );

  // ── POST /chats/:chatId/messages/:messageId/reactions — Add emoji reaction ──

  fastify.post(
    '/chats/:chatId/messages/:messageId/reactions',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { chatId, messageId } = request.params as { chatId: string; messageId: string };

      const parsed = addReactionBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 422);
      }

      const { emoji } = parsed.data;

      // Verify chat access
      const chat = await verifyChat(chatId, request.user.organizationId, reply);
      if (!chat) return;

      // Verify message exists in this chat
      const message = await prisma.message.findFirst({
        where: { id: messageId, chatId },
        select: { id: true },
      });

      if (!message) {
        return sendError(reply, 'RESOURCE_NOT_FOUND', 'Message not found in this chat', 404);
      }

      // Upsert reaction (create new or reset createdAt if re-adding same emoji)
      const reaction = await prisma.reaction.upsert({
        where: {
          messageId_userId_emoji: {
            messageId,
            userId: request.user.id,
            emoji,
          },
        },
        update: {
          createdAt: new Date(), // Reset timestamp on re-add
        },
        create: {
          messageId,
          userId: request.user.id,
          emoji,
        },
      });

      // ── Sync to messenger ──
      const msg = await prisma.message.findUnique({
        where: { id: messageId },
        select: {
          externalMessageId: true,
          chat: { select: { externalChatId: true, messenger: true, organizationId: true } },
        },
      });

      let syncWarning: string | undefined;

if (msg?.externalMessageId && msg.chat) {
        const integration = await prisma.integration.findFirst({
          where: { messenger: msg.chat.messenger, organizationId: msg.chat.organizationId, userId: request.user.id, status: 'connected' },
        });

        if (integration?.credentials) {
          const creds = decryptCredentials(integration.credentials as string);
          const adapter = await createAdapter(msg.chat.messenger, creds, { organizationId: msg.chat.organizationId });
          if (adapter.addReaction) {
            try {
              await adapter.connect();
              await adapter.addReaction(msg.chat.externalChatId, msg.externalMessageId, emoji);
              // Re-check: reaction may have been deleted while adapter call was in-flight
              const current = await prisma.reaction.findUnique({
                where: { messageId_userId_emoji: { messageId, userId: request.user.id, emoji } },
              });
              if (current) {
                await prisma.reaction.update({ where: { id: current.id }, data: { externalSynced: true } });
              } else if (adapter.removeReaction) {
                // User deleted while we were syncing — remove from messenger
                await adapter.removeReaction(msg.chat.externalChatId, msg.externalMessageId, emoji);
              }
            } catch (err) {
              syncWarning = 'Reaction saved locally but failed to sync to messenger';
              console.error(`[Reaction sync] FAILED: ${err instanceof Error ? err.message : String(err)}`, err);
              request.log.warn({ err, messageId, emoji }, syncWarning);
            } finally {
              try { await adapter.disconnect(); } catch { /* non-critical */ }
            }
          }
        }
      }

      // Emit WebSocket event
      try {
        getIO().to(`chat:${chatId}`).emit('reaction_added', {
          chatId,
          messageId,
          reaction: {
            emoji: reaction.emoji,
            userId: reaction.userId,
            createdAt: reaction.createdAt,
          },
        });
      } catch {
        // WebSocket not initialized yet — non-fatal
      }

      return reply.status(201).send({
        ...reaction,
        ...(syncWarning ? { syncWarning } : {}),
      });
    },
  );

  // ── GET /chats/:chatId/messages/:messageId/reactions — Get reactions grouped by emoji ──

  fastify.get(
    '/chats/:chatId/messages/:messageId/reactions',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { chatId, messageId } = request.params as { chatId: string; messageId: string };

      // Verify chat access
      const chat = await verifyChat(chatId, request.user.organizationId, reply);
      if (!chat) return;

      // Verify message exists in this chat
      const message = await prisma.message.findFirst({
        where: { id: messageId, chatId },
        select: { id: true },
      });

      if (!message) {
        return sendError(reply, 'RESOURCE_NOT_FOUND', 'Message not found in this chat', 404);
      }

      // Aggregate reactions on the database side
      const reactions = await prisma.reaction.groupBy({
        by: ['emoji'],
        where: { messageId },
        _count: { emoji: true },
      });

      const userReactions = await prisma.reaction.findMany({
        where: { messageId, userId: request.user.id },
        select: { emoji: true },
      });
      const userEmojiSet = new Set(userReactions.map((r) => r.emoji));

      const grouped = reactions.map((r) => ({
        emoji: r.emoji,
        count: r._count.emoji,
        userReacted: userEmojiSet.has(r.emoji),
      }));

      return reply.status(200).send({ reactions: grouped });
    },
  );

  // ── DELETE /chats/:chatId/messages/:messageId/reactions/:emoji — Remove emoji reaction ──

  fastify.delete(
    '/chats/:chatId/messages/:messageId/reactions/:emoji',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { chatId, messageId, emoji } = request.params as { chatId: string; messageId: string; emoji: string };

      // Verify chat access
      const chat = await verifyChat(chatId, request.user.organizationId, reply);
      if (!chat) return;

      // Verify message exists in this chat
      const message = await prisma.message.findFirst({
        where: { id: messageId, chatId },
        select: { id: true },
      });

      if (!message) {
        return sendError(reply, 'RESOURCE_NOT_FOUND', 'Message not found in this chat', 404);
      }

      // Delete reaction (only own reactions)
      const deleted = await prisma.reaction.deleteMany({
        where: {
          messageId,
          emoji,
          userId: request.user.id,
        },
      });

      if (deleted.count === 0) {
        return sendError(reply, 'RESOURCE_NOT_FOUND', 'Reaction not found', 404);
      }

      // ── Sync removal to messenger ──
      const msg = await prisma.message.findUnique({
        where: { id: messageId },
        select: {
          externalMessageId: true,
          chat: { select: { externalChatId: true, messenger: true, organizationId: true } },
        },
      });

      if (msg?.externalMessageId && msg.chat) {
        const integration = await prisma.integration.findFirst({
          where: { messenger: msg.chat.messenger, organizationId: msg.chat.organizationId, userId: request.user.id, status: 'connected' },
        });

        if (integration?.credentials) {
          const creds = decryptCredentials(integration.credentials as string);
          const adapter = await createAdapter(msg.chat.messenger, creds, { organizationId: msg.chat.organizationId });
          if (adapter.removeReaction) {
            try {
              await adapter.connect();
              // For Telegram: query remaining reactions (replace-all semantics)
              const remaining = msg.chat.messenger === 'telegram'
                ? await prisma.reaction.findMany({
                    where: { messageId, userId: request.user.id },
                    select: { emoji: true },
                  })
                : [];
              const remainingEmoji = remaining.map((r) => r.emoji);

              await adapter.removeReaction(
                msg.chat.externalChatId, msg.externalMessageId, emoji,
                { remainingEmoji },
              );
            } catch (err) {
              request.log.warn({ err, messageId, emoji }, 'Failed to remove reaction from messenger');
            } finally {
              try { await adapter.disconnect(); } catch { /* non-critical */ }
            }
          }
        }
      }

      // Emit WebSocket event
      try {
        getIO().to(`chat:${chatId}`).emit('reaction_removed', {
          chatId,
          messageId,
          emoji,
          userId: request.user.id,
        });
      } catch {
        // WebSocket not initialized yet — non-fatal
      }

      return reply.status(204).send();
    },
  );
}
