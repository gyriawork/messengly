import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
import { encryptCredentials, decryptCredentials } from '../lib/crypto.js';
import { authenticate } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { createAdapter } from '../integrations/factory.js';
import { MessengerError } from '../integrations/base.js';
// These imports may fail on some environments if native deps are missing
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createAuthClient: any, storePendingAuth: any, getPendingAuth: any, removePendingAuth: any, TelegramAdapter: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let StringSession: any, Api: any, computeCheck: any;
import { startWhatsAppPairing, getQrCode, getPairingStatus, cancelPairing, WhatsAppAdapter } from '../integrations/whatsapp.js';
import { teamsAgent, TeamsAgentError } from '../lib/teams-client.js';

import { getTelegramManager } from '../services/telegram-connection-manager.js';
import { getIO } from '../websocket/index.js';
import { cacheGet, cacheSet, cacheInvalidate, cacheKey } from '../lib/cache.js';
import { getPlatformCredentials } from '../lib/platform-credentials.js';
import { MESSENGERS } from '../lib/platform-constants.js';
import QRCode from 'qrcode';

// ─── Telegram QR-login sessions (in-memory, keyed by userId) ───
// QR login needs no verification code: the user scans a QR with their phone and
// Telegram authorizes the new session. We hold the live auth client here while
// the user scans. Single API instance (Railway) makes the in-memory map fine.
interface QrLoginState {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any;
  status: 'pending' | 'connected' | 'error';
  qrDataUrl?: string;
  error?: string;
  needs2FA: boolean;
  passwordResolver?: (pw: string) => void;
  organizationId: string;
}
const qrLogins = new Map<string, QrLoginState>();

// ─── Zod Schemas ───

const messengerParamSchema = z.object({
  messenger: z.enum(['telegram', 'slack', 'whatsapp', 'gmail', 'teams']),
});

const connectTelegramSchema = z.object({
  apiId: z.coerce.number().int().positive(),
  apiHash: z.string().min(1),
  session: z.string().optional(),
  phoneNumber: z.string().optional(),
});

const connectSlackSchema = z.object({
  token: z.string().min(1),
});

const connectWhatsAppSchema = z.object({
  wahaSessionName: z.string().min(1),
  phoneNumber: z.string().optional(),
});

const connectGmailSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  refreshToken: z.string().min(1),
});

const updateSettingsSchema = z.object({
  settings: z.record(z.unknown()),
});

// ─── Telegram multi-step auth schemas ───

const telegramSendCodeSchema = z.object({
  phoneNumber: z.string().min(1, 'Phone number is required'),
});

const telegramVerifyCodeSchema = z.object({
  phoneNumber: z.string().min(1),
  phoneCodeHash: z.string().min(1),
  code: z.string().min(1, 'Verification code is required'),
  password: z.string().optional(),
});

// Connect Telegram with a pre-generated user session key (StringSession).
// This is the primary connect method: the one-time login is done off-server
// (where login codes arrive), and the resulting key is pasted here.
const telegramConnectSessionSchema = z.object({
  session: z.string().min(1, 'Session key is required'),
  phoneNumber: z.string().optional(),
});

// Map messenger to its credential schema
const credentialSchemas: Record<string, z.ZodType> = {
  telegram: connectTelegramSchema,
  slack: connectSlackSchema,
  whatsapp: connectWhatsAppSchema,
  gmail: connectGmailSchema,
  // Teams carries no credentials: the sidecar owns the browser session.
  // connect() simply asserts that the session is alive.
  teams: z.object({}),
};

// ─── Helpers ───

function sendError(reply: FastifyReply, code: string, message: string, statusCode: number) {
  return reply.status(statusCode).send({
    error: { code, message, statusCode },
  });
}

function getOrgId(request: FastifyRequest): string | null {
  if (request.user.role === 'superadmin') {
    const query = request.query as Record<string, string>;
    return query.organizationId ?? request.user.organizationId;
  }
  return request.user.organizationId;
}

/** Return a safe integration object without raw credentials. */
function sanitizeIntegration(integration: {
  id: string;
  messenger: string;
  status: string;
  settings: unknown;
  organizationId: string;
  userId: string;
  connectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  syncStatus?: string | null;
  syncTotalChats?: number | null;
  syncCompletedChats?: number | null;
  syncStartedAt?: Date | null;
  syncError?: string | null;
}) {
  return {
    id: integration.id,
    messenger: integration.messenger,
    status: integration.status,
    settings: integration.settings,
    organizationId: integration.organizationId,
    userId: integration.userId,
    connectedAt: integration.connectedAt,
    createdAt: integration.createdAt,
    updatedAt: integration.updatedAt,
    syncStatus: integration.syncStatus ?? 'idle',
    syncTotalChats: integration.syncTotalChats ?? null,
    syncCompletedChats: integration.syncCompletedChats ?? null,
    syncStartedAt: integration.syncStartedAt ?? null,
    syncError: integration.syncError ?? null,
  };
}

// ─── Plugin ───

export default async function integrationRoutes(fastify: FastifyInstance): Promise<void> {
  // Load telegram inside plugin (not at module level) to avoid crashing if native deps fail
  try {
    const tgMod = await import('../integrations/telegram.js');
    createAuthClient = tgMod.createAuthClient;
    storePendingAuth = tgMod.storePendingAuth;
    getPendingAuth = tgMod.getPendingAuth;
    removePendingAuth = tgMod.removePendingAuth;
    TelegramAdapter = tgMod.TelegramAdapter;

    const sessions = await import('telegram/sessions/index.js');
    StringSession = sessions.StringSession;
    const apiMod = await import('telegram');
    Api = apiMod.Api;
    const pwMod = await import('telegram/Password.js');
    computeCheck = pwMod.computeCheck;
  } catch (e) {
    console.warn('Telegram integration unavailable:', (e as Error).message);
  }

  // Managing messenger access (connect / disconnect / pairing / import) is
  // superadmin-only. Regular users never configure messengers — they only
  // broadcast. Read-only status endpoints stay open to any authenticated user.
  const authPreHandlers = [authenticate, requireRole('superadmin')];
  const readPreHandlers = [authenticate];

  // ─── GET /integrations/available ───
  // Returns which messengers are available (platform credentials configured) vs unavailable.

  fastify.get(
    '/integrations/available',
    { preHandler: readPreHandlers },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const available: string[] = [];
      const unavailable: string[] = [];

      await Promise.all(
        MESSENGERS.map(async (messenger) => {
          const result = await getPlatformCredentials(messenger);
          if (result.source === 'none_required' || result.credentials !== null) {
            available.push(messenger);
          } else {
            unavailable.push(messenger);
          }
        }),
      );

      return reply.send({ available, unavailable });
    },
  );

  // ─── GET /integrations ───
  // List all integrations for the current organization.

  fastify.get(
    '/integrations',
    { preHandler: readPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      // Org-level: every member sees the organization's connected accounts so
      // regular users can import chats from messengers the superadmin connected.
      const ck = cacheKey(organizationId, 'integrations');
      const cached = await cacheGet(ck);
      if (cached) {
        return reply.send(cached);
      }

      const where: Record<string, unknown> = { organizationId };

      const integrations = await prisma.integration.findMany({
        where,
        orderBy: { createdAt: 'desc' },
      });

      const response = {
        integrations: integrations.map(sanitizeIntegration),
      };
      await cacheSet(ck, response, 300);

      return reply.send(response);
    },
  );

  // ─── POST /integrations/:messenger/connect ───
  // Connect a new messenger integration.

  fastify.post(
    '/integrations/:messenger/connect',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsParsed = messengerParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', 'Invalid messenger type', 422);
      }

      const { messenger } = paramsParsed.data;
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      // Validate credentials based on messenger type
      const credentialSchema = credentialSchemas[messenger];
      if (!credentialSchema) {
        return sendError(reply, 'VALIDATION_ERROR', `Unknown messenger: ${messenger}`, 422);
      }

      const bodyParsed = credentialSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        const issues = (bodyParsed as { success: false; error: z.ZodError }).error.issues;
        return sendError(
          reply,
          'VALIDATION_ERROR',
          issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          422,
        );
      }

      const credentials = bodyParsed.data as Record<string, unknown>;

      // Check if integration already exists for this messenger + org + user
      const existing = await prisma.integration.findUnique({
        where: {
          messenger_organizationId_userId: {
            messenger,
            organizationId,
            userId: request.user.id,
          },
        },
      });

      // Try to connect using the adapter to verify credentials
      const adapter = await createAdapter(messenger, credentials);
      try {
        await adapter.connect();
      } catch (err) {
        try { await adapter.disconnect(); } catch (e) { request.log.warn(e, 'adapter disconnect error'); }
        const message =
          err instanceof MessengerError
            ? err.message
            : `Failed to connect to ${messenger}`;
        return sendError(reply, 'MESSENGER_API_ERROR', message, 502);
      }

      // Encrypt credentials before storing
      const encryptedCredentials = encryptCredentials(credentials);

      let integration;

      try {
        if (existing) {
          // Update existing integration
          integration = await prisma.integration.update({
            where: { id: existing.id },
            data: {
              credentials: encryptedCredentials,
              status: 'connected',
              connectedAt: new Date(),
            },
          });
        } else {
          // Create new integration
          integration = await prisma.integration.create({
            data: {
              messenger,
              status: 'connected',
              credentials: encryptedCredentials,
              organizationId,
              userId: request.user.id,
              connectedAt: new Date(),
            },
          });
        }
      } catch (err) {
        try { await adapter.disconnect(); } catch (e) { request.log.warn(e, 'adapter disconnect error'); }
        throw err;
      }

      // Adapter verification is done; disconnect it (persistent listeners use their own connections)
      try { await adapter.disconnect(); } catch (e) { request.log.warn(e, 'adapter disconnect error'); }

      await cacheInvalidate(cacheKey(organizationId, 'integrations'));
      await cacheInvalidate(cacheKey(organizationId, 'integrations', `u:${request.user.id}`));

      // Notify frontend immediately so the status badge updates without waiting for cache
      try {
        getIO().to(`org:${organizationId}`).emit('integration_status_changed', { messenger, status: 'connected' });
      } catch { /* socket not ready yet — non-critical */ }

      // Start persistent listener for Telegram
      if (messenger === 'telegram') {
        getTelegramManager().startListening(integration.id).catch((err) => {
          fastify.log.warn({ err }, 'Failed to start Telegram listener after connect');
        });
      }

      return reply.status(201).send({
        integration: sanitizeIntegration(integration),
      });
    },
  );

  // ─── POST /integrations/:messenger/disconnect ───
  // Disconnect a messenger integration.

  fastify.post(
    '/integrations/:messenger/disconnect',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsParsed = messengerParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', 'Invalid messenger type', 422);
      }

      const { messenger } = paramsParsed.data;
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      const integration = await prisma.integration.findFirst({
        where: { messenger, organizationId, userId: request.user.id },
      });

      if (!integration) {
        return sendError(
          reply,
          'RESOURCE_NOT_FOUND',
          `No ${messenger} integration found for this user`,
          404,
        );
      }

      // Graceful disconnect is best-effort — don't block on adapter failures
      try {
        const credentials = decryptCredentials(integration.credentials as string);
        const adapter = await createAdapter(messenger, credentials);
        await adapter.disconnect().catch(() => {});
      } catch {
        // Disconnect failures are not critical — we still mark as disconnected
      }

      // Stop persistent listener for Telegram
      if (messenger === 'telegram') {
        getTelegramManager().stopListening(integration.id).catch(() => {});
      }

      const updated = await prisma.integration.update({
        where: { id: integration.id },
        data: { status: 'disconnected' },
      });

      await cacheInvalidate(cacheKey(organizationId, 'integrations'));
      await cacheInvalidate(cacheKey(organizationId, 'integrations', `u:${request.user.id}`));

      return reply.send({
        integration: sanitizeIntegration(updated),
      });
    },
  );

  // ─── POST /integrations/:messenger/reconnect ───
  // Reconnect using existing stored credentials.

  fastify.post(
    '/integrations/:messenger/reconnect',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsParsed = messengerParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', 'Invalid messenger type', 422);
      }

      const { messenger } = paramsParsed.data;
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      const integration = await prisma.integration.findFirst({
        where: { messenger, organizationId, userId: request.user.id },
      });

      if (!integration) {
        return sendError(
          reply,
          'RESOURCE_NOT_FOUND',
          `No ${messenger} integration found for this user`,
          404,
        );
      }

      // Decrypt stored credentials
      let credentials: Record<string, unknown>;
      try {
        credentials = decryptCredentials(integration.credentials as string);
      } catch {
        return sendError(
          reply,
          'INTERNAL_ERROR',
          'Failed to decrypt stored credentials. Please reconnect with new credentials.',
          500,
        );
      }

      // Attempt reconnection
      const adapter = await createAdapter(messenger, credentials);
      try {
        await adapter.connect();
      } catch (err) {
        try { await adapter.disconnect(); } catch (e) { request.log.warn(e, 'adapter disconnect error'); }
        const status = adapter.getStatus();

        // Update status to reflect the failure reason
        await prisma.integration.update({
          where: { id: integration.id },
          data: { status },
        });

        const message =
          err instanceof MessengerError
            ? err.message
            : `Failed to reconnect to ${messenger}`;
        return sendError(reply, 'MESSENGER_API_ERROR', message, 502);
      }

      let updated;
      try {
        updated = await prisma.integration.update({
          where: { id: integration.id },
          data: {
            status: 'connected',
            connectedAt: new Date(),
          },
        });
      } catch (err) {
        try { await adapter.disconnect(); } catch (e) { request.log.warn(e, 'adapter disconnect error'); }
        throw err;
      }

      // Adapter verification is done; disconnect it (persistent listeners use their own connections)
      try { await adapter.disconnect(); } catch (e) { request.log.warn(e, 'adapter disconnect error'); }

      await cacheInvalidate(cacheKey(organizationId, 'integrations'));
      await cacheInvalidate(cacheKey(organizationId, 'integrations', `u:${request.user.id}`));

      // Notify frontend immediately so the status badge updates without waiting for cache
      try {
        getIO().to(`org:${organizationId}`).emit('integration_status_changed', { messenger, status: 'connected' });
      } catch { /* socket not ready yet — non-critical */ }

      // Start persistent listener for Telegram
      if (messenger === 'telegram') {
        getTelegramManager().startListening(updated.id).catch((err) => {
          fastify.log.warn({ err }, 'Failed to start Telegram listener after reconnect');
        });
      }

      return reply.send({
        integration: sanitizeIntegration(updated),
      });
    },
  );

  // ─── POST /integrations/:messenger/resync ───
  // Re-queue the initial-sync job (used by the overlay "Retry" button when the
  // previous sync failed mid-way).

  fastify.post(
    '/integrations/:messenger/resync',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsParsed = messengerParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', 'Invalid messenger type', 422);
      }

      const { messenger } = paramsParsed.data;
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      const integration = await prisma.integration.findFirst({
        where: { messenger, organizationId, userId: request.user.id },
      });

      if (!integration) {
        return sendError(
          reply,
          'RESOURCE_NOT_FOUND',
          `No ${messenger} integration found for this user`,
          404,
        );
      }

      // Resync is now handled via the import-with-history flow
      return reply.send({ message: 'Use POST /chats/import-with-history to import chats' });
    },
  );

  // ─── POST /integrations/telegram/send-code ───
  // Step 1 of Telegram auth: send verification code to phone.

  fastify.post(
    '/integrations/telegram/send-code',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const bodyParsed = telegramSendCodeSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        const issues = bodyParsed.error.issues;
        return sendError(
          reply,
          'VALIDATION_ERROR',
          issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          422,
        );
      }

      const { phoneNumber } = bodyParsed.data;

      // Resolve platform credentials (apiId, apiHash)
      const platformResult = await getPlatformCredentials('telegram');
      if (!platformResult.credentials) {
        return sendError(
          reply,
          'VALIDATION_ERROR',
          'Telegram is not configured. Ask your administrator to set up Telegram API credentials.',
          400,
        );
      }
      const apiId = Number(platformResult.credentials.apiId);
      const apiHash = platformResult.credentials.apiHash;

      let client;
      try {
        client = createAuthClient(apiId, apiHash);
        await client.connect();
      } catch (err) {
        return sendError(
          reply,
          'MESSENGER_API_ERROR',
          err instanceof Error ? err.message : 'Failed to connect to Telegram servers',
          502,
        );
      }

      try {
        const sendResult = await client.sendCode(
          { apiId, apiHash },
          phoneNumber,
        );

        // Observability: which delivery channel did Telegram choose? App =
        // code sent inside the Telegram app (service chat) to active sessions;
        // Sms/Call = sent to the phone. Helps diagnose "code not arriving".
        const sentType = (sendResult as { type?: { className?: string } }).type?.className;
        const nextType = (sendResult as { nextType?: { className?: string } }).nextType?.className;
        request.log.info(
          { telegramSendCode: { sentType, nextType, timeout: (sendResult as { timeout?: number }).timeout } },
          'Telegram sendCode dispatched',
        );

        // Store the client for step 2
        await storePendingAuth(request.user.id, phoneNumber, client, apiId, apiHash);

        return reply.send({
          phoneCodeHash: sendResult.phoneCodeHash,
          phoneNumber,
          // Surfaced so the UI can tell the user where to look for the code.
          deliveryType: sentType,
        });
      } catch (err) {
        await client.disconnect().catch(() => {});
        return sendError(
          reply,
          'MESSENGER_API_ERROR',
          err instanceof Error ? err.message : 'Failed to send verification code',
          502,
        );
      }
    },
  );

  // ─── POST /integrations/telegram/verify-code ───
  // Step 2 of Telegram auth: verify code (and optional 2FA password).

  fastify.post(
    '/integrations/telegram/verify-code',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const bodyParsed = telegramVerifyCodeSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        const issues = bodyParsed.error.issues;
        return sendError(
          reply,
          'VALIDATION_ERROR',
          issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          422,
        );
      }

      const { phoneNumber, phoneCodeHash, code, password } = bodyParsed.data;
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      const pending = await getPendingAuth(request.user.id, phoneNumber);
      if (!pending) {
        return sendError(
          reply,
          'VALIDATION_ERROR',
          'No pending Telegram auth session found. Please start over by sending a new code.',
          422,
        );
      }

      const { client, apiId, apiHash } = pending;

      try {
        // Try to sign in with the code using low-level API
        try {
          await client.invoke(
            new Api.auth.SignIn({
              phoneNumber,
              phoneCodeHash,
              phoneCode: code,
            }),
          );
        } catch (signInErr: unknown) {
          // Check if 2FA is required
          const errMessage = signInErr instanceof Error ? signInErr.message : String(signInErr);
          if (errMessage.includes('SESSION_PASSWORD_NEEDED')) {
            if (!password) {
              return reply.status(400).send({
                error: {
                  code: 'TELEGRAM_2FA_REQUIRED',
                  message: 'Two-factor authentication password is required',
                  statusCode: 400,
                },
              });
            }
            // Get the SRP password parameters and compute the check
            const srpPassword = await client.invoke(new Api.account.GetPassword());
            const srpResult = await computeCheck(srpPassword, password);
            await client.invoke(new Api.auth.CheckPassword({ password: srpResult }));
          } else {
            throw signInErr;
          }
        }

        // Auth succeeded — extract session string
        const sessionString = (client.session as typeof StringSession.prototype).save();

        // Clean up pending auth
        await removePendingAuth(request.user.id, phoneNumber);

        // Store only user-level credentials (session + phone).
        // Platform credentials (apiId/apiHash) are resolved at runtime via getPlatformCredentials.
        const credentials = {
          session: sessionString,
          phoneNumber,
        };
        const encryptedCredentials = encryptCredentials(credentials);

        // Upsert integration
        const existing = await prisma.integration.findUnique({
          where: {
            messenger_organizationId_userId: {
              messenger: 'telegram',
              organizationId,
              userId: request.user.id,
            },
          },
        });

        let integration;
        if (existing) {
          integration = await prisma.integration.update({
            where: { id: existing.id },
            data: {
              credentials: encryptedCredentials,
              status: 'connected',
              connectedAt: new Date(),
            },
          });
        } else {
          integration = await prisma.integration.create({
            data: {
              messenger: 'telegram',
              status: 'connected',
              credentials: encryptedCredentials,
              organizationId,
              userId: request.user.id,
              connectedAt: new Date(),
            },
          });
        }

        // Disconnect the auth client (a new one will be created when needed)
        await client.disconnect().catch(() => {});

        // Invalidate server-side cache so the next API fetch returns fresh status
        await cacheInvalidate(cacheKey(organizationId, 'integrations'));
        await cacheInvalidate(cacheKey(organizationId, 'integrations', `u:${request.user.id}`));

        // Notify frontend immediately so the status badge updates
        try {
          getIO().to(`org:${organizationId}`).emit('integration_status_changed', { messenger: 'telegram', status: 'connected' });
        } catch { /* socket not ready yet — non-critical */ }

        // Start persistent listener for incoming messages
        getTelegramManager().startListening(integration.id).catch((err) => {
          fastify.log.warn({ err }, 'Failed to start Telegram listener after verify-code');
        });

        return reply.status(201).send({
          integration: sanitizeIntegration(integration),
        });
      } catch (err) {
        return sendError(
          reply,
          'MESSENGER_API_ERROR',
          err instanceof Error ? err.message : 'Failed to verify Telegram code',
          502,
        );
      }
    },
  );

  // ─── POST /integrations/telegram/connect-session ───
  // Primary Telegram connect: validate a pre-generated user session key
  // (StringSession) and store it. The one-time phone+code login is performed
  // off-server with scripts/generate-telegram-session.ts, where login codes are
  // delivered reliably; only the resulting key is pasted here.

  fastify.post(
    '/integrations/telegram/connect-session',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const bodyParsed = telegramConnectSessionSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return sendError(
          reply,
          'VALIDATION_ERROR',
          bodyParsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          422,
        );
      }

      const { session, phoneNumber } = bodyParsed.data;
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      // Validate the key by connecting (apiId/apiHash resolved from platform config).
      let adapter;
      try {
        adapter = await createAdapter('telegram', { session });
        await adapter.connect();
      } catch (err) {
        return sendError(
          reply,
          'MESSENGER_API_ERROR',
          err instanceof Error ? err.message : 'Invalid or expired Telegram session key',
          502,
        );
      }

      try {
        const encryptedCredentials = encryptCredentials({ session, phoneNumber: phoneNumber ?? '' });

        const existing = await prisma.integration.findUnique({
          where: {
            messenger_organizationId_userId: {
              messenger: 'telegram',
              organizationId,
              userId: request.user.id,
            },
          },
        });

        let integration;
        if (existing) {
          integration = await prisma.integration.update({
            where: { id: existing.id },
            data: { credentials: encryptedCredentials, status: 'connected', connectedAt: new Date() },
          });
        } else {
          integration = await prisma.integration.create({
            data: {
              messenger: 'telegram',
              status: 'connected',
              credentials: encryptedCredentials,
              organizationId,
              userId: request.user.id,
              connectedAt: new Date(),
            },
          });
        }

        await adapter.disconnect().catch(() => {});

        await cacheInvalidate(cacheKey(organizationId, 'integrations'));
        await cacheInvalidate(cacheKey(organizationId, 'integrations', `u:${request.user.id}`));

        try {
          getIO().to(`org:${organizationId}`).emit('integration_status_changed', { messenger: 'telegram', status: 'connected' });
        } catch { /* socket not ready — non-critical */ }

        getTelegramManager().startListening(integration.id).catch((err) => {
          fastify.log.warn({ err }, 'Failed to start Telegram listener after connect-session');
        });

        return reply.status(201).send({ integration: sanitizeIntegration(integration) });
      } catch (err) {
        await adapter.disconnect().catch(() => {});
        return sendError(
          reply,
          'INTERNAL_ERROR',
          err instanceof Error ? err.message : 'Failed to store Telegram session',
          500,
        );
      }
    },
  );

  // ─── POST /integrations/telegram/qr/start ───
  // Primary Telegram connect: start a QR login. No verification code is used —
  // the user scans the QR with the Telegram app and the session is authorized.

  fastify.post(
    '/integrations/telegram/qr/start',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      const platform = await getPlatformCredentials('telegram');
      if (!platform.credentials) {
        return sendError(
          reply,
          'VALIDATION_ERROR',
          'Telegram is not configured. Ask your administrator to set up Telegram API credentials.',
          400,
        );
      }
      const apiId = Number(platform.credentials.apiId);
      const apiHash = platform.credentials.apiHash as string;
      const userId = request.user.id;

      // Clean up any previous QR session for this user.
      const prev = qrLogins.get(userId);
      if (prev) {
        prev.client?.disconnect?.().catch(() => {});
        qrLogins.delete(userId);
      }

      let client;
      try {
        client = createAuthClient(apiId, apiHash);
        await client.connect();
      } catch (err) {
        return sendError(
          reply,
          'MESSENGER_API_ERROR',
          err instanceof Error ? err.message : 'Failed to connect to Telegram servers',
          502,
        );
      }

      const state: QrLoginState = { client, status: 'pending', needs2FA: false, organizationId };
      qrLogins.set(userId, state);

      // Drive the QR login in the background; frontend polls /qr/status.
      void (async () => {
        try {
          await client.signInUserWithQrCode(
            { apiId, apiHash },
            {
              qrCode: async (code: { token: Buffer }) => {
                const url = `tg://login?token=${Buffer.from(code.token).toString('base64url')}`;
                state.qrDataUrl = await QRCode.toDataURL(url, { width: 280, margin: 1 });
                state.needs2FA = false;
              },
              password: async () => {
                state.needs2FA = true;
                return await new Promise<string>((resolve) => {
                  state.passwordResolver = resolve;
                });
              },
              onError: (err: Error) => {
                state.status = 'error';
                state.error = err?.message ?? 'QR login error';
                return true;
              },
            },
          );

          // Authorized — persist the session string.
          const sessionString = (client.session as { save: () => string }).save();
          const encryptedCredentials = encryptCredentials({ session: sessionString, phoneNumber: '' });

          const existing = await prisma.integration.findUnique({
            where: { messenger_organizationId_userId: { messenger: 'telegram', organizationId, userId } },
          });
          let integration;
          if (existing) {
            integration = await prisma.integration.update({
              where: { id: existing.id },
              data: { credentials: encryptedCredentials, status: 'connected', connectedAt: new Date() },
            });
          } else {
            integration = await prisma.integration.create({
              data: {
                messenger: 'telegram',
                status: 'connected',
                credentials: encryptedCredentials,
                organizationId,
                userId,
                connectedAt: new Date(),
              },
            });
          }

          state.status = 'connected';
          state.needs2FA = false;
          await client.disconnect().catch(() => {});

          await cacheInvalidate(cacheKey(organizationId, 'integrations'));
          await cacheInvalidate(cacheKey(organizationId, 'integrations', `u:${userId}`));
          try {
            getIO().to(`org:${organizationId}`).emit('integration_status_changed', { messenger: 'telegram', status: 'connected' });
          } catch { /* socket not ready — non-critical */ }
          getTelegramManager().startListening(integration.id).catch((err) => {
            fastify.log.warn({ err }, 'Failed to start Telegram listener after QR login');
          });
        } catch (err) {
          state.status = 'error';
          state.error = err instanceof Error ? err.message : 'QR login failed';
          await client.disconnect().catch(() => {});
        }
      })();

      return reply.send({ status: 'pending' });
    },
  );

  // ─── GET /integrations/telegram/qr/status ───
  fastify.get(
    '/integrations/telegram/qr/status',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const state = qrLogins.get(request.user.id);
      if (!state) {
        return reply.send({ status: 'idle' });
      }
      return reply.send({
        status: state.status,
        qr: state.qrDataUrl,
        needs2FA: state.needs2FA,
        error: state.error,
      });
    },
  );

  // ─── POST /integrations/telegram/qr/2fa ───
  // Supply the 2FA password when a QR login reports needs2FA.
  fastify.post(
    '/integrations/telegram/qr/2fa',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = z.object({ password: z.string().min(1) }).safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', 'Password is required', 422);
      }
      const state = qrLogins.get(request.user.id);
      if (!state || !state.passwordResolver) {
        return sendError(reply, 'VALIDATION_ERROR', 'No pending 2FA step for this session', 422);
      }
      const resolver = state.passwordResolver;
      state.passwordResolver = undefined;
      state.needs2FA = false;
      resolver(parsed.data.password);
      return reply.send({ status: 'pending' });
    },
  );

  // ─── POST /integrations/telegram/check-session ───
  // Check if the stored Telegram session is still valid.

  fastify.post(
    '/integrations/telegram/check-session',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      const integration = await prisma.integration.findFirst({
        where: {
          messenger: 'telegram',
          organizationId,
          userId: request.user.id,
        },
      });

      if (!integration) {
        return reply.send({ valid: false, reason: 'No Telegram integration found' });
      }

      let credentials;
      try {
        credentials = decryptCredentials(integration.credentials as string);
      } catch {
        return reply.send({ valid: false, reason: 'Failed to decrypt credentials' });
      }

      const adapter = new TelegramAdapter(
        credentials as { apiId: number; apiHash: string; session?: string },
      );

      try {
        await adapter.connect();
        await adapter.disconnect();

        // Update status to connected if it was different
        if (integration.status !== 'connected') {
          await prisma.integration.update({
            where: { id: integration.id },
            data: { status: 'connected' },
          });
        }

        return reply.send({ valid: true });
      } catch {
        // Update status
        await prisma.integration.update({
          where: { id: integration.id },
          data: { status: 'session_expired' },
        });

        return reply.send({ valid: false, reason: 'Session is no longer valid' });
      }
    },
  );

  // ─── PATCH /integrations/:messenger/settings ───
  // Update per-integration settings (e.g., Slack channels, notification prefs).

  fastify.patch(
    '/integrations/:messenger/settings',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsParsed = messengerParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', 'Invalid messenger type', 422);
      }

      const bodyParsed = updateSettingsSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return sendError(
          reply,
          'VALIDATION_ERROR',
          bodyParsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          422,
        );
      }

      const { messenger } = paramsParsed.data;
      const { settings } = bodyParsed.data;
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      const integration = await prisma.integration.findFirst({
        where: { messenger, organizationId, userId: request.user.id },
      });

      if (!integration) {
        return sendError(
          reply,
          'RESOURCE_NOT_FOUND',
          `No ${messenger} integration found for this user`,
          404,
        );
      }

      const updated = await prisma.integration.update({
        where: { id: integration.id },
        data: { settings: settings as Prisma.InputJsonValue },
      });

      return reply.send({
        integration: sanitizeIntegration(updated),
      });
    },
  );

  // ─── POST /integrations/whatsapp/start-pairing ───
  // Start the WhatsApp QR code pairing flow via WAHA.
  // QR code is returned directly in the HTTP response.

  fastify.post(
    '/integrations/whatsapp/start-pairing',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      const userId = request.user.id;
      const webhookUrl = `${process.env.API_URL || 'http://localhost:3001'}/api/webhooks/waha`;

      try {
        // startWhatsAppPairing returns the actual WAHA session name (e.g. 'default' for free tier)
        const actualSessionName = await startWhatsAppPairing(`wa-${organizationId.slice(0, 8)}-${userId.slice(0, 8)}`, webhookUrl);

        // Wait for WAHA to initialize the session
        await new Promise((r) => setTimeout(r, 3000));

        // Try to get the QR code using the actual session name
        let qr = await getQrCode(actualSessionName);

        // If QR is not ready yet, wait a bit more and retry
        if (!qr) {
          await new Promise((r) => setTimeout(r, 2000));
          qr = await getQrCode(actualSessionName);
        }

        return reply.send({
          sessionName: actualSessionName,
          qr: qr?.value || null,
          mimetype: qr?.mimetype || null,
        });
      } catch (err) {
        return sendError(
          reply,
          'MESSENGER_API_ERROR',
          err instanceof Error ? err.message : 'Failed to start WhatsApp pairing',
          502,
        );
      }
    },
  );

  // ─── GET /integrations/whatsapp/pairing-status ───
  // Poll the current status of a WhatsApp pairing session.
  // When WORKING, auto-saves the integration record.

  fastify.get(
    '/integrations/whatsapp/pairing-status',
    { preHandler: readPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      const { sessionName } = request.query as { sessionName?: string };
      if (!sessionName) {
        return sendError(reply, 'VALIDATION_ERROR', 'sessionName query parameter is required', 422);
      }

      const userId = request.user.id;

      try {
        const status = await getPairingStatus(sessionName);

        if (status === 'SCAN_QR_CODE') {
          // Session is waiting for QR scan — return fresh QR
          const qr = await getQrCode(sessionName);
          return reply.send({
            status,
            qr: qr?.value || null,
            mimetype: qr?.mimetype || null,
          });
        }

        if (status === 'WORKING') {
          // Session is connected — save integration
          const wahaClient = new (await import('../lib/waha-client.js')).WahaClient();
          const sessionInfo = await wahaClient.getSession(sessionName);
          const phoneNumber = sessionInfo.me?.id || undefined;

          const encryptedCredentials = encryptCredentials({
            wahaSessionName: sessionName,
            phoneNumber,
          });

          const whatsappIntegration = await prisma.integration.upsert({
            where: {
              messenger_organizationId_userId: {
                messenger: 'whatsapp',
                organizationId,
                userId,
              },
            },
            update: {
              credentials: encryptedCredentials,
              settings: { wahaSessionName: sessionName },
              status: 'connected',
              connectedAt: new Date(),
            },
            create: {
              messenger: 'whatsapp',
              status: 'connected',
              credentials: encryptedCredentials,
              settings: { wahaSessionName: sessionName },
              organizationId,
              userId,
              connectedAt: new Date(),
            },
          });

          await cacheInvalidate(cacheKey(organizationId, 'integrations'));
      await cacheInvalidate(cacheKey(organizationId, 'integrations', `u:${request.user.id}`));

          // Notify frontend immediately so the status badge updates
          try {
            getIO().to(`org:${organizationId}`).emit('integration_status_changed', { messenger: 'whatsapp', status: 'connected' });
          } catch { /* socket not ready yet — non-critical */ }

          return reply.send({ status: 'connected' });
        }

        if (status === 'FAILED' || status === 'STOPPED') {
          return reply.send({ status: 'failed', error: 'WhatsApp session failed' });
        }

        // For other statuses (STARTING, etc.)
        return reply.send({ status });
      } catch (err) {
        return sendError(
          reply,
          'MESSENGER_API_ERROR',
          err instanceof Error ? err.message : 'Failed to get WhatsApp pairing status',
          502,
        );
      }
    },
  );

  // ─── POST /integrations/whatsapp/cancel-pairing ───
  // Cancel an active WhatsApp pairing session.

  fastify.post(
    '/integrations/whatsapp/cancel-pairing',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { sessionName } = request.body as { sessionName?: string };
      if (!sessionName) {
        return sendError(reply, 'VALIDATION_ERROR', 'sessionName is required', 422);
      }

      try {
        await cancelPairing(sessionName);
        return reply.send({ message: 'WhatsApp pairing cancelled' });
      } catch (err) {
        return sendError(
          reply,
          'MESSENGER_API_ERROR',
          err instanceof Error ? err.message : 'Failed to cancel WhatsApp pairing',
          502,
        );
      }
    },
  );

  // ─── POST /integrations/:messenger/list-chats ───
  // Fetch available chats from any connected messenger.
  // Returns chats directly in the HTTP response.

  fastify.post(
    '/integrations/:messenger/list-chats',
    { preHandler: readPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      const paramsParsed = messengerParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', 'Invalid messenger type', 422);
      }
      const { messenger } = paramsParsed.data;

      try {
        // Resolve the organization's connected integration (any member —
        // typically connected by the superadmin) so any user can list its chats.
        const integration = await prisma.integration.findFirst({
          where: { messenger, organizationId, status: 'connected' },
          orderBy: { createdAt: 'asc' },
        });

        if (!integration) {
          return sendError(
            reply,
            'RESOURCE_NOT_FOUND',
            `No connected ${messenger} account found. Ask your administrator to connect it first.`,
            404,
          );
        }

        if (integration.status !== 'connected') {
          return sendError(
            reply,
            'VALIDATION_ERROR',
            `${messenger} integration is not connected`,
            400,
          );
        }

        // Decrypt credentials and list chats via adapter
        const decrypted = decryptCredentials<Record<string, unknown>>(integration.credentials as string);
        const adapter = await createAdapter(messenger, decrypted);

        try {
          await adapter.connect();
          const chats = await adapter.listChats();
          return reply.send({ chats });
        } finally {
          try { await adapter.disconnect(); } catch (e) { fastify.log.warn(e, 'adapter disconnect error'); }
        }
      } catch (err) {
        return sendError(
          reply,
          'MESSENGER_API_ERROR',
          err instanceof MessengerError
            ? err.message
            : err instanceof Error
              ? err.message
              : `Failed to list ${messenger} chats`,
          502,
        );
      }
    },
  );

  // ─── Microsoft Teams ───
  //
  // Teams offers no OAuth and no API token for personal accounts. The teams-agent
  // sidecar holds one browser session for the whole system, and an operator creates
  // it by driving a streamed remote browser: we relay JPEG frames out and clicks and
  // keystrokes back, so a human can clear MFA with their own eyes.
  //
  // The Integration row only records that a session exists. The session itself lives
  // on the sidecar's volume — the same split as WhatsApp, where WAHA owns the session
  // and Messengly stores a pointer.

  async function upsertTeamsIntegration(organizationId: string, userId: string): Promise<void> {
    const credentials = encryptCredentials({
      status: 'connected',
      lastCheckAt: new Date().toISOString(),
    });

    await prisma.integration.upsert({
      where: { messenger_organizationId_userId: { messenger: 'teams', organizationId, userId } },
      update: { credentials, status: 'connected', connectedAt: new Date() },
      create: {
        messenger: 'teams',
        status: 'connected',
        credentials,
        organizationId,
        userId,
        connectedAt: new Date(),
      },
    });

    await cacheInvalidate(cacheKey(organizationId, 'integrations'));
    await cacheInvalidate(cacheKey(organizationId, 'integrations', `u:${userId}`));

    try {
      getIO().to(`org:${organizationId}`).emit('integration_status_changed', { messenger: 'teams', status: 'connected' });
    } catch { /* socket not ready yet — non-critical */ }
  }

  /** Agent errors the caller can act on stay 4xx; everything else is a bad gateway. */
  function sendTeamsAgentError(reply: FastifyReply, err: unknown) {
    if (err instanceof TeamsAgentError) {
      const statusCode = err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 502;
      return sendError(reply, err.code, err.message, statusCode);
    }
    return sendError(reply, 'MESSENGER_API_ERROR', err instanceof Error ? err.message : 'Teams agent error', 502);
  }

  // ─── GET /integrations/teams/status ───

  fastify.get(
    '/integrations/teams/status',
    { preHandler: readPreHandlers },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        return reply.send(await teamsAgent.getSessionStatus());
      } catch (err) {
        return sendTeamsAgentError(reply, err);
      }
    },
  );

  // ─── POST /integrations/teams/remote/start ───

  fastify.post(
    '/integrations/teams/remote/start',
    { preHandler: authPreHandlers },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        return reply.send(await teamsAgent.remoteStart());
      } catch (err) {
        return sendTeamsAgentError(reply, err);
      }
    },
  );

  // ─── GET /integrations/teams/remote/screenshot ───
  // Returns a JPEG frame. The agent auto-saves the session the moment it detects a
  // confirmed login, and reports that through the X-Logged-In header — so we persist
  // the Integration here rather than making the browser ask a second time.

  fastify.get(
    '/integrations/teams/remote/screenshot',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      try {
        const { image, loggedIn } = await teamsAgent.remoteScreenshot();
        if (loggedIn) await upsertTeamsIntegration(organizationId, request.user.id);

        return reply
          .header('Content-Type', 'image/jpeg')
          .header('Cache-Control', 'no-store')
          .header('X-Logged-In', loggedIn ? 'true' : 'false')
          .send(image);
      } catch (err) {
        return sendTeamsAgentError(reply, err);
      }
    },
  );

  // ─── POST /integrations/teams/remote/{click,type,key} ───

  const teamsClickSchema = z.object({ x: z.number(), y: z.number() });
  const teamsTypeSchema = z.object({ text: z.string().min(1).max(500) });
  const teamsKeySchema = z.object({ key: z.string().min(1) });

  fastify.post(
    '/integrations/teams/remote/click',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = teamsClickSchema.safeParse(request.body);
      if (!body.success) return sendError(reply, 'VALIDATION_ERROR', 'x and y must be numbers', 422);
      try {
        return reply.send(await teamsAgent.remoteClick(body.data.x, body.data.y));
      } catch (err) {
        return sendTeamsAgentError(reply, err);
      }
    },
  );

  fastify.post(
    '/integrations/teams/remote/type',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = teamsTypeSchema.safeParse(request.body);
      if (!body.success) return sendError(reply, 'VALIDATION_ERROR', 'text must be 1–500 characters', 422);
      try {
        return reply.send(await teamsAgent.remoteType(body.data.text));
      } catch (err) {
        return sendTeamsAgentError(reply, err);
      }
    },
  );

  fastify.post(
    '/integrations/teams/remote/key',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = teamsKeySchema.safeParse(request.body);
      if (!body.success) return sendError(reply, 'VALIDATION_ERROR', 'key is required', 422);
      try {
        return reply.send(await teamsAgent.remoteKey(body.data.key));
      } catch (err) {
        return sendTeamsAgentError(reply, err);
      }
    },
  );

  // ─── POST /integrations/teams/remote/save ───
  // Manual save. The agent refuses unless the chat list actually rendered, so a
  // signed-out session can never be persisted as "connected".

  fastify.post(
    '/integrations/teams/remote/save',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      try {
        const result = await teamsAgent.remoteSave();
        await upsertTeamsIntegration(organizationId, request.user.id);
        return reply.send(result);
      } catch (err) {
        return sendTeamsAgentError(reply, err);
      }
    },
  );

  // ─── POST /integrations/teams/remote/stop ───

  fastify.post(
    '/integrations/teams/remote/stop',
    { preHandler: authPreHandlers },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        return reply.send(await teamsAgent.remoteStop());
      } catch (err) {
        return sendTeamsAgentError(reply, err);
      }
    },
  );

  // ─── POST /integrations/teams/logout ───
  // Signs Teams out for the whole system and drops the stored session. The generic
  // /disconnect route only flips the Integration row; it cannot reach the sidecar.

  fastify.post(
    '/integrations/teams/logout',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      try {
        await teamsAgent.destroySession();
      } catch (err) {
        return sendTeamsAgentError(reply, err);
      }

      await prisma.integration.updateMany({
        where: { messenger: 'teams', organizationId },
        data: { status: 'disconnected' },
      });
      await cacheInvalidate(cacheKey(organizationId, 'integrations'));
      await cacheInvalidate(cacheKey(organizationId, 'integrations', `u:${request.user.id}`));

      try {
        getIO().to(`org:${organizationId}`).emit('integration_status_changed', { messenger: 'teams', status: 'disconnected' });
      } catch { /* socket not ready yet — non-critical */ }

      return reply.send({ disconnected: true });
    },
  );
}
