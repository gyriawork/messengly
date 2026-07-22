import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import prisma from '../lib/prisma.js';
import { authenticate } from '../middleware/auth.js';
import { requireRole, requireOrganization, getOrgId } from '../middleware/rbac.js';

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

// The current-org update an org admin may perform on their own org (branding).
// The logo must be a raster-image data-URI (the client canvas always emits
// PNG ≤ ~20KB), so enforce the prefix and cap the length — anything else
// (external URLs, SVG, oversized blobs) is rejected.
const updateCurrentOrgBodySchema = z.object({
  name: z.string().min(1).max(200).trim().optional(),
  logo: z
    .string()
    .regex(/^data:image\/(png|jpeg|webp|gif);base64,/, 'Logo must be an image data URI')
    .max(100_000)
    .nullable()
    .optional(),
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

  // ─── PATCH /api/organizations/current ───
  // An org admin edits their OWN organization's branding (logo + name). For a
  // superadmin this targets the org selected in the sidebar (getOrgId reads the
  // injected organizationId query param). Regular members are not allowed.
  fastify.patch(
    '/current',
    { preHandler: [authenticate, requireRole('admin', 'superadmin'), requireOrganization()] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const orgId = getOrgId(request);
      if (!orgId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      const parsed = updateCurrentOrgBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(
          reply,
          'VALIDATION_ERROR',
          parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          422,
        );
      }

      const { name, logo } = parsed.data;
      const updateData: Prisma.OrganizationUpdateInput = {};
      if (name !== undefined) updateData.name = name;
      if (logo !== undefined) updateData.logo = logo; // null clears the logo

      if (Object.keys(updateData).length === 0) {
        return sendError(reply, 'VALIDATION_ERROR', 'At least one field must be provided', 422);
      }

      try {
        const updated = await prisma.organization.update({
          where: { id: orgId },
          data: updateData,
          select: { id: true, name: true, logo: true },
        });
        return reply.send({ organization: updated });
      } catch {
        return sendError(reply, 'RESOURCE_NOT_FOUND', 'Organization not found', 404);
      }
    },
  );

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
        // Explicit select: `logo` is a data-URI up to ~100KB per org — never
        // ship it in a list. The switcher fetches GET /:id/logo on demand.
        select: {
          id: true,
          name: true,
          defaultLanguage: true,
          timezone: true,
          chatVisibilityAll: true,
          status: true,
          globalBroadcastLimits: true,
          createdAt: true,
          updatedAt: true,
          _count: {
            select: {
              // Count only real members: soft-deleted users and platform-level
              // superadmins are not org members (matches the members list).
              users: { where: { deletedAt: null, role: { not: 'superadmin' } } },
              chats: true,
              broadcasts: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      const result = organizations.map((org) => ({
        id: org.id,
        name: org.name,
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

  // ─── GET /api/organizations/:id/logo ───
  // The one field the list endpoint deliberately omits (data-URI up to
  // ~100KB); the org switcher fetches it on demand for the sidebar avatar.
  fastify.get(
    '/:id/logo',
    { preHandler: superadminPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsParsed = orgIdParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', 'Invalid organization id', 422);
      }
      const org = await prisma.organization.findUnique({
        where: { id: paramsParsed.data.id },
        select: { id: true, logo: true },
      });
      if (!org) {
        return sendError(reply, 'RESOURCE_NOT_FOUND', 'Organization not found', 404);
      }
      return reply.send({ id: org.id, logo: org.logo });
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

      // Suspension must end active sessions too, not just block new logins —
      // otherwise members keep rotating refresh tokens for up to 7 days.
      if (status === 'suspended' && existing.status !== 'suspended') {
        await prisma.refreshToken.deleteMany({
          where: { user: { organizationId: id, role: { not: 'superadmin' } } },
        });
      }

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
        // Real members only — exclude soft-deleted users and superadmins.
        prisma.user.count({ where: { organizationId: id, deletedAt: null, role: { not: 'superadmin' } } }),
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

  // ─── GET /api/organizations/user-stats ───
  // Admin dashboard: per-user breakdown for the caller's org (superadmin: the
  // sidebar-selected org via getOrgId). Metrics: chats each user imported
  // (Chat.importedById), broadcasts they created (Broadcast.createdById), and
  // how many distinct chats those broadcasts reached.

  fastify.get(
    '/user-stats',
    { preHandler: [authenticate, requireRole('admin', 'superadmin'), requireOrganization()] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      const users = await prisma.user.findMany({
        where: { organizationId, deletedAt: null, role: { not: 'superadmin' } },
        select: { id: true, name: true, email: true, role: true },
        orderBy: { name: 'asc' },
      });

      const [importedGroups, broadcastGroups, impactRows] = await Promise.all([
        prisma.chat.groupBy({
          by: ['importedById'],
          where: { organizationId, deletedAt: null },
          _count: { _all: true },
        }),
        prisma.broadcast.groupBy({
          by: ['createdById'],
          where: { organizationId, deletedAt: null },
          _count: { _all: true },
        }),
        // groupBy can't traverse BroadcastChat -> Broadcast.createdById, so a
        // raw query attributes each broadcast's reached chats to its creator.
        prisma.$queryRaw<Array<{ userId: string; impactedChats: number; totalSends: number }>>`
          SELECT b."createdById" AS "userId",
                 COUNT(DISTINCT bc."chatId")::int AS "impactedChats",
                 COUNT(*)::int AS "totalSends"
          FROM "BroadcastChat" bc
          JOIN "Broadcast" b ON b."id" = bc."broadcastId"
          WHERE b."organizationId" = ${organizationId} AND b."deletedAt" IS NULL
          GROUP BY b."createdById"
        `,
      ]);

      const importedByUser = new Map(importedGroups.map((g) => [g.importedById, g._count._all]));
      const broadcastsByUser = new Map(broadcastGroups.map((g) => [g.createdById, g._count._all]));
      const impactByUser = new Map(impactRows.map((r) => [r.userId, r]));

      const rows = users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        importedChats: importedByUser.get(u.id) ?? 0,
        broadcasts: broadcastsByUser.get(u.id) ?? 0,
        impactedChats: Number(impactByUser.get(u.id)?.impactedChats ?? 0),
      }));

      return reply.send({ userCount: users.length, users: rows });
    },
  );
}
