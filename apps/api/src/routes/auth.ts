import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import prisma from '../lib/prisma.js';
import { sendPasswordResetEmail } from '../lib/email.js';
import { redisIncr, redisTtl, redisSetFlag, redisExists, redisDel } from '../lib/cache.js';

// ─── Login brute-force lockout ───
// Per-account: after MAX_LOGIN_FAILS wrong passwords, the account is locked for
// LOGIN_LOCK_SECONDS. Tracked in Redis (keyed by email) so it survives restarts
// and needs no schema change. This is separate from the per-IP rate limit.
const MAX_LOGIN_FAILS = 3;
const LOGIN_LOCK_SECONDS = 24 * 60 * 60; // 24 hours
const failKeyFor = (email: string) => `login:fail:${email.toLowerCase()}`;
const lockKeyFor = (email: string) => `login:lock:${email.toLowerCase()}`;

// ─── Env helpers ───

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set');
  return secret;
}

function getJwtRefreshSecret(): string {
  const secret = process.env.JWT_REFRESH_SECRET;
  if (!secret) throw new Error('JWT_REFRESH_SECRET is not set');
  return secret;
}

// ─── Token generation ───

const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY_SECONDS = 7 * 24 * 60 * 60; // 7 days

interface TokenUser {
  id: string;
  email: string;
  name: string;
  role: string;
  organizationId: string | null;
}

function generateAccessToken(user: TokenUser): string {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      organizationId: user.organizationId,
    },
    getJwtSecret(),
    { algorithm: 'HS256', expiresIn: ACCESS_TOKEN_EXPIRY },
  );
}

function generateRefreshToken(): string {
  return randomUUID();
}

async function storeRefreshToken(userId: string, token: string): Promise<void> {
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_SECONDS * 1000);
  await prisma.refreshToken.create({
    data: { token, userId, expiresAt },
  });
}

// ─── Validation schemas ───

const registerSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().min(1, 'Name is required'),
  inviteToken: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

// refresh and logout read token from httpOnly cookie — no body schema needed

// ─── Cookie helper ───

function setRefreshTokenCookie(reply: FastifyReply, token: string): void {
  reply.setCookie('refreshToken', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    path: '/api/auth',
    maxAge: REFRESH_TOKEN_EXPIRY_SECONDS,
  });
}

function clearRefreshTokenCookie(reply: FastifyReply): void {
  reply.clearCookie('refreshToken', { path: '/api/auth' });
}

// ─── Helpers ───

function validationError(reply: FastifyReply, message: string) {
  return reply.status(422).send({
    error: {
      code: 'VALIDATION_ERROR',
      message,
      statusCode: 422,
    },
  });
}

function userResponse(user: { id: string; email: string; name: string; role: string }) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  };
}

// ─── Plugin ───

export default async function authRoutes(fastify: FastifyInstance): Promise<void> {
  // Apply stricter rate limit to all auth routes (10 req/min)
  fastify.addHook('onRoute', (routeOptions) => {
    routeOptions.config = {
      ...routeOptions.config,
      rateLimit: {
        max: 10,
        timeWindow: '1 minute',
      },
    };
  });

  // ── POST /register ──
  // Self-registration disabled — users are added via admin invite only.

  fastify.post(
    '/register',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.status(403).send({
        error: {
          code: 'AUTH_INSUFFICIENT_PERMISSIONS',
          message: 'Self-registration is disabled. Please ask your workspace admin for an invite.',
          statusCode: 403,
        },
      });
    },
  );

  // ── POST /login ──

  fastify.post(
    '/login',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) {
        const firstError = parsed.error.errors[0]?.message ?? 'Invalid input';
        return validationError(reply, firstError);
      }

      const { email, password } = parsed.data;

      // Already locked from earlier failures? Refuse before touching the DB.
      const lockKey = lockKeyFor(email);
      const failKey = failKeyFor(email);
      if (await redisExists(lockKey)) {
        const ttl = await redisTtl(lockKey);
        const hours = Math.max(1, Math.ceil(ttl / 3600));
        return reply.status(429).send({
          error: {
            code: 'AUTH_LOCKED',
            message: `Too many failed attempts. This account is locked for ${hours} more hour${hours === 1 ? '' : 's'}.`,
            statusCode: 429,
          },
        });
      }

      // Records a failed attempt; locks the account once the limit is hit.
      // Returns true if this failure triggered the lock.
      const registerFailure = async (): Promise<boolean> => {
        const fails = await redisIncr(failKey, LOGIN_LOCK_SECONDS);
        if (fails >= MAX_LOGIN_FAILS) {
          await redisSetFlag(lockKey, LOGIN_LOCK_SECONDS);
          await redisDel(failKey);
          return true;
        }
        return false;
      };

      // Find user and verify the password. A missing user and a wrong password
      // are treated identically — same message, same failure count — so the
      // endpoint never reveals whether an address exists.
      const user = await prisma.user.findUnique({ where: { email } });
      const passwordValid = user ? await bcrypt.compare(password, user.passwordHash) : false;
      if (!user || !passwordValid) {
        const nowLocked = await registerFailure();
        if (nowLocked) {
          return reply.status(429).send({
            error: {
              code: 'AUTH_LOCKED',
              message: 'Too many failed attempts. This account is locked for 24 hours.',
              statusCode: 429,
            },
          });
        }
        return reply.status(401).send({
          error: {
            code: 'AUTH_INVALID_CREDENTIALS',
            message: 'Invalid email or password',
            statusCode: 401,
          },
        });
      }

      // Correct password — clear any accumulated failures for this account.
      await redisDel(failKey, lockKey);

      // A soft-deleted account is gone — treat it as unknown credentials.
      if (user.deletedAt) {
        return reply.status(401).send({
          error: {
            code: 'AUTH_INVALID_CREDENTIALS',
            message: 'Invalid email or password',
            statusCode: 401,
          },
        });
      }

      // Check user status
      if (user.status === 'deactivated') {
        return reply.status(403).send({
          error: {
            code: 'AUTH_INSUFFICIENT_PERMISSIONS',
            message: 'This account has been deactivated',
            statusCode: 403,
          },
        });
      }

      // A suspended organization locks out its members entirely; superadmin
      // must still get in to lift the suspension.
      if (user.role !== 'superadmin' && user.organizationId) {
        const org = await prisma.organization.findUnique({
          where: { id: user.organizationId },
          select: { status: true },
        });
        if (org?.status === 'suspended') {
          return reply.status(403).send({
            error: {
              code: 'ORG_SUSPENDED',
              message: 'This platform is currently unavailable. Please contact us.',
              statusCode: 403,
            },
          });
        }
      }

      // Update lastActiveAt
      await prisma.user.update({
        where: { id: user.id },
        data: { lastActiveAt: new Date() },
      });

      // Generate tokens
      const accessToken = generateAccessToken(user);
      const refreshToken = generateRefreshToken();
      await storeRefreshToken(user.id, refreshToken);

      setRefreshTokenCookie(reply, refreshToken);

      return reply.status(200).send({
        accessToken,
        user: userResponse(user),
      });
    },
  );

  // ── POST /refresh ──

  fastify.post(
    '/refresh',
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Read refresh token exclusively from httpOnly cookie
      const refreshToken =
        (request.cookies as Record<string, string | undefined>)?.refreshToken;

      if (!refreshToken) {
        return reply.status(401).send({
          error: {
            code: 'AUTH_TOKEN_EXPIRED',
            message: 'Refresh token is required',
            statusCode: 401,
          },
        });
      }

      // Find stored token
      const storedToken = await prisma.refreshToken.findUnique({
        where: { token: refreshToken },
        include: { user: true },
      });

      if (!storedToken) {
        clearRefreshTokenCookie(reply);
        return reply.status(401).send({
          error: {
            code: 'AUTH_TOKEN_EXPIRED',
            message: 'Invalid refresh token',
            statusCode: 401,
          },
        });
      }

      // Check expiry
      if (storedToken.expiresAt < new Date()) {
        // Clean up expired token
        await prisma.refreshToken.delete({ where: { id: storedToken.id } });
        clearRefreshTokenCookie(reply);
        return reply.status(401).send({
          error: {
            code: 'AUTH_TOKEN_EXPIRED',
            message: 'Refresh token has expired',
            statusCode: 401,
          },
        });
      }

      // Rotate: delete old refresh token
      await prisma.refreshToken.delete({ where: { id: storedToken.id } });

      // Generate new tokens
      const accessToken = generateAccessToken(storedToken.user);
      const newRefreshToken = generateRefreshToken();
      await storeRefreshToken(storedToken.user.id, newRefreshToken);

      // Set new refresh token cookie
      setRefreshTokenCookie(reply, newRefreshToken);

      return reply.status(200).send({
        accessToken,
        user: userResponse(storedToken.user),
      });
    },
  );

  // ── POST /logout ──

  fastify.post(
    '/logout',
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Read refresh token from httpOnly cookie
      const refreshToken =
        (request.cookies as Record<string, string | undefined>)?.refreshToken;

      if (refreshToken) {
        // Delete refresh token (ignore if not found -- idempotent)
        await prisma.refreshToken.deleteMany({ where: { token: refreshToken } });
      }

      clearRefreshTokenCookie(reply);

      return reply.status(200).send({ success: true });
    },
  );

  // ── POST /forgot-password ──

  fastify.post(
    '/forgot-password',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const schema = z.object({ email: z.string().email() });
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid email', statusCode: 422 } });
      }

      const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });

      // Always return success to prevent email enumeration
      if (!user) {
        return reply.status(200).send({ message: 'If the email exists, a reset link has been sent' });
      }

      const token = randomUUID();
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await prisma.passwordResetToken.create({
        data: { token, userId: user.id, expiresAt },
      });

      // Send password reset email
      await sendPasswordResetEmail({
        to: user.email,
        name: user.name,
        resetUrl: `${process.env.APP_URL || 'http://localhost:3000'}/reset-password?token=${token}`,
      });

      return reply.status(200).send({ message: 'If the email exists, a reset link has been sent' });
    },
  );

  // ── POST /reset-password ──

  fastify.post(
    '/reset-password',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const schema = z.object({
        token: z.string().uuid(),
        newPassword: z.string().min(8),
      });
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid input', statusCode: 422 } });
      }

      const resetToken = await prisma.passwordResetToken.findUnique({
        where: { token: parsed.data.token },
      });

      if (!resetToken || resetToken.usedAt || resetToken.expiresAt < new Date()) {
        return reply.status(400).send({ error: { code: 'AUTH_INVALID_CREDENTIALS', message: 'Invalid or expired reset token', statusCode: 400 } });
      }

      const hashedPassword = await bcrypt.hash(parsed.data.newPassword, 12);

      await prisma.$transaction([
        prisma.user.update({
          where: { id: resetToken.userId },
          data: { passwordHash: hashedPassword },
        }),
        prisma.passwordResetToken.update({
          where: { id: resetToken.id },
          data: { usedAt: new Date() },
        }),
        // Invalidate all refresh tokens
        prisma.refreshToken.deleteMany({
          where: { userId: resetToken.userId },
        }),
      ]);

      return reply.status(200).send({ message: 'Password reset successfully' });
    },
  );
}
