import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { cacheGet, cacheSet, cacheInvalidate, cacheKey } from '../lib/cache.js';

// ─── Zod Schemas ───

const tagIdParamSchema = z.object({
  id: z.string().uuid(),
});

const createTagBodySchema = z.object({
  name: z.string().min(1).max(100).trim(),
  color: z.string().min(1).max(50).trim(),
});

const updateTagBodySchema = z.object({
  name: z.string().min(1).max(100).trim().optional(),
  color: z.string().min(1).max(50).trim().optional(),
});

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

// ─── Plugin ───

export default async function tagRoutes(fastify: FastifyInstance): Promise<void> {
  const authPreHandlers = [authenticate];
  // Admin/superadmin always manage tags; a plain `user` needs the
  // canCreateTags permission (Task 6) — org admins can restrict it per user.
  const tagWritePreHandlers = [authenticate, requirePermission('canCreateTags')];

  // ─── GET /tags ───

  fastify.get(
    '/tags',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      const ck = cacheKey(organizationId, 'tags');
      const cached = await cacheGet(ck);
      if (cached) {
        return reply.send(cached);
      }

      const tags = await prisma.tag.findMany({
        where: { organizationId },
        include: {
          _count: {
            select: { chats: true },
          },
        },
        orderBy: { name: 'asc' },
      });

      const result = tags.map((tag) => ({
        id: tag.id,
        name: tag.name,
        color: tag.color,
        organizationId: tag.organizationId,
        chatCount: tag._count.chats,
      }));

      const response = { tags: result };
      await cacheSet(ck, response, 300);

      return reply.send(response);
    },
  );

  // ─── POST /tags ───

  fastify.post(
    '/tags',
    { preHandler: tagWritePreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = createTagBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 422);
      }

      const { name, color } = parsed.data;
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      // Check uniqueness within org
      const existing = await prisma.tag.findFirst({
        where: {
          name: { equals: name, mode: 'insensitive' },
          organizationId,
        },
      });
      if (existing) {
        return sendError(reply, 'VALIDATION_ERROR', `Tag with name "${name}" already exists in this organization`, 422);
      }

      const tag = await prisma.tag.create({
        data: {
          name,
          color,
          organizationId,
        },
      });

      await cacheInvalidate(cacheKey(organizationId, 'tags'));

      return reply.status(201).send({
        id: tag.id,
        name: tag.name,
        color: tag.color,
        organizationId: tag.organizationId,
      });
    },
  );

  // ─── PATCH /tags/:id ───

  fastify.patch(
    '/tags/:id',
    { preHandler: tagWritePreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsParsed = tagIdParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', 'Invalid tag id', 422);
      }

      const bodyParsed = updateTagBodySchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', bodyParsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 422);
      }

      const { id } = paramsParsed.data;
      const { name, color } = bodyParsed.data;

      if (name === undefined && color === undefined) {
        return sendError(reply, 'VALIDATION_ERROR', 'At least one field must be provided for update', 422);
      }

      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      const existing = await prisma.tag.findFirst({
        where: { id, organizationId },
      });
      if (!existing) {
        return sendError(reply, 'RESOURCE_NOT_FOUND', `Tag with id ${id} not found`, 404);
      }

      // If renaming, check uniqueness within org
      if (name !== undefined && name.toLowerCase() !== existing.name.toLowerCase()) {
        const duplicate = await prisma.tag.findFirst({
          where: {
            name: { equals: name, mode: 'insensitive' },
            organizationId,
            id: { not: id },
          },
        });
        if (duplicate) {
          return sendError(reply, 'VALIDATION_ERROR', `Tag with name "${name}" already exists in this organization`, 422);
        }
      }

      const updateData: Record<string, unknown> = {};
      if (name !== undefined) updateData.name = name;
      if (color !== undefined) updateData.color = color;

      const updated = await prisma.tag.update({
        where: { id },
        data: updateData,
      });

      await cacheInvalidate(cacheKey(organizationId, 'tags'));

      return reply.send({
        id: updated.id,
        name: updated.name,
        color: updated.color,
        organizationId: updated.organizationId,
      });
    },
  );

  // ─── DELETE /tags/:id ───

  fastify.delete(
    '/tags/:id',
    { preHandler: tagWritePreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsParsed = tagIdParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return sendError(reply, 'VALIDATION_ERROR', 'Invalid tag id', 422);
      }

      const { id } = paramsParsed.data;
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      const existing = await prisma.tag.findFirst({
        where: { id, organizationId },
      });
      if (!existing) {
        return sendError(reply, 'RESOURCE_NOT_FOUND', `Tag with id ${id} not found`, 404);
      }

      // ChatTag entries cascade-delete via Prisma schema (onDelete: Cascade)
      await prisma.tag.delete({ where: { id } });

      await cacheInvalidate(cacheKey(organizationId, 'tags'));

      return reply.status(204).send();
    },
  );
}
