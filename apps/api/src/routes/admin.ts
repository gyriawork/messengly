// ─── Admin Routes — Platform Config ───
// Superadmin-only endpoints for managing global platform credentials.

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
import { authenticate } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { encryptCredentials } from '../lib/crypto.js';
import { getPlatformCredentials, invalidatePlatformCache } from '../lib/platform-credentials.js';
import { logActivity } from '../lib/activity-logger.js';
import { MESSENGERS, MESSENGER_PLATFORM_FIELDS, MESSENGER_ENV_VARS } from '../lib/platform-constants.js';
import type { Messenger } from '../lib/platform-constants.js';
import { messageSyncQueue } from '../lib/queue.js';
// Dynamic imports for telegram — loaded only when backfill endpoint is called
// to avoid crashing the entire admin module if telegram package has issues


// ─── Schemas ───

const messengerParamSchema = z.object({
  messenger: z.enum(['telegram', 'slack', 'gmail', 'whatsapp', 'teams']),
});

const telegramCredsSchema = z.object({
  apiId: z.coerce.number().int().positive(),
  apiHash: z.string().min(1),
});

const oauthCredsSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
});

const credentialSchemas: Record<string, z.ZodType> = {
  telegram: telegramCredsSchema,
  slack: oauthCredsSchema,
  gmail: oauthCredsSchema,
};

// ─── Helpers ───

function sendError(reply: FastifyReply, code: string, message: string, statusCode: number) {
  return reply.status(statusCode).send({
    error: { code, message, statusCode },
  });
}

/** Extract a hint (last 4 chars) from the first secret field of a messenger's credentials. */
function getCredentialHint(messenger: Messenger, creds: Record<string, string>): string | undefined {
  const fields = MESSENGER_PLATFORM_FIELDS[messenger];
  const secretField = fields.find((f) => f.type === 'password') ?? fields[0];
  if (!secretField) return undefined;
  const val = creds[secretField.key];
  if (!val || val.length < 4) return val;
  return `...${val.slice(-4)}`;
}

// ─── Plugin ───

export default async function adminRoutes(fastify: FastifyInstance) {
  const authPreHandlers = [authenticate, requireRole('superadmin')];

  // ─── GET /admin/platform-config ───
  // Returns status for all messengers (never raw credentials).

  fastify.get(
    '/admin/platform-config',
    { preHandler: authPreHandlers },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const results = await Promise.all(
        MESSENGERS.map(async (messenger) => {
          const result = await getPlatformCredentials(messenger);

          let hint: string | undefined;
          if (result.credentials && result.source === 'database') {
            hint = getCredentialHint(messenger, result.credentials);
          } else if (result.credentials && result.source === 'env') {
            hint = getCredentialHint(messenger, result.credentials);
          }

          // Check enabled flag for DB entries
          let enabled = true;
          if (result.source === 'database') {
            const config = await prisma.platformConfig.findUnique({ where: { messenger } });
            enabled = config?.enabled ?? true;
          }

          return {
            messenger,
            configured: result.source === 'none_required' || result.credentials !== null,
            source: result.source,
            enabled: result.source === 'none_required' ? true : enabled,
            hint,
          };
        }),
      );

      return reply.send(results);
    },
  );

  // ─── PUT /admin/platform-config/:messenger ───
  // Create or update platform credentials for a messenger.

  fastify.put(
    '/admin/platform-config/:messenger',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = messengerParamSchema.safeParse(request.params);
      if (!params.success) {
        return sendError(reply, 'VALIDATION_ERROR', 'Invalid messenger', 400);
      }

      const { messenger } = params.data;

      // WhatsApp and Teams authenticate through their own sidecar sessions, so
      // they declare no platform fields and have nothing to store here.
      if (MESSENGER_PLATFORM_FIELDS[messenger].length === 0) {
        return sendError(reply, 'VALIDATION_ERROR', `${messenger} does not require platform credentials`, 400);
      }

      const schema = credentialSchemas[messenger];
      if (!schema) {
        return sendError(reply, 'VALIDATION_ERROR', `No credential schema for ${messenger}`, 400);
      }

      const body = schema.safeParse(request.body);
      if (!body.success) {
        return sendError(reply, 'VALIDATION_ERROR', body.error.errors.map((e) => e.message).join(', '), 422);
      }

      // Convert apiId to string for consistent storage
      const creds: Record<string, string> = {};
      for (const [key, val] of Object.entries(body.data as Record<string, unknown>)) {
        creds[key] = String(val);
      }

      const encrypted = encryptCredentials(creds);

      await prisma.platformConfig.upsert({
        where: { messenger },
        create: {
          messenger,
          credentials: encrypted,
          enabled: true,
          updatedBy: request.user.id,
        },
        update: {
          credentials: encrypted,
          enabled: true,
          updatedBy: request.user.id,
        },
      });

      invalidatePlatformCache(messenger);

      // Log activity
      await logActivity({
        category: 'settings',
        action: 'platform_config_updated',
        description: `Platform credentials updated for ${messenger}`,
        targetType: 'PlatformConfig',
        targetId: messenger,
        userId: request.user.id,
        userName: request.user.name,
        organizationId: request.user.organizationId ?? 'global',
        metadata: { messenger, source: 'database' },
      });

      return reply.send({
        messenger,
        configured: true,
        source: 'database',
        enabled: true,
        hint: getCredentialHint(messenger as Messenger, creds),
      });
    },
  );

  // ─── DELETE /admin/platform-config/:messenger ───
  // Remove DB credentials. Falls back to env vars if present.

  fastify.delete(
    '/admin/platform-config/:messenger',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = messengerParamSchema.safeParse(request.params);
      if (!params.success) {
        return sendError(reply, 'VALIDATION_ERROR', 'Invalid messenger', 400);
      }

      const { messenger } = params.data;

      // Check if env fallback exists
      const envMap = MESSENGER_ENV_VARS[messenger];
      const hasEnvFallback =
        Object.keys(envMap).length > 0 &&
        Object.values(envMap).every((envVar) => !!process.env[envVar]);

      if (!hasEnvFallback) {
        const query = request.query as Record<string, string>;
        if (query.confirm !== 'true') {
          return reply.status(400).send({
            error: {
              code: 'CONFIRMATION_REQUIRED',
              message: `No environment variable fallback for ${messenger}. This will make it unavailable for users. Add ?confirm=true to proceed.`,
              statusCode: 400,
            },
            fallback: null,
          });
        }
      }

      await prisma.platformConfig.deleteMany({ where: { messenger } });
      invalidatePlatformCache(messenger);

      await logActivity({
        category: 'settings',
        action: 'platform_config_deleted',
        description: `Platform credentials removed for ${messenger}`,
        targetType: 'PlatformConfig',
        targetId: messenger,
        userId: request.user.id,
        userName: request.user.name,
        organizationId: request.user.organizationId ?? 'global',
        metadata: { messenger },
      });

      return reply.send({
        messenger,
        configured: hasEnvFallback,
        fallback: hasEnvFallback ? 'env' : null,
      });
    },
  );

  // ─── POST /admin/gmail/rehydrate ───
  // One-shot backfill: re-fetches Gmail threads with format:'full' and UPDATEs
  // existing Message rows with new email fields (htmlBody, subject, fromEmail,
  // toEmails, etc). For already-imported Gmail chats that were synced before
  // the rich-rendering update.
  //
  // Body: { organizationId: string, chatIds?: string[] }
  //   If chatIds omitted → rehydrates ALL Gmail chats in the org.
  //
  // Dispatches sync:gmail-rehydrate jobs (batched per-integration).

  fastify.post(
    '/admin/gmail/rehydrate',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const bodySchema = z.object({
        organizationId: z.string().min(1),
        chatIds: z.array(z.string()).optional(),
      });

      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', parsed.error.errors.map((e) => e.message).join(', '), 422);
      }

      const { organizationId, chatIds } = parsed.data;

      // Find the Gmail integration for this organization. Chats don't carry
      // integrationId directly — it's resolved via (messenger, organizationId).
      const integration = await prisma.integration.findFirst({
        where: { organizationId, messenger: 'gmail', status: 'connected' },
        select: { id: true },
      });

      if (!integration) {
        return sendError(reply, 'RESOURCE_NOT_FOUND', 'No connected Gmail integration for this organization', 404);
      }

      // Load Gmail chats in the org (optionally filtered by ids)
      const chats = await prisma.chat.findMany({
        where: {
          organizationId,
          messenger: 'gmail',
          ...(chatIds && chatIds.length > 0 ? { id: { in: chatIds } } : {}),
        },
        select: { id: true },
      });

      if (chats.length === 0) {
        return reply.send({ enqueued: 0, jobs: 0, message: 'No Gmail chats found' });
      }

      let totalJobs = 0;
      let totalChats = 0;

      // Chunk into batches of 20 to keep individual jobs short
      const BATCH_SIZE = 20;
      const allIds = chats.map((c) => c.id);
      for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
        const batch = allIds.slice(i, i + BATCH_SIZE);
        await messageSyncQueue.add(
          'sync:gmail-rehydrate',
          {
            chatIds: batch,
            integrationId: integration.id,
            organizationId,
          },
          { removeOnComplete: true },
        );
        totalJobs++;
        totalChats += batch.length;
      }

      await logActivity({
        category: 'settings',
        action: 'gmail_rehydrate_triggered',
        description: `Gmail rehydrate triggered for ${totalChats} chats (${totalJobs} jobs)`,
        targetType: 'Organization',
        targetId: organizationId,
        userId: request.user.id,
        userName: request.user.name,
        organizationId,
        metadata: { chatCount: totalChats, jobCount: totalJobs },
      });

      return reply.send({
        enqueued: totalChats,
        jobs: totalJobs,
      });
    },
  );

  // ─── Backfill Sender Names ───
  // Resolves "Unknown" and "User XXXXXX" sender names for Telegram messages
  // using the active connection manager client.
  fastify.post(
    '/admin/backfill-sender-names',
    { preHandler: [authenticate, requireRole('admin', 'superadmin')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
      const { getTelegramManager } = await import('../services/telegram-connection-manager.js');
      const { Api } = await import('telegram');

      // Strategy: fetch participants from each Telegram group chat to build
      // a userId → name map, then bulk-update messages.

      // 1. Find Telegram chats that have messages with bad sender names
      const chatsWithBadNames = await prisma.chat.findMany({
        where: {
          messenger: 'telegram',
          messages: {
            some: {
              isSelf: false,
              senderExternalId: { not: null },
              OR: [
                { senderName: 'Unknown' },
                { senderName: { startsWith: 'User ' } },
              ],
            },
          },
        },
        select: { id: true, externalChatId: true, organizationId: true, chatType: true },
      });

      if (chatsWithBadNames.length === 0) {
        return reply.send({ updated: 0, resolved: 0, message: 'No chats with bad names' });
      }

      // 2. Get active Telegram integrations
      const orgIds = [...new Set(chatsWithBadNames.map((c) => c.organizationId))];
      const integrations = await prisma.integration.findMany({
        where: { messenger: 'telegram', status: 'connected', organizationId: { in: orgIds } },
        select: { id: true, organizationId: true },
      });

      let manager: ReturnType<typeof getTelegramManager>;
      try { manager = getTelegramManager(); } catch {
        return reply.status(503).send({ error: 'Telegram connection manager not initialized' });
      }

      // 3. For each chat, fetch participants via getParticipants to populate entity cache
      const nameMap = new Map<string, string>(); // senderExternalId → real name
      const errors: string[] = [];

      for (const chat of chatsWithBadNames) {
        // Find a client for this org
        const orgIntegrations = integrations.filter((i) => i.organizationId === chat.organizationId);
        let client = null;
        for (const integ of orgIntegrations) {
          client = manager.getClient(integ.id);
          if (client) break;
        }
        if (!client) continue;

        try {
          const chatId = parseInt(chat.externalChatId, 10);
          if (isNaN(chatId)) continue;

          // getParticipants fetches users with their full info (including access_hash)
          const participants = await Promise.race([
            client.getParticipants(chatId, { limit: 500 }),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 60000)),
          ]);

          for (const p of participants) {
            if (p instanceof Api.User) {
              const name = [p.firstName, p.lastName].filter(Boolean).join(' ');
              if (name) {
                nameMap.set(p.id.toString(), name);
              }
            }
          }
        } catch (e) {
          errors.push(`chat ${chat.externalChatId}: ${String(e).substring(0, 80)}`);
          // For chats where getParticipants fails (e.g. channels), try getMessages to get sender info
          try {
            const chatId = parseInt(chat.externalChatId, 10);
            if (isNaN(chatId)) continue;
            // Fetch recent messages which include sender entities
            const msgs = await Promise.race([
              client.getMessages(chatId, { limit: 500 }),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 60000)),
            ]);
            for (const m of msgs) {
              const sender = (m as unknown as { _sender?: unknown })._sender;
              if (sender instanceof Api.User) {
                const name = [sender.firstName, sender.lastName].filter(Boolean).join(' ');
                if (name && sender.id) {
                  nameMap.set(sender.id.toString(), name);
                }
              }
            }
          } catch (e2) {
            errors.push(`chat ${chat.externalChatId} msgs: ${String(e2).substring(0, 80)}`);
          }
        }
      }

      // 4. Second pass: try getEntity for still-unresolved senders
      //    (the cache is now populated from getParticipants/getMessages)
      const allBadMessages = await prisma.message.findMany({
        where: {
          chat: { messenger: 'telegram' },
          isSelf: false,
          senderExternalId: { not: null },
          OR: [
            { senderName: 'Unknown' },
            { senderName: { startsWith: 'User ' } },
          ],
        },
        select: { senderExternalId: true, chat: { select: { organizationId: true } } },
        distinct: ['senderExternalId'],
      });

      for (const msg of allBadMessages) {
        const sid = msg.senderExternalId!;
        if (nameMap.has(sid)) continue; // already resolved

        // Find a client for this org
        const orgIntegrations = integrations.filter((i) => i.organizationId === msg.chat.organizationId);
        let client = null;
        for (const integ of orgIntegrations) {
          client = manager.getClient(integ.id);
          if (client) break;
        }
        if (!client) continue;

        try {
          const numId = parseInt(sid, 10);
          if (isNaN(numId)) continue;
          const entity = await Promise.race([
            client.getEntity(numId),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000)),
          ]);
          if (entity instanceof Api.User) {
            const name = [entity.firstName, entity.lastName].filter(Boolean).join(' ');
            if (name) nameMap.set(sid, name);
          } else if (entity && 'title' in (entity as unknown as Record<string, unknown>)) {
            const title = (entity as unknown as { title: string }).title;
            if (title) nameMap.set(sid, title);
          }
        } catch {
          // Still can't resolve — skip
        }
      }

      // 5. Bulk-update messages using the name map
      let resolved = 0;
      let updated = 0;

      for (const [senderId, name] of nameMap) {
        const result = await prisma.message.updateMany({
          where: {
            senderExternalId: senderId,
            OR: [
              { senderName: 'Unknown' },
              { senderName: { startsWith: 'User ' } },
            ],
          },
          data: { senderName: name },
        });
        if (result.count > 0) {
          resolved++;
          updated += result.count;
        }
      }

      // Also update chat names that are "Unknown"
      for (const [senderId, name] of nameMap) {
        await prisma.chat.updateMany({
          where: {
            messenger: 'telegram',
            OR: [
              { name: 'Unknown' },
              { name: { startsWith: 'User ' } },
            ],
            // Only update direct chats named after this sender
            externalChatId: senderId,
          },
          data: { name },
        });
      }

      return reply.send({
        chatsScanned: chatsWithBadNames.length,
        namesResolved: nameMap.size,
        sendersUpdated: resolved,
        messagesUpdated: updated,
        errors: errors.slice(0, 10),
      });
      } catch (err) {
        request.log.error(err, 'backfill-sender-names error');
        return reply.status(500).send({ error: 'Backfill failed', message: String(err) });
      }
    },
  );
}
