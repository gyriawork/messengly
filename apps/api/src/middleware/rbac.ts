import type { FastifyRequest, FastifyReply } from 'fastify';
import prisma from '../lib/prisma.js';

type UserRole = 'superadmin' | 'admin' | 'user';
type UserPermission = 'canCreateTags' | 'canSelfConnectMessengers' | 'canViewAllChats';

// ─── Types ───

declare module 'fastify' {
  interface FastifyRequest {
    user: {
      id: string;
      email: string;
      name: string;
      role: UserRole;
      organizationId: string | null;
    };
  }
}

// ─── Role Hierarchy ───

const ROLE_HIERARCHY: Record<UserRole, number> = {
  superadmin: 3,
  admin: 2,
  user: 1,
};

// ─── Middleware Factories ───

/**
 * Require user to have one of the specified roles.
 *
 * Usage:
 *   fastify.get('/organizations', { preHandler: [requireRole('superadmin')] }, handler)
 *   fastify.post('/broadcasts', { preHandler: [requireRole('admin', 'superadmin')] }, handler)
 */
export function requireRole(...roles: UserRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      return reply.status(401).send({
        error: {
          code: 'AUTH_TOKEN_EXPIRED',
          message: 'Authentication required',
          statusCode: 401,
        },
      });
    }

    if (!roles.includes(request.user.role)) {
      return reply.status(403).send({
        error: {
          code: 'AUTH_INSUFFICIENT_PERMISSIONS',
          message: `This action requires one of: ${roles.join(', ')}`,
          statusCode: 403,
        },
      });
    }
  };
}

/**
 * Require minimum role level (uses hierarchy: user < admin < superadmin).
 *
 * Usage:
 *   fastify.patch('/settings', { preHandler: [requireMinRole('admin')] }, handler)
 */
export function requireMinRole(minRole: UserRole) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      return reply.status(401).send({
        error: { code: 'AUTH_TOKEN_EXPIRED', message: 'Authentication required', statusCode: 401 },
      });
    }

    const userLevel = ROLE_HIERARCHY[request.user.role] ?? 0;
    const requiredLevel = ROLE_HIERARCHY[minRole] ?? 0;

    if (userLevel < requiredLevel) {
      return reply.status(403).send({
        error: {
          code: 'AUTH_INSUFFICIENT_PERMISSIONS',
          message: `This action requires at least ${minRole} role`,
          statusCode: 403,
        },
      });
    }
  };
}

/**
 * Require a per-user permission toggle (User.canCreateTags etc — see Task 6).
 * Admin/superadmin always pass: these toggles exist to loosen or restrict a
 * regular `user`, not to gate the roles that manage them.
 *
 * Reads the flag fresh from the DB on every request rather than trusting the
 * JWT, so a toggle an admin flips takes effect on the very next request — no
 * re-login needed for enforcement (the UI catches up whenever it next
 * refetches /users/me).
 *
 * Usage:
 *   fastify.post('/tags', { preHandler: [requirePermission('canCreateTags')] }, handler)
 */
export function requirePermission(permission: UserPermission) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      return reply.status(401).send({
        error: { code: 'AUTH_TOKEN_EXPIRED', message: 'Authentication required', statusCode: 401 },
      });
    }

    if (request.user.role === 'admin' || request.user.role === 'superadmin') {
      return;
    }

    const record = await prisma.user.findUnique({
      where: { id: request.user.id },
      select: { canCreateTags: true, canSelfConnectMessengers: true, canViewAllChats: true },
    });

    if (!record?.[permission]) {
      return reply.status(403).send({
        error: {
          code: 'AUTH_INSUFFICIENT_PERMISSIONS',
          message: 'You do not have permission to perform this action. Ask your admin to enable it.',
          statusCode: 403,
        },
      });
    }
  };
}

/**
 * Ensure user belongs to the organization being accessed.
 * Superadmin bypasses this check.
 *
 * Reads organizationId from:
 * 1. request.params.organizationId
 * 2. request.body.organizationId
 * 3. request.user.organizationId (fallback)
 *
 * Usage:
 *   fastify.get('/chats', { preHandler: [requireOrganization()] }, handler)
 */
export function requireOrganization() {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      return reply.status(401).send({
        error: { code: 'AUTH_TOKEN_EXPIRED', message: 'Authentication required', statusCode: 401 },
      });
    }

    // Superadmin can access any organization
    if (request.user.role === 'superadmin') {
      return;
    }

    const params = request.params as Record<string, string>;
    const body = request.body as Record<string, unknown> | undefined;

    const targetOrgId =
      params?.organizationId ??
      (body as Record<string, unknown>)?.organizationId ??
      request.user.organizationId;

    if (!targetOrgId) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Organization context is required',
          statusCode: 400,
        },
      });
    }

    if (request.user.organizationId !== targetOrgId) {
      return reply.status(403).send({
        error: {
          code: 'AUTH_INSUFFICIENT_PERMISSIONS',
          message: 'You do not have access to this organization',
          statusCode: 403,
        },
      });
    }
  };
}

/**
 * Helper to get the current user's organization ID for Prisma queries.
 * Superadmin can optionally specify organizationId via query param.
 */
export function getOrgId(request: FastifyRequest): string | null {
  if (request.user.role === 'superadmin') {
    const query = request.query as Record<string, string>;
    return query.organizationId ?? request.user.organizationId ?? null;
  }
  return request.user.organizationId ?? null;
}
