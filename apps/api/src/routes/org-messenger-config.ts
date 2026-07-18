// ─── Organization Messenger Config Routes ───
// Per-organization messenger app credentials (Task 4: e.g. Telegram API
// Hash/ID), managed by the org admin. Runtime resolution (see
// lib/platform-credentials.ts) prefers these over the global PlatformConfig,
// so each organization can run its own Telegram/Slack app.

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
import { authenticate } from '../middleware/auth.js';
import { requireMinRole, getOrgId } from '../middleware/rbac.js';
import { encryptCredentials } from '../lib/crypto.js';
import { getPlatformCredentials, invalidatePlatformCache } from '../lib/platform-credentials.js';
import { logActivity } from '../lib/activity-logger.js';
import { MESSENGER_PLATFORM_FIELDS } from '../lib/platform-constants.js';
import type { Messenger } from '../lib/platform-constants.js';

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

export default async function orgMessengerConfigRoutes(fastify: FastifyInstance): Promise<void> {
  const authPreHandlers = [authenticate, requireMinRole('admin')];

  // ─── GET /organizations/messenger-config ───
  // Status for every messenger in the caller's organization (never raw credentials).

  fastify.get(
    '/messenger-config',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      const rows = await prisma.orgMessengerConfig.findMany({ where: { organizationId } });
      const byMessenger = new Map(rows.map((r) => [r.messenger, r]));

      const results = await Promise.all(
        (Object.keys(MESSENGER_PLATFORM_FIELDS) as Messenger[])
          .filter((m) => MESSENGER_PLATFORM_FIELDS[m].length > 0)
          .map(async (messenger) => {
            const row = byMessenger.get(messenger);
            const result = await getPlatformCredentials(messenger, organizationId);

            let hint: string | undefined;
            if (row && result.credentials && result.source === 'organization') {
              hint = getCredentialHint(messenger, result.credentials);
            }

            return {
              messenger,
              configured: result.credentials !== null,
              // 'organization' = this org's own row; 'database'/'env' = falling
              // back to the platform-wide default; the admin hasn't set their own yet.
              source: result.source,
              enabled: row?.enabled ?? true,
              hint,
            };
          }),
      );

      return reply.send(results);
    },
  );

  // ─── PUT /organizations/messenger-config/:messenger ───

  fastify.put(
    '/messenger-config/:messenger',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      const params = messengerParamSchema.safeParse(request.params);
      if (!params.success) {
        return sendError(reply, 'VALIDATION_ERROR', 'Invalid messenger', 400);
      }
      const { messenger } = params.data;

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

      const creds: Record<string, string> = {};
      for (const [key, val] of Object.entries(body.data as Record<string, unknown>)) {
        creds[key] = String(val);
      }

      const encrypted = encryptCredentials(creds);

      await prisma.orgMessengerConfig.upsert({
        where: { organizationId_messenger: { organizationId, messenger } },
        create: {
          organizationId,
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

      invalidatePlatformCache(messenger, organizationId);

      await logActivity({
        category: 'settings',
        action: 'org_messenger_config_updated',
        description: `Messenger credentials updated for ${messenger}`,
        targetType: 'OrgMessengerConfig',
        targetId: messenger,
        userId: request.user.id,
        userName: request.user.name,
        organizationId,
        metadata: { messenger },
      });

      return reply.send({
        messenger,
        configured: true,
        source: 'organization',
        enabled: true,
        hint: getCredentialHint(messenger as Messenger, creds),
      });
    },
  );

  // ─── DELETE /organizations/messenger-config/:messenger ───
  // Removes the org's own credentials — resolution falls back to the global
  // PlatformConfig (or env), never leaving the messenger fully unconfigured
  // unless nothing was ever set up anywhere.

  fastify.delete(
    '/messenger-config/:messenger',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      const params = messengerParamSchema.safeParse(request.params);
      if (!params.success) {
        return sendError(reply, 'VALIDATION_ERROR', 'Invalid messenger', 400);
      }
      const { messenger } = params.data;

      await prisma.orgMessengerConfig.deleteMany({ where: { organizationId, messenger } });
      invalidatePlatformCache(messenger, organizationId);

      await logActivity({
        category: 'settings',
        action: 'org_messenger_config_deleted',
        description: `Messenger credentials removed for ${messenger}`,
        targetType: 'OrgMessengerConfig',
        targetId: messenger,
        userId: request.user.id,
        userName: request.user.name,
        organizationId,
        metadata: { messenger },
      });

      const fallback = await getPlatformCredentials(messenger);
      return reply.send({
        messenger,
        configured: fallback.credentials !== null,
        source: fallback.source,
      });
    },
  );
}
