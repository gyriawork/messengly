import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import prisma from '../lib/prisma.js';
import { authenticate } from '../middleware/auth.js';

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
// Languages are per-chat labels (Item 3), created on-the-fly from the chats
// bulk "Set language" control (POST /chats/bulk/language). This route just
// lists them for the filter dropdown and the pick-existing combobox.

export default async function languageRoutes(fastify: FastifyInstance): Promise<void> {
  const authPreHandlers = [authenticate];

  // ─── GET /languages ───

  fastify.get(
    '/languages',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }

      const languages = await prisma.language.findMany({
        where: { organizationId },
        include: { _count: { select: { chats: true } } },
        orderBy: { name: 'asc' },
      });

      return reply.send({
        languages: languages.map((l) => ({
          id: l.id,
          name: l.name,
          color: l.color,
          organizationId: l.organizationId,
          chatCount: l._count.chats,
        })),
      });
    },
  );

  // ─── DELETE /languages/:id ───
  // Housekeeping: remove a language (and its chat links via cascade).

  fastify.delete(
    '/languages/:id',
    { preHandler: authPreHandlers },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const organizationId = getOrgId(request);
      if (!organizationId) {
        return sendError(reply, 'VALIDATION_ERROR', 'Organization context is required', 400);
      }
      const { id } = request.params as { id: string };
      const existing = await prisma.language.findFirst({ where: { id, organizationId } });
      if (!existing) {
        return sendError(reply, 'RESOURCE_NOT_FOUND', `Language with id ${id} not found`, 404);
      }
      await prisma.language.delete({ where: { id } });
      return reply.send({ deleted: true });
    },
  );
}
