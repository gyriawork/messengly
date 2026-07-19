import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomBytes } from 'node:crypto';
import IORedis from 'ioredis';
import { google } from 'googleapis';
import prisma from '../lib/prisma.js';
import { encryptCredentials } from '../lib/crypto.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { createAdapter } from '../integrations/factory.js';
import { MessengerError } from '../integrations/base.js';
import { getPlatformCredentials } from '../lib/platform-credentials.js';
import { cacheInvalidate, cacheKey } from '../lib/cache.js';
import { getIO } from '../websocket/index.js';
import { logActivity } from '../lib/activity-logger.js';

/**
 * OAuth callbacks carry no `request.user` — the state token is the only
 * identity we have. Fire-and-forget; never blocks the redirect.
 */
function logOAuthConnected(organizationId: string, userId: string, messenger: string): void {
  prisma.user.findUnique({ where: { id: userId }, select: { name: true } }).then((user) => {
    if (!user) return;
    return logActivity({
      category: 'integrations',
      action: 'connected',
      description: `${user.name} connected ${messenger}`,
      targetType: 'integration',
      targetId: messenger,
      userId,
      userName: user.name,
      organizationId,
      metadata: { messenger },
    });
  }).catch(() => { /* non-critical */ });
}


// ─── Redis client for OAuth state storage ───

let redis: IORedis | null = null;

function getRedis(): IORedis {
  if (!redis) {
    redis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: null,
    });
    // Unhandled 'error' events crash the process; ioredis reconnects itself.
    redis.on('error', (err) => console.error('[oauth:redis] error:', err?.message ?? String(err)));
  }
  return redis;
}

// ─── Helpers ───

function getOrgId(request: FastifyRequest): string | null {
  if (request.user.role === 'superadmin') {
    const query = request.query as Record<string, string>;
    return query.organizationId ?? request.user.organizationId;
  }
  return request.user.organizationId;
}

/**
 * Scope for a newly-created Integration row (Task 3/4) — same rule as
 * routes/integrations.ts connectScopeFor(): admin+ connecting creates an
 * org-level shared connection; a plain `user` (gated by
 * canSelfConnectMessengers on the authorize route) always creates their own.
 */
function connectScopeFor(request: FastifyRequest): 'org' | 'user' {
  return request.user.role === 'user' ? 'user' : 'org';
}

/**
 * Same rule as routes/integrations.ts resolveConnectTarget() — kept as a
 * local copy since oauth.ts doesn't import from integrations.ts. `forUserId`
 * lets an admin+ connect on behalf of another org member; always a personal
 * (`scope: 'user'`) connection for the target, never available to a plain user.
 */
async function resolveConnectTarget(
  request: FastifyRequest,
  organizationId: string,
  forUserId: string | undefined,
): Promise<{ userId: string; scope: 'org' | 'user' } | { error: string }> {
  if (!forUserId || forUserId === request.user.id) {
    return { userId: request.user.id, scope: connectScopeFor(request) };
  }
  if (request.user.role === 'user') {
    return { error: 'Only an admin can connect a messenger on behalf of another user' };
  }
  const target = await prisma.user.findUnique({ where: { id: forUserId } });
  if (!target || target.organizationId !== organizationId || target.deletedAt) {
    return { error: 'Target user not found in this organization' };
  }
  return { userId: forUserId, scope: 'user' };
}

function getAppUrl(): string {
  return process.env.APP_URL ?? 'http://localhost:3000';
}

function getApiUrl(): string {
  return process.env.API_URL ?? `http://localhost:${process.env.PORT ?? '3001'}`;
}

async function getSlackPlatformCreds(organizationId?: string): Promise<{ clientId: string; clientSecret: string } | null> {
  const result = await getPlatformCredentials('slack', organizationId);
  if (!result.credentials) return null;
  const { clientId, clientSecret } = result.credentials;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * Custom auth handler for OAuth authorize endpoints.
 * Since the user is redirected via browser (not AJAX), the JWT
 * may come as a query parameter `?token=...` instead of an Authorization header.
 * We inject it into the Authorization header so the standard authenticate middleware works.
 */
async function authenticateOAuthRedirect(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const query = request.query as Record<string, string | undefined>;
  const tokenFromQuery = query.token;

  // If no Authorization header but token in query, inject it
  if (!request.headers.authorization && tokenFromQuery) {
    request.headers.authorization = `Bearer ${tokenFromQuery}`;
  }

  // Delegate to the standard authenticate middleware
  return authenticate(request, reply);
}

async function getGmailPlatformCreds(organizationId?: string): Promise<{ clientId: string; clientSecret: string; redirectUri: string } | null> {
  const result = await getPlatformCredentials('gmail', organizationId);
  if (!result.credentials) return null;
  const { clientId, clientSecret } = result.credentials;
  if (!clientId || !clientSecret) return null;
  const redirectUri =
    process.env.GMAIL_REDIRECT_URI ?? `${getApiUrl()}/api/oauth/gmail/callback`;
  return { clientId, clientSecret, redirectUri };
}

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
];

// ─── Plugin ───

export default async function oauthRoutes(fastify: FastifyInstance): Promise<void> {
  // ═══════════════════════════════════════════════════════════════
  // ─── Slack OAuth Routes ───
  // ═══════════════════════════════════════════════════════════════

  // ─── GET /oauth/slack/authorize ───
  // Initiates Slack OAuth flow. Requires authentication so we know which user is connecting.
  // Generates a random state token, stores it in Redis with userId + orgId, and redirects to Slack.

  fastify.get(
    '/oauth/slack/authorize',
    { preHandler: [authenticateOAuthRedirect, requirePermission('canSelfConnectMessengers')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const slackCreds = await getSlackPlatformCreds(getOrgId(request) ?? undefined);
      if (!slackCreds) {
        return reply.redirect(
          `${getAppUrl()}/settings?integration=slack&status=error&error=oauth_not_configured`,
        );
      }

      const organizationId = getOrgId(request);
      if (!organizationId) {
        return reply.redirect(
          `${getAppUrl()}/settings?integration=slack&status=error&error=no_organization`,
        );
      }

      // Generate a cryptographically random state token
      const state = randomBytes(32).toString('hex');

      // Store state in Redis with user context (TTL: 10 minutes). scope is
      // decided here (request.user is available) and carried through to the
      // callback, which has no session — only the state token. `forUserId`
      // lets an admin+ connect Slack on behalf of another org member (from
      // that user's Team card) — validated and resolved to a real target
      // here so the callback never has to re-check permissions.
      const query = request.query as Record<string, string | undefined>;
      const target = await resolveConnectTarget(request, organizationId, query.forUserId);
      if ('error' in target) {
        return reply.redirect(`${getAppUrl()}/settings?integration=slack&status=error&error=forbidden`);
      }
      const stateData = JSON.stringify({
        userId: target.userId,
        organizationId,
        scope: target.scope,
      });
      await getRedis().set(`oauth:slack:state:${state}`, stateData, 'EX', 600);

      // Build the Slack OAuth authorization URL
      // Bot scopes — needed for reading channels, history, and user info
      const botScopes = [
        'channels:read',
        'chat:write',
        'users:read',
        'channels:history',
        'groups:read',
        'groups:history',
        'im:read',
        'im:history',
        'mpim:read',
        'mpim:history',
      ].join(',');

      // User scopes — needed for sending messages AS the user (not the bot)
      const userScopes = [
        'chat:write',
        'channels:read',
        'channels:history',
        'groups:read',
        'groups:history',
        'im:read',
        'im:history',
        'mpim:read',
        'mpim:history',
        'files:write',
        'users:read',
      ].join(',');

      const redirectUri = `${getApiUrl()}/api/oauth/slack/callback`;

      const slackAuthUrl = new URL('https://slack.com/oauth/v2/authorize');
      slackAuthUrl.searchParams.set('client_id', slackCreds.clientId);
      slackAuthUrl.searchParams.set('scope', botScopes);
      slackAuthUrl.searchParams.set('user_scope', userScopes);
      slackAuthUrl.searchParams.set('redirect_uri', redirectUri);
      slackAuthUrl.searchParams.set('state', state);

      return reply.redirect(slackAuthUrl.toString());
    },
  );

  // ─── GET /oauth/slack/callback ───
  // Slack redirects here after the user authorizes (or denies).
  // This route does NOT require auth middleware — the state token carries the user context.

  fastify.get(
    '/oauth/slack/callback',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as Record<string, string | undefined>;
      const { code, state, error: slackError } = query;

      const appUrl = getAppUrl();

      // Handle user denying authorization
      if (slackError) {
        return reply.redirect(
          `${appUrl}/settings?integration=slack&status=error&error=${encodeURIComponent(slackError)}`,
        );
      }

      // Validate required params
      if (!code || !state) {
        return reply.redirect(
          `${appUrl}/settings?integration=slack&status=error&error=missing_params`,
        );
      }

      // Validate state token from Redis
      const redisKey = `oauth:slack:state:${state}`;
      const stateDataRaw = await getRedis().get(redisKey);

      if (!stateDataRaw) {
        return reply.redirect(
          `${appUrl}/settings?integration=slack&status=error&error=invalid_or_expired_state`,
        );
      }

      // Delete state token immediately (one-time use)
      await getRedis().del(redisKey);

      let stateData: { userId: string; organizationId: string; scope?: 'org' | 'user' };
      try {
        stateData = JSON.parse(stateDataRaw);
      } catch {
        return reply.redirect(
          `${appUrl}/settings?integration=slack&status=error&error=corrupted_state`,
        );
      }

      const { userId, organizationId, scope = 'org' } = stateData;

      // Resolve platform credentials for token exchange
      const slackCreds = await getSlackPlatformCreds(organizationId);
      if (!slackCreds) {
        return reply.redirect(
          `${appUrl}/settings?integration=slack&status=error&error=oauth_not_configured`,
        );
      }

      // Exchange the authorization code for an access token
      const redirectUri = `${getApiUrl()}/api/oauth/slack/callback`;

      let tokenResponse: Response;
      try {
        tokenResponse = await fetch('https://slack.com/api/oauth.v2.access', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: slackCreds.clientId,
            client_secret: slackCreds.clientSecret,
            code,
            redirect_uri: redirectUri,
          }),
        });
      } catch (err) {
        fastify.log.error(err, 'Failed to exchange Slack OAuth code');
        return reply.redirect(
          `${appUrl}/settings?integration=slack&status=error&error=token_exchange_failed`,
        );
      }

      const tokenData = (await tokenResponse.json()) as {
        ok: boolean;
        access_token?: string;
        team?: { id: string; name: string };
        authed_user?: { id: string; access_token?: string };
        error?: string;
      };

      if (!tokenData.ok || !tokenData.access_token) {
        const errorCode = tokenData.error ?? 'unknown_slack_error';
        fastify.log.warn({ errorCode }, 'Slack OAuth token exchange failed');
        return reply.redirect(
          `${appUrl}/settings?integration=slack&status=error&error=${encodeURIComponent(errorCode)}`,
        );
      }

      const botToken = tokenData.access_token;
      const userToken = tokenData.authed_user?.access_token;

      // Prefer user token for sending messages AS the user; fall back to bot token
      const primaryToken = userToken || botToken;

      // Verify the token works by connecting with the adapter
      const credentials = { token: primaryToken };
      const adapter = await createAdapter('slack', credentials, { organizationId });
      try {
        await adapter.connect();
      } catch (err) {
        const message =
          err instanceof MessengerError ? err.message : 'Failed to verify Slack token';
        fastify.log.warn({ message }, 'Slack OAuth token verification failed');
        return reply.redirect(
          `${appUrl}/settings?integration=slack&status=error&error=token_verification_failed`,
        );
      }

      // Encrypt and store credentials (keep both tokens for flexibility)
      const encryptedCredentials = encryptCredentials({
        token: primaryToken,
        botToken,
        userToken: userToken ?? null,
        team: tokenData.team,
        authedUser: tokenData.authed_user,
        oauthFlow: true, // Mark that this was connected via OAuth
      });

      // Upsert the integration record
      const existing = await prisma.integration.findUnique({
        where: {
          messenger_organizationId_userId_scope: {
            messenger: 'slack',
            organizationId,
            userId,
            scope,
          },
        },
      });

      let slackIntegrationId: string;
      if (existing) {
        await prisma.integration.update({
          where: { id: existing.id },
          data: {
            credentials: encryptedCredentials,
            status: 'connected',
            connectedAt: new Date(),
          },
        });
        slackIntegrationId = existing.id;
      } else {
        const createdSlack = await prisma.integration.create({
          data: {
            messenger: 'slack',
            status: 'connected',
            credentials: encryptedCredentials,
            organizationId,
            userId,
            scope,
            connectedAt: new Date(),
          },
        });
        slackIntegrationId = createdSlack.id;
      }

      // Invalidate integrations cache so the frontend sees fresh "connected" status
      await cacheInvalidate(cacheKey(organizationId, 'integrations'));
      await cacheInvalidate(cacheKey(organizationId, 'integrations', `u:${userId}`));

      // Notify connected WebSocket clients so the status badge updates instantly
      try {
        const io = getIO();
        io.to(`org:${organizationId}`).emit('integration_status_changed', {
          messenger: 'slack',
          status: 'connected',
        });
      } catch { /* WS notification is best-effort */ }
      logOAuthConnected(organizationId, userId, 'slack');

      // Redirect back to frontend with success
      return reply.redirect(
        `${appUrl}/settings?integration=slack&status=connected`,
      );
    },
  );

  // ─── GET /oauth/slack/status ───
  // Returns whether Slack OAuth is configured (so frontend knows to show button vs form).

  fastify.get(
    '/oauth/slack/status',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const slackCreds = await getSlackPlatformCreds(getOrgId(request) ?? undefined);
      return reply.send({
        oauthConfigured: slackCreds !== null,
      });
    },
  );

  // ═══════════════════════════════════════════════════════════════
  // ─── Gmail OAuth Routes ───
  // ═══════════════════════════════════════════════════════════════

  // ─── GET /oauth/gmail/available ───
  // Check whether server-side Gmail OAuth is configured.
  // Frontend uses this to decide whether to show "Connect with Google" or manual form.

  fastify.get(
    '/oauth/gmail/available',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const gmailCreds = await getGmailPlatformCreds();
      return reply.send({ available: gmailCreds !== null });
    },
  );

  // ─── GET /oauth/gmail/authorize ───
  // Starts the Gmail OAuth flow. Requires authentication so we know which user is connecting.
  // Generates a state token, stores it in Redis, then redirects to Google consent screen.

  fastify.get(
    '/oauth/gmail/authorize',
    { preHandler: [authenticateOAuthRedirect, requirePermission('canSelfConnectMessengers')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const gmailCreds = await getGmailPlatformCreds(getOrgId(request) ?? undefined);
      if (!gmailCreds) {
        return reply.redirect(
          `${getAppUrl()}/settings?integration=gmail&status=error&error=oauth_not_configured`,
        );
      }

      const organizationId = getOrgId(request);
      if (!organizationId) {
        return reply.redirect(
          `${getAppUrl()}/settings?integration=gmail&status=error&error=no_organization`,
        );
      }

      // Parse importCount from query (default 50, max 500)
      const query = request.query as Record<string, string>;
      const rawImportCount = parseInt(query.importCount ?? '50', 10);
      const importCount = Math.min(Math.max(rawImportCount || 50, 1), 500);

      // Generate a cryptographically random state token
      const state = randomBytes(32).toString('hex');

      // `forUserId` lets an admin+ connect Gmail on behalf of another org
      // member (from that user's Team card) — resolved here so the callback
      // never has to re-check permissions.
      const target = await resolveConnectTarget(request, organizationId, query.forUserId);
      if ('error' in target) {
        return reply.redirect(`${getAppUrl()}/settings?integration=gmail&status=error&error=forbidden`);
      }

      // Store state in Redis with user context (TTL: 10 minutes)
      const stateData = JSON.stringify({
        userId: target.userId,
        organizationId,
        importCount,
        scope: target.scope,
      });
      await getRedis().set(`oauth:gmail:state:${state}`, stateData, 'EX', 600);

      // Build Google OAuth authorization URL
      const oauth2Client = new google.auth.OAuth2(
        gmailCreds.clientId,
        gmailCreds.clientSecret,
        gmailCreds.redirectUri,
      );

      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent', // Force consent to always get refresh_token
        scope: GMAIL_SCOPES,
        state,
      });

      return reply.redirect(authUrl);
    },
  );

  // ─── GET /oauth/gmail/callback ───
  // Google redirects here after the user authorizes (or denies).
  // This route does NOT require auth middleware — the state token carries the user context.

  fastify.get(
    '/oauth/gmail/callback',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as Record<string, string | undefined>;
      const { code, state, error: googleError } = query;

      const appUrl = getAppUrl();

      // Handle user denying authorization
      if (googleError) {
        fastify.log.warn(`Gmail OAuth denied: ${googleError}`);
        return reply.redirect(
          `${appUrl}/settings?integration=gmail&status=error&error=${encodeURIComponent(googleError)}`,
        );
      }

      // Validate required params
      if (!code || !state) {
        return reply.redirect(
          `${appUrl}/settings?integration=gmail&status=error&error=missing_params`,
        );
      }

      // Validate state token from Redis
      const redisKey = `oauth:gmail:state:${state}`;
      const stateDataRaw = await getRedis().get(redisKey);

      if (!stateDataRaw) {
        return reply.redirect(
          `${appUrl}/settings?integration=gmail&status=error&error=invalid_or_expired_state`,
        );
      }

      // Delete state token immediately (one-time use)
      await getRedis().del(redisKey);

      let stateData: { userId: string; organizationId: string; importCount?: number; scope?: 'org' | 'user' };
      try {
        stateData = JSON.parse(stateDataRaw);
      } catch {
        return reply.redirect(
          `${appUrl}/settings?integration=gmail&status=error&error=corrupted_state`,
        );
      }

      const { userId, organizationId, importCount = 50, scope = 'org' } = stateData;

      // Resolve platform credentials for token exchange
      const gmailCreds = await getGmailPlatformCreds(organizationId);
      if (!gmailCreds) {
        return reply.redirect(
          `${appUrl}/settings?integration=gmail&status=error&error=oauth_not_configured`,
        );
      }

      // Exchange authorization code for tokens
      const oauth2Client = new google.auth.OAuth2(
        gmailCreds.clientId,
        gmailCreds.clientSecret,
        gmailCreds.redirectUri,
      );

      let tokens: { access_token?: string | null; refresh_token?: string | null };
      try {
        const { tokens: exchangedTokens } = await oauth2Client.getToken(code);
        tokens = exchangedTokens;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        fastify.log.error(`Gmail OAuth token exchange failed: ${errMsg}`);
        return reply.redirect(
          `${appUrl}/settings?integration=gmail&status=error&error=token_exchange_failed`,
        );
      }

      if (!tokens.refresh_token) {
        fastify.log.error('Gmail OAuth: No refresh_token returned');
        return reply.redirect(
          `${appUrl}/settings?integration=gmail&status=error&error=no_refresh_token`,
        );
      }

      // Store full credentials (clientId + clientSecret + refreshToken)
      // so the adapter can be created without needing platform credentials at runtime.
      const gmailCredentials = {
        clientId: gmailCreds.clientId,
        clientSecret: gmailCreds.clientSecret,
        refreshToken: tokens.refresh_token,
      };

      // Encrypt and store credentials
      const encryptedCredentials = encryptCredentials(gmailCredentials);

      // Upsert the integration record
      const existing = await prisma.integration.findUnique({
        where: {
          messenger_organizationId_userId_scope: {
            messenger: 'gmail',
            organizationId,
            userId,
            scope,
          },
        },
      });

      let integrationId: string;

      if (existing) {
        await prisma.integration.update({
          where: { id: existing.id },
          data: {
            credentials: encryptedCredentials,
            status: 'connected',
            connectedAt: new Date(),
          },
        });
        integrationId = existing.id;
      } else {
        const created = await prisma.integration.create({
          data: {
            messenger: 'gmail',
            status: 'connected',
            credentials: encryptedCredentials,
            organizationId,
            userId,
            scope,
            connectedAt: new Date(),
          },
        });
        integrationId = created.id;
      }

      // Invalidate integrations cache so frontend immediately sees "Connected"
      await cacheInvalidate(cacheKey(organizationId, 'integrations'));
      await cacheInvalidate(cacheKey(organizationId, 'integrations', `u:${userId}`));

      // Notify connected WebSocket clients so the status badge updates instantly
      try {
        const io = getIO();
        io.to(`org:${organizationId}`).emit('integration_status_changed', {
          messenger: 'gmail',
          status: 'connected',
        });
      } catch { /* WS notification is best-effort */ }
      logOAuthConnected(organizationId, userId, 'gmail');

      // Set up Gmail Pub/Sub watch for real-time notifications
      const gmailPubSubTopic = process.env.GMAIL_PUBSUB_TOPIC;
      if (gmailPubSubTopic) {
        try {
          const watchClient = new google.auth.OAuth2(
            gmailCreds.clientId,
            gmailCreds.clientSecret,
          );
          watchClient.setCredentials({ refresh_token: tokens.refresh_token });
          const gmailApi = google.gmail({ version: 'v1', auth: watchClient });

          const watchResponse = await gmailApi.users.watch({
            userId: 'me',
            requestBody: {
              topicName: gmailPubSubTopic,
              labelIds: ['INBOX'],
            },
          });

          // Store historyId for webhook processing
          const historyId = watchResponse.data.historyId;
          if (historyId) {
            await prisma.integration.update({
              where: { id: integrationId },
              data: {
                settings: { lastHistoryId: historyId },
              },
            });
          }

          fastify.log.info(`Gmail watch registered, historyId: ${historyId}`);
        } catch (err) {
          // Watch setup failure is non-fatal — webhooks just won't work until renewed
          fastify.log.warn(`Failed to set up Gmail watch: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      fastify.log.info(`Gmail OAuth connected for user ${userId} in org ${organizationId}, queued auto-import of ${importCount} threads`);

      return reply.redirect(
        `${appUrl}/settings?integration=gmail&status=connected`,
      );
    },
  );
}
