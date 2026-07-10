// ─── Chat service ───
// Central helper for ensuring a Chat row exists for a given external conversation.
// Used by webhooks, real-time listeners, and the initial-sync worker job so that
// unknown chats are auto-created instead of dropped (mirrors the Gmail pattern).

import type { Chat } from '@prisma/client';
import prisma from '../lib/prisma.js';

export type MessengerType = 'telegram' | 'slack' | 'whatsapp' | 'gmail' | 'teams';

export interface EnsureChatParams {
  organizationId: string;
  importedById: string;
  messenger: MessengerType;
  externalChatId: string;
  name: string;
  chatType?: 'direct' | 'group' | 'channel';
  lastActivityAt?: Date;
}

/**
 * Upsert a Chat row by its (externalChatId, messenger, organizationId) composite
 * key. Safe to call repeatedly — on update, only improves the chat name if the
 * existing name is a placeholder ("Unknown" or "User XXXX") and the new name is
 * a real resolved name. `lastActivityAt` is left untouched on update so that
 * re-running initial-sync or replaying webhooks cannot corrupt timestamps.
 */
export async function ensureChat(params: EnsureChatParams): Promise<Chat> {
  const {
    organizationId,
    importedById,
    messenger,
    externalChatId,
    name,
    chatType = 'direct',
    lastActivityAt,
  } = params;

  const isPlaceholderName = (n: string) => n === 'Unknown' || /^User \d+$/.test(n);
  const nameIsReal = !isPlaceholderName(name);

  const chat = await prisma.chat.upsert({
    where: {
      externalChatId_messenger_organizationId: {
        externalChatId,
        messenger,
        organizationId,
      },
    },
    create: {
      name,
      messenger,
      externalChatId,
      chatType,
      organizationId,
      importedById,
      syncStatus: 'synced',
      hasFullHistory: false,
      lastActivityAt: lastActivityAt ?? new Date(),
    },
    update: {},
  });

  // If the chat already exists with a placeholder name and we now have a real
  // name, update it. This is separate from the upsert because Prisma's upsert
  // `update` always runs — we only want to overwrite placeholder names.
  if (nameIsReal && isPlaceholderName(chat.name)) {
    return prisma.chat.update({
      where: { id: chat.id },
      data: { name },
    });
  }

  return chat;
}
