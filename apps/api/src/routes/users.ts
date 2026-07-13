import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import prisma from '../lib/prisma.js';
import { sendInviteEmail } from '../lib/email.js';
import { authenticate } from '../middleware/auth.js';
import { requireMinRole } from '../middleware/rbac.js';

// ─── Zod Schemas ───

const listUsersQuerySchema = z.object({
  role: z.enum(['superadmin', 'admin', 'user']).optional(),
  status: z.enum(['active', 'deactivated']).optional(),
  search: z.string().min(1).max(200).optional(),
  organizationId: z.string().uuid().optional(),
});

const inviteUserBodySchema = z.object({
  email: z.string().email().max(320).trim().toLowerCase(),
  name: z.string().min(1).max(200).trim(),
  role: z.enum(['admin', 'user']),
});

const updateUserBodySchema = z.object({
  name: z.string().min(1).max(200).trim().optional(),
  email: z.string().email().max(320).trim().toLowerCase().optional(),
  role: z.enum(['superadmin', 'admin', 'user']).optional(),
  status: z.enum(['active', 'deactivated']).optional(),
  password: z.string().min(8).max(128).optional(),
});

const updateProfileBodySchema = z.object({
  name: z.string().min(1).max(200).trim().optional(),
  avatar: z.string().url().max(2048).nullable().optional(),
});

const changePasswordBodySchema = z.object({
  oldPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8).max(128),
});

const userIdParamSchema = z.object({
  id: z.string().uuid(),
});

// ─── Helpers ───

const BCRYPT_ROUNDS = 12;

function sendError(reply: FastifyReply, code: string, message: string, statusCode: number) {
  return reply.status(statusCode).send({
    error: { code, message, statusCode },
  });
}

/** Strip passwordHash from user objects. */
function sanitizeUser(user: {
  id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  avatar: string | null;
  organizationId: string | null;
  lastActiveAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  organization?: { id: string; name: string; logo: string | null } | null;
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    avatar: user.avatar,
    organizationId: user.organizationId,
    // Name + logo of the user's org, so the sidebar can brand the footer.
    organization: user.organization ?? null,
    lastActiveAt: user.lastActiveAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

const ORG_BRAND_SELECT = { id: true, name: true, logo: true } as const;

// ─── Plugin ───

export default async function userRoutes(fastify: FastifyInstance): Promise<void> {

  // ─── GET /api/users/me ───

  fastify.get(
    '/me',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = await prisma.user.findUnique({
        where: { id: request.user.id },
        include: { organization: { select: ORG_BRAND_SELECT } },
      });

      if (!user) {
        return sendError(reply, 'RESOURCE_NOT_FOUND', 'User not found', 404);
      }

      return reply.send(sanitizeUser(user));
    },
  );

  // ─── PATCH /api/users/me ───

  fastify.patch(
    '/me',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = updateProfileBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 422);
      }

      const data = parsed.data;

      if (Object.keys(data).length === 0) {
        return sendError(reply, 'VALIDATION_ERROR', 'At least one field must be provided for update', 422);
      }

      const updated = await prisma.user.update({
        where: { id: request.user.id },
        data,
        include: { organization: { select: ORG_BRAND_SELECT } },
      });

      return reply.send(sanitizeUser(updated));
    },
  );

  // ─── PATCH /api/users/me/password ───

  fastify.patch(
    '/me/password',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = changePasswordBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 422);
      }

      const { oldPassword, newPassword } = parsed.data;

      const user = await prisma.user.findUnique({
        where: { id: request.user.id },
      });

      if (!user) {
        return sendError(reply, 'RESOURCE_NOT_FOUND', 'User not found', 404);
      }

      const isValid = await bcrypt.compare(oldPassword, user.passwordHash);
      if (!isValid) {
        return sendError(reply, 'AUTH_INVALID_CREDENTIALS', 'Current password is incorrect', 401);
      }

      const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

      await prisma.user.update({
        where: { id: request.user.id },
        data: { passwordHash },
      });

      return reply.send({ message: 'Password updated successfully' });
    },
  );

  // ─── GET /api/users ───

  fastify.get(
    '/',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = listUsersQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; '), 422);
      }

      const { role, status, search, organizationId } = parsed.data;

      // Determine which org to query
      let targetOrgId: string | undefined;

      if (request.user.role === 'superadmin') {
        // Superadmin can filter by specific org or see all
        targetOrgId = organizationId;
      } else {
        // Non-superadmin users can only see users in their own org
        if (!request.user.organizationId) {
          return sendError(reply, 'VALIDATION_ERROR', 'User is not associated with an organization', 400);
        }
        targetOrgId = request.user.organizationId;
      }

      const where: Record<string, unknown> = { deletedAt: null };

      if (targetOrgId) {
        where.organizationId = targetOrgId;
        // Superadmins are platform-level accounts, not members of any single
        // organization — keep them out of an org's member list and counts.
        where.role = { not: 'superadmin' };
      }
      if (role) {
        where.role = role;
      }
      if (status) {
        where.status = status;
      }
      if (search) {
        where.OR = [
          { name: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
        ];
      }

      const users = await prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
      });

      return reply.send(users.map(sanitizeUser));
    },
  );

  // ─── POST /api/users/invite ───

  fastify.post(
    '/invite',
    { preHandler: [authenticate, requireMinRole('admin')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = inviteUserBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 422);
      }

      const { email, name, role } = parsed.data;

      // Non-superadmin must belong to an org
      if (request.user.role !== 'superadmin' && !request.user.organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'You must belong to an organization to invite users', 400);
      }

      const organizationId = request.user.organizationId;

      // Admin users can only invite 'user' or 'admin' roles, not superadmin
      if (request.user.role === 'admin' && role !== 'user') {
        return sendError(reply, 'AUTH_INSUFFICIENT_PERMISSIONS', 'Admin can only invite users with the "user" role', 403);
      }

      // Check email uniqueness
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        return sendError(reply, 'VALIDATION_ERROR', `User with email ${email} already exists`, 422);
      }

      // Generate a random temporary password (user will set their own on first login)
      const tempPassword = randomBytes(16).toString('hex');
      const passwordHash = await bcrypt.hash(tempPassword, BCRYPT_ROUNDS);

      const user = await prisma.user.create({
        data: {
          email,
          name,
          passwordHash,
          role,
          organizationId,
        },
      });

      // Send invite email with temporary password
      const org = organizationId
        ? await prisma.organization.findUnique({ where: { id: organizationId }, select: { name: true } })
        : null;

      await sendInviteEmail({
        to: email,
        name,
        tempPassword,
        organizationName: org?.name ?? undefined,
        loginUrl: `${process.env.APP_URL || 'http://localhost:3000'}/login`,
      });

      return reply.status(201).send(sanitizeUser(user));
    },
  );

  // ─── PATCH /api/users/:id ───

  fastify.patch(
    '/:id',
    { preHandler: [authenticate, requireMinRole('admin')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsParsed = userIdParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', 'Invalid user id', 422);
      }

      const bodyParsed = updateUserBodySchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', bodyParsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 422);
      }

      const { id } = paramsParsed.data;
      const data = bodyParsed.data;

      if (Object.keys(data).length === 0) {
        return sendError(reply, 'VALIDATION_ERROR', 'At least one field must be provided for update', 422);
      }

      // Cannot change own role
      if (data.role && id === request.user.id) {
        return sendError(reply, 'VALIDATION_ERROR', 'You cannot change your own role', 422);
      }

      const targetUser = await prisma.user.findUnique({ where: { id } });
      if (!targetUser) {
        return sendError(reply, 'RESOURCE_NOT_FOUND', `User with id ${id} not found`, 404);
      }

      // Admin-level permission checks
      if (request.user.role === 'admin') {
        // Admin can only manage users in their own org
        if (targetUser.organizationId !== request.user.organizationId) {
          return sendError(reply, 'AUTH_INSUFFICIENT_PERMISSIONS', 'You can only manage users in your own organization', 403);
        }

        // Admin cannot modify other admins or superadmins
        if (targetUser.role === 'admin' || targetUser.role === 'superadmin') {
          return sendError(reply, 'AUTH_INSUFFICIENT_PERMISSIONS', 'Admin cannot modify other admins or superadmins', 403);
        }

        // Admin cannot promote users to superadmin or to admin (parity with
        // the invite endpoint, which forbids admins creating admins).
        if (data.role === 'superadmin' || data.role === 'admin') {
          return sendError(reply, 'AUTH_INSUFFICIENT_PERMISSIONS', 'Admin cannot assign elevated roles', 403);
        }
      }

      // A new email must be free.
      if (data.email && data.email !== targetUser.email) {
        const clash = await prisma.user.findUnique({ where: { email: data.email } });
        if (clash) {
          return sendError(reply, 'VALIDATION_ERROR', `Email ${data.email} is already in use`, 422);
        }
      }

      // The password arrives plain and is only ever stored as a hash.
      const { password, ...fields } = data;
      const updateData: Record<string, unknown> = { ...fields };
      if (password) {
        updateData.passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      }

      const updated = await prisma.user.update({
        where: { id },
        data: updateData,
      });

      // Deactivation or a password change ends the user's sessions — the same
      // revocation DELETE /:id already performs.
      if (password || (data.status === 'deactivated' && targetUser.status !== 'deactivated')) {
        await prisma.refreshToken.deleteMany({ where: { userId: id } });
      }

      return reply.send(sanitizeUser(updated));
    },
  );

  // ─── DELETE /api/users/:id ───
  // Superadmin-only. Soft-deletes: the row is kept (its broadcasts/chats still
  // reference it) but the account can no longer sign in, and its email is
  // released so the address can be reused for a fresh account.
  fastify.delete(
    '/:id',
    { preHandler: [authenticate, requireMinRole('superadmin')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsParsed = userIdParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', 'Invalid user id', 422);
      }
      const { id } = paramsParsed.data;

      if (id === request.user.id) {
        return sendError(reply, 'VALIDATION_ERROR', 'You cannot delete your own account', 422);
      }

      const target = await prisma.user.findUnique({ where: { id } });
      if (!target || target.deletedAt) {
        return sendError(reply, 'RESOURCE_NOT_FOUND', `User with id ${id} not found`, 404);
      }

      await prisma.$transaction([
        prisma.user.update({
          where: { id },
          data: {
            deletedAt: new Date(),
            status: 'deactivated',
            // Free the address (email is unique) so it can be re-used later.
            email: `deleted+${Date.now()}+${target.email}`.slice(0, 320),
          },
        }),
        prisma.refreshToken.deleteMany({ where: { userId: id } }),
      ]);

      return reply.status(204).send();
    },
  );
}
