// ─── Chat service (worker) ───
// Mirrors apps/api/src/services/chat-service.ts so the worker's initial-sync
// path uses the exact same upsert semantics as webhooks/runtime. Keeping the
// logic in one shape prevents drift between "chat auto-created from a webhook"
// and "chat auto-created during bulk import".

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
 * key. On create — stores the chat with the given name. On update — fixes the
 * name if it was previously stored as a raw external ID (e.g. Slack channel ID).
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

  // Check if we now have a better name than the raw ID that was stored before
  const hasRealName = name !== externalChatId && name.length > 0;

  return prisma.chat.upsert({
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
      syncStatus: 'pending',
      hasFullHistory: false,
      lastActivityAt: lastActivityAt ?? new Date(),
    },
    // Fix chat name if it was previously stored as the raw external ID
    update: hasRealName ? { name } : {},
  });
}
