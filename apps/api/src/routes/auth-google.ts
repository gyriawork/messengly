import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomBytes } from 'node:crypto';
import { google } from 'googleapis';
import prisma from '../lib/prisma.js';
import { redisSetFlag, redisExists, redisDel } from '../lib/cache.js';
import {
  generateRefreshToken,
  storeRefreshToken,
  setRefreshTokenCookie,
} from './auth.js';

// "Sign in with Google" for existing users only — there is no self-registration
// path here (see routes/auth.ts POST /register, which is disabled outright).
// A Google account with no matching Messengly user is bounced to
// login?error=account_not_found instead of being auto-provisioned.

function getAppUrl(): string {
  return process.env.APP_URL ?? 'http://localhost:3000';
}

function getApiUrl(): string {
  return process.env.API_URL ?? `http://localhost:${process.env.PORT ?? '3001'}`;
}

function getGoogleLoginCreds(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GOOGLE_LOGIN_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_LOGIN_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

function getRedirectUri(): string {
  return `${getApiUrl()}/api/auth/google/callback`;
}

const stateKey = (state: string) => `auth:google:state:${state}`;

export default async function authGoogleRoutes(fastify: FastifyInstance): Promise<void> {
  // Same stricter rate limit as the rest of the auth routes.
  fastify.addHook('onRoute', (routeOptions) => {
    routeOptions.config = {
      ...routeOptions.config,
      rateLimit: {
        max: 10,
        timeWindow: '1 minute',
      },
    };
  });

  // ── GET /google ──

  fastify.get('/google', async (_request: FastifyRequest, reply: FastifyReply) => {
    const creds = getGoogleLoginCreds();
    if (!creds) {
      return reply.redirect(`${getAppUrl()}/login?error=google_not_configured`);
    }

    const state = randomBytes(32).toString('hex');
    await redisSetFlag(stateKey(state), 600);

    const oauth2Client = new google.auth.OAuth2(creds.clientId, creds.clientSecret, getRedirectUri());
    const authUrl = oauth2Client.generateAuthUrl({
      scope: ['openid', 'email', 'profile'],
      state,
    });

    return reply.redirect(authUrl);
  });

  // ── GET /google/callback ──

  fastify.get('/google/callback', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, string | undefined>;
    const { code, state, error: googleError } = query;
    const appUrl = getAppUrl();

    if (googleError) {
      return reply.redirect(`${appUrl}/login?error=google_denied`);
    }
    if (!code || !state) {
      return reply.redirect(`${appUrl}/login?error=google_missing_params`);
    }

    // One-time use, short-lived — same replay protection as the messenger
    // OAuth flows in routes/oauth.ts.
    const key = stateKey(state);
    if (!(await redisExists(key))) {
      return reply.redirect(`${appUrl}/login?error=google_invalid_state`);
    }
    await redisDel(key);

    const creds = getGoogleLoginCreds();
    if (!creds) {
      return reply.redirect(`${appUrl}/login?error=google_not_configured`);
    }

    const oauth2Client = new google.auth.OAuth2(creds.clientId, creds.clientSecret, getRedirectUri());

    let idToken: string | undefined;
    try {
      const { tokens } = await oauth2Client.getToken(code);
      idToken = tokens.id_token ?? undefined;
    } catch (err) {
      fastify.log.error(err, 'Google login: token exchange failed');
      return reply.redirect(`${appUrl}/login?error=google_token_exchange_failed`);
    }

    if (!idToken) {
      return reply.redirect(`${appUrl}/login?error=google_no_id_token`);
    }

    let email: string | undefined;
    let emailVerified: boolean | undefined;
    try {
      const ticket = await oauth2Client.verifyIdToken({ idToken, audience: creds.clientId });
      const payload = ticket.getPayload();
      email = payload?.email;
      emailVerified = payload?.email_verified;
    } catch (err) {
      fastify.log.warn(err, 'Google login: id_token verification failed');
      return reply.redirect(`${appUrl}/login?error=google_invalid_token`);
    }

    if (!email || !emailVerified) {
      return reply.redirect(`${appUrl}/login?error=google_email_not_verified`);
    }

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

    // No account, or soft-deleted — Google login never creates accounts.
    if (!user || user.deletedAt) {
      return reply.redirect(`${appUrl}/login?error=account_not_found`);
    }

    if (user.status === 'deactivated') {
      return reply.redirect(`${appUrl}/login?error=account_deactivated`);
    }

    if (user.role !== 'superadmin' && user.organizationId) {
      const org = await prisma.organization.findUnique({
        where: { id: user.organizationId },
        select: { status: true },
      });
      if (org?.status === 'suspended') {
        return reply.redirect(`${appUrl}/login?error=org_suspended`);
      }
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { lastActiveAt: new Date() },
    });

    // No access token minted here — only the refresh cookie. The redirect
    // carries no token in the URL; the SPA sees the success flag and calls
    // POST /auth/refresh, which mints the access token off this cookie.
    const refreshToken = generateRefreshToken();
    await storeRefreshToken(user.id, refreshToken);
    setRefreshTokenCookie(reply, refreshToken);

    return reply.redirect(`${appUrl}/login?googleAuth=success`);
  });

  // ── GET /google/status ──
  // Lets the frontend know whether to show the "Sign in with Google" button.

  fastify.get('/google/status', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ available: getGoogleLoginCreds() !== null });
  });
}
