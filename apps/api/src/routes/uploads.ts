import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authenticate } from '../middleware/auth.js';
import { requireOrganization, getOrgId } from '../middleware/rbac.js';
import { uploadFile, getSignedDownloadUrl, deleteFile, useLocalStorage, getLocalFilePath } from '../lib/storage.js';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Validate that an upload key belongs to the given org and has no path traversal */
function validateUploadKey(key: string, organizationId: string | null): boolean {
  if (!organizationId) return false;
  const normalized = key.replace(/\\/g, '/');
  if (normalized.includes('..') || normalized.startsWith('/')) return false;
  return normalized.startsWith(`${organizationId}/`);
}

export default async function uploadRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /uploads — upload a file
  fastify.post(
    '/uploads',
    { preHandler: [authenticate, requireOrganization()] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const orgId = getOrgId(request);

      const data = await request.file();
      if (!data) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'No file provided', statusCode: 400 },
        });
      }

      // Validate file size (10MB max)
      const buffer = await data.toBuffer();
      if (buffer.length > 10 * 1024 * 1024) {
        return reply.status(413).send({
          error: { code: 'VALIDATION_ERROR', message: 'File too large (max 10MB)', statusCode: 413 },
        });
      }

      // Validate mime type. SVG is deliberately excluded — it can carry
      // scripts and would execute when opened from the serving origin.
      const allowedTypes = [
        'image/jpeg', 'image/png', 'image/gif', 'image/webp',
        'application/pdf',
        'text/plain', 'text/csv',
        'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/zip', 'application/gzip',
        'video/mp4', 'audio/mpeg', 'audio/ogg',
      ];

      const mimeType = data.mimetype || 'application/octet-stream';
      if (!allowedTypes.includes(mimeType) && !mimeType.startsWith('text/')) {
        return reply.status(415).send({
          error: { code: 'VALIDATION_ERROR', message: `File type ${mimeType} not allowed`, statusCode: 415 },
        });
      }

      try {
        const result = await uploadFile(buffer, data.filename, mimeType, orgId!);

        return reply.status(201).send({
          file: {
            key: result.key,
            url: result.url,
            size: result.size,
            mimeType: result.mimeType,
            filename: result.originalName,
          },
        });
      } catch (err) {
        fastify.log.error(err, 'File upload failed');
        return reply.status(502).send({
          error: { code: 'INTERNAL_ERROR', message: 'Failed to upload file', statusCode: 502 },
        });
      }
    },
  );

  // GET /uploads/signed-url — get signed download URL
  fastify.get(
    '/uploads/signed-url',
    { preHandler: [authenticate, requireOrganization()] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const orgId = getOrgId(request);
      const { key } = request.query as { key: string };

      if (!key) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'File key is required', statusCode: 400 },
        });
      }

      // Prevent path traversal and enforce org ownership
      if (!validateUploadKey(key, orgId)) {
        return reply.status(403).send({
          error: { code: 'AUTH_INSUFFICIENT_PERMISSIONS', message: 'Access denied to this resource', statusCode: 403 },
        });
      }

      try {
        const url = await getSignedDownloadUrl(key);
        return reply.send({ url });
      } catch (err) {
        return reply.status(404).send({
          error: { code: 'RESOURCE_NOT_FOUND', message: 'File not found', statusCode: 404 },
        });
      }
    },
  );

  // GET /uploads/files/:orgId/:filename — serve locally stored files (dev mode)
  if (useLocalStorage) {
    fastify.get(
      '/uploads/files/:orgId/:filename',
      { preHandler: [authenticate, requireOrganization()] },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const { orgId, filename } = request.params as { orgId: string; filename: string };
        const key = `${orgId}/${filename}`;

        // Prevent path traversal AND cross-org reads: the key must belong to
        // the caller's own organization.
        if (!validateUploadKey(key, getOrgId(request))) {
          return reply.status(403).send({
            error: { code: 'AUTH_INSUFFICIENT_PERMISSIONS', message: 'Access denied', statusCode: 403 },
          });
        }

        const filePath = getLocalFilePath(key);

        try {
          const stat = await fs.stat(filePath);
          if (!stat.isFile()) throw new Error('Not a file');

          const ext = path.extname(filename).toLowerCase();
          // No SVG here — it executes scripts when opened from this origin.
          const mimeMap: Record<string, string> = {
            '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
            '.gif': 'image/gif', '.webp': 'image/webp',
            '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv',
            '.mp4': 'video/mp4', '.mp3': 'audio/mpeg',
            '.doc': 'application/msword', '.zip': 'application/zip',
          };
          const contentType = mimeMap[ext] || 'application/octet-stream';

          const fileBuffer = await fs.readFile(filePath);
          // attachment + nosniff: <img> tags still render these, but a direct
          // navigation downloads instead of executing anything in our origin.
          return reply
            .header('Content-Type', contentType)
            .header('Content-Disposition', 'attachment')
            .header('X-Content-Type-Options', 'nosniff')
            .header('Cache-Control', 'public, max-age=31536000')
            .send(fileBuffer);
        } catch {
          return reply.status(404).send({
            error: { code: 'RESOURCE_NOT_FOUND', message: 'File not found', statusCode: 404 },
          });
        }
      },
    );
  }

  // DELETE /uploads — delete a file
  fastify.delete(
    '/uploads',
    { preHandler: [authenticate, requireOrganization()] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const orgId = getOrgId(request);
      const { key } = request.query as { key: string };

      if (!key) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'File key is required', statusCode: 400 },
        });
      }

      // Prevent path traversal and enforce org ownership
      if (!validateUploadKey(key, orgId)) {
        return reply.status(403).send({
          error: { code: 'AUTH_INSUFFICIENT_PERMISSIONS', message: 'Access denied to this resource', statusCode: 403 },
        });
      }

      try {
        await deleteFile(key);
        return reply.status(204).send();
      } catch (err) {
        return reply.status(502).send({
          error: { code: 'INTERNAL_ERROR', message: 'Failed to delete file', statusCode: 502 },
        });
      }
    },
  );
}
