import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import prisma from '../lib/prisma.js';
import { authenticate } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';

// ─── Zod Schemas ───

const listOrgsQuerySchema = z.object({
  status: z.enum(['active', 'suspended']).optional(),
  search: z.string().min(1).max(200).optional(),
});

const createOrgBodySchema = z.object({
  name: z.string().min(1).max(200).trim(),
  adminEmail: z.string().email().max(320).trim().toLowerCase(),
  adminName: z.string().min(1).max(200).trim(),
  adminPassword: z.string().min(8).max(128),
});

const updateOrgBodySchema = z.object({
  name: z.string().min(1).max(200).trim().optional(),
  status: z.enum(['active', 'suspended']).optional(),
  globalBroadcastLimits: z.record(z.unknown()).nullable().optional(),
});

const orgIdParamSchema = z.object({
  id: z.string().uuid(),
});

// ─── Helpers ───

const BCRYPT_ROUNDS = 12;

function sendError(reply: FastifyReply, code: string, message: string, statusCode: number) {
  return reply.status(statusCode).send({
    error: { code, message, statusCode },
  });
}

/** Strip sensitive fields from user objects returned to clients. */
function sanitizeUser(user: { id: string; email: string; name: string; role: string; status: string; avatar: string | null; organizationId: string | null; createdAt: Date; updatedAt: Date }) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    avatar: user.avatar,
    organizationId: user.organizationId,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

// ─── Plugin ───

export default async function organizationRoutes(fastify: FastifyInstance): Promise<void> {
  const superadminPreHandlers = [authenticate, requireRole('superadmin')];

  // ─── GET /api/organizations ───

  fastify.get(
    '/',
    { preHandler: superadminPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = listOrgsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; '), 422);
      }

      const { status, search } = parsed.data;

      const where: Record<string, unknown> = {};
      if (status) {
        where.status = status;
      }
      if (search) {
        where.name = { contains: search, mode: 'insensitive' };
      }

      const organizations = await prisma.organization.findMany({
        where,
        include: {
          _count: {
            select: { users: true, chats: true, broadcasts: true },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      const result = organizations.map((org) => ({
        id: org.id,
        name: org.name,
        logo: org.logo,
        defaultLanguage: org.defaultLanguage,
        timezone: org.timezone,
        chatVisibilityAll: org.chatVisibilityAll,
        status: org.status,
        globalBroadcastLimits: org.globalBroadcastLimits,
        userCount: org._count.users,
        _count: org._count,
        createdAt: org.createdAt,
        updatedAt: org.updatedAt,
      }));

      return reply.send(result);
    },
  );

  // ─── POST /api/organizations ───

  fastify.post(
    '/',
    { preHandler: superadminPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = createOrgBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 422);
      }

      const { name, adminEmail, adminName, adminPassword } = parsed.data;

      // Check email uniqueness
      const existing = await prisma.user.findUnique({ where: { email: adminEmail } });
      if (existing) {
        return sendError(reply, 'VALIDATION_ERROR', `User with email ${adminEmail} already exists`, 422);
      }

      const passwordHash = await bcrypt.hash(adminPassword, BCRYPT_ROUNDS);

      const result = await prisma.$transaction(async (tx) => {
        const organization = await tx.organization.create({
          data: { name },
        });

        const adminUser = await tx.user.create({
          data: {
            email: adminEmail,
            name: adminName,
            passwordHash,
            role: 'admin',
            organizationId: organization.id,
          },
        });

        return { organization, adminUser };
      });

      return reply.status(201).send({
        organization: {
          id: result.organization.id,
          name: result.organization.name,
          logo: result.organization.logo,
          defaultLanguage: result.organization.defaultLanguage,
          timezone: result.organization.timezone,
          chatVisibilityAll: result.organization.chatVisibilityAll,
          status: result.organization.status,
          globalBroadcastLimits: result.organization.globalBroadcastLimits,
          createdAt: result.organization.createdAt,
          updatedAt: result.organization.updatedAt,
        },
        adminUser: sanitizeUser(result.adminUser),
      });
    },
  );

  // ─── PATCH /api/organizations/:id ───

  fastify.patch(
    '/:id',
    { preHandler: superadminPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsParsed = orgIdParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', 'Invalid organization id', 422);
      }

      const bodyParsed = updateOrgBodySchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', bodyParsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 422);
      }

      const { id } = paramsParsed.data;
      const { name, status, globalBroadcastLimits } = bodyParsed.data;

      // Check at least one field is provided
      if (!name && !status && globalBroadcastLimits === undefined) {
        return sendError(reply, 'VALIDATION_ERROR', 'At least one field must be provided for update', 422);
      }

      const existing = await prisma.organization.findUnique({ where: { id } });
      if (!existing) {
        return sendError(reply, 'RESOURCE_NOT_FOUND', `Organization with id ${id} not found`, 404);
      }

      const updateData: Prisma.OrganizationUpdateInput = {};
      if (name !== undefined) updateData.name = name;
      if (status !== undefined) updateData.status = status;
      if (globalBroadcastLimits !== undefined) {
        updateData.globalBroadcastLimits = globalBroadcastLimits === null
          ? Prisma.JsonNull
          : (globalBroadcastLimits as Prisma.InputJsonValue);
      }

      const updated = await prisma.organization.update({
        where: { id },
        data: updateData,
      });

      return reply.send({
        id: updated.id,
        name: updated.name,
        logo: updated.logo,
        defaultLanguage: updated.defaultLanguage,
        timezone: updated.timezone,
        chatVisibilityAll: updated.chatVisibilityAll,
        status: updated.status,
        globalBroadcastLimits: updated.globalBroadcastLimits,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      });
    },
  );

  // ─── GET /api/organizations/:id/stats ───

  fastify.get(
    '/:id/stats',
    { preHandler: superadminPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsParsed = orgIdParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', 'Invalid organization id', 422);
      }

      const { id } = paramsParsed.data;

      const org = await prisma.organization.findUnique({ where: { id } });
      if (!org) {
        return sendError(reply, 'RESOURCE_NOT_FOUND', `Organization with id ${id} not found`, 404);
      }

      const [userCount, chatCount, broadcastCount, integrationCount] = await Promise.all([
        prisma.user.count({ where: { organizationId: id } }),
        prisma.chat.count({ where: { organizationId: id } }),
        prisma.broadcast.count({ where: { organizationId: id } }),
        prisma.integration.count({ where: { organizationId: id } }),
      ]);

      return reply.send({
        userCount,
        chatCount,
        broadcastCount,
        integrationCount,
      });
    },
  );
}
