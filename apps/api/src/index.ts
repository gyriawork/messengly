import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import compress from '@fastify/compress';
import prisma from './lib/prisma.js';
import authRoutes from './routes/auth.js';
import organizationRoutes from './routes/organizations.js';
import userRoutes from './routes/users.js';
import messageRoutes from './routes/messages.js';
import chatRoutes from './routes/chats.js';
import chatPreferenceRoutes from './routes/chat-preferences.js';
import tagRoutes from './routes/tags.js';
import integrationRoutes from './routes/integrations.js';
import broadcastRoutes from './routes/broadcasts.js';
import settingsRoutes from './routes/settings.js';
import templateRoutes from './routes/templates.js';
import activityRoutes from './routes/activity.js';
import analyticsRoutes from './routes/analytics.js';
import workspaceRoutes from './routes/workspace-settings.js';
import uploadRoutes from './routes/uploads.js';
import webhookRoutes from './routes/webhooks.js';
import oauthRoutes from './routes/oauth.js';
import adminRoutes from './routes/admin.js';
import wikiRoutes from './routes/wiki.js';
import imageProxyRoutes from './routes/image-proxy.js';
import { createWebSocketServer } from './websocket/index.js';
import { validateEnv } from './lib/env.js';
import { startRedisSubscriber, stopRedisSubscriber } from './services/redis-subscriber.js';
import { getTelegramManager } from './services/telegram-connection-manager.js';
import { csrfProtection } from './middleware/csrf.js';
import { repairDatabase } from './db-repair.js';

const env = validateEnv();

// Ensure critical DB columns exist (handles stuck migrations)
await repairDatabase();

// ─── Create server ───

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    transport:
      process.env.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  },
});

// ─── Plugins ───

await fastify.register(cors, {
  origin: (origin, cb) => {
    const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
    const allowedOrigins = [appUrl, 'http://localhost:3000'];
    const netlifyUrl = process.env.NETLIFY_DEPLOY_URL;
    if (netlifyUrl) allowedOrigins.push(netlifyUrl);

    if (!origin || allowedOrigins.includes(origin)) {
      cb(null, true);
    } else {
      cb(null, false);
    }
  },
  credentials: true,
  /**
   * Cross-origin JavaScript can only read the CORS-safelisted response headers
   * unless they are named here. The web app lives on a different origin than the
   * API (localhost:3000 vs :3001, messengly.app vs Railway), so without this the
   * Teams login screen cannot tell whether a frame carried a completed login.
   *
   * meetsbroadcast never needed it: nginx proxies /api to the backend, so its
   * frontend and API share one origin.
   */
  exposedHeaders: ['X-Logged-In'],
});

await fastify.register(helmet, {
  contentSecurityPolicy: false, // CSP handled by frontend
});

await fastify.register(compress, {
  threshold: 1024, // Only compress responses > 1KB
});

await fastify.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
});

await fastify.register(cookie);

fastify.addHook('onRequest', csrfProtection);

await fastify.register(multipart, {
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

// ─── Body size limit ───

fastify.addContentTypeParser(
  'application/json',
  { parseAs: 'string', bodyLimit: 10 * 1024 * 1024 }, // 10 MB
  (request, body, done) => {
    try {
      // Store raw body string for webhook signature verification (e.g. Slack)
      (request as unknown as Record<string, unknown>).rawBody = body as string;
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  },
);

// ─── Routes ───

// Webhooks registered first — they don't require auth
await fastify.register(webhookRoutes, { prefix: '/api' });

await fastify.register(authRoutes, { prefix: '/api/auth' });
await fastify.register(organizationRoutes, { prefix: '/api/organizations' });
await fastify.register(userRoutes, { prefix: '/api/users' });
await fastify.register(messageRoutes, { prefix: '/api' });
await fastify.register(chatRoutes, { prefix: '/api' });
await fastify.register(chatPreferenceRoutes, { prefix: '/api' });
await fastify.register(tagRoutes, { prefix: '/api' });
await fastify.register(integrationRoutes, { prefix: '/api' });
await fastify.register(broadcastRoutes, { prefix: '/api' });
// broadcastAnalyticsRoutes removed — analytics route is already in broadcastRoutes
await fastify.register(settingsRoutes, { prefix: '/api' });
await fastify.register(templateRoutes, { prefix: '/api' });
await fastify.register(activityRoutes, { prefix: '/api' });
await fastify.register(analyticsRoutes, { prefix: '/api' });
await fastify.register(workspaceRoutes, { prefix: '/api' });
await fastify.register(uploadRoutes, { prefix: '/api' });
await fastify.register(oauthRoutes, { prefix: '/api' });
await fastify.register(adminRoutes, { prefix: '/api' });
await fastify.register(wikiRoutes, { prefix: '/api' });
await fastify.register(imageProxyRoutes, { prefix: '/api' });

// Health check — shallow (for load balancers)
fastify.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

// Deep health check — verifies DB and Redis connectivity
fastify.get('/health/deep', async (_request, reply) => {
  const checks: Record<string, { status: string; latencyMs?: number; error?: string }> = {};

  // PostgreSQL
  const dbStart = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = { status: 'ok', latencyMs: Date.now() - dbStart };
  } catch (err) {
    checks.database = { status: 'error', latencyMs: Date.now() - dbStart, error: err instanceof Error ? err.message : 'Unknown' };
  }

  // Redis (via cache module ping)
  const redisStart = Date.now();
  try {
    const { cacheGet } = await import('./lib/cache.js');
    await cacheGet('health:ping'); // read attempt is enough to verify connectivity
    checks.redis = { status: 'ok', latencyMs: Date.now() - redisStart };
  } catch (err) {
    checks.redis = { status: 'error', latencyMs: Date.now() - redisStart, error: err instanceof Error ? err.message : 'Unknown' };
  }

  const allOk = Object.values(checks).every((c) => c.status === 'ok');
  return reply.status(allOk ? 200 : 503).send({
    status: allOk ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    checks,
  });
});

// ─── Error handler ───

fastify.setErrorHandler((error, _request, reply) => {
  // Rate limit errors
  if (error.statusCode === 429) {
    return reply.status(429).send({
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests, please try again later',
        statusCode: 429,
      },
    });
  }

  // Validation errors from Fastify schema
  if (error.validation) {
    return reply.status(422).send({
      error: {
        code: 'VALIDATION_ERROR',
        message: error.message,
        statusCode: 422,
      },
    });
  }

  // Log unexpected errors
  fastify.log.error(error);

  return reply.status(error.statusCode ?? 500).send({
    error: {
      code: 'INTERNAL_ERROR',
      message:
        process.env.NODE_ENV === 'development'
          ? error.message
          : 'Internal server error',
      statusCode: error.statusCode ?? 500,
    },
  });
});

// ─── Start ───

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

try {
  await fastify.listen({ port: PORT, host: HOST });
  fastify.log.info(`Server listening on ${HOST}:${PORT}`);

  // Attach Socket.io to the same HTTP server
  const httpServer = fastify.server;
  const io = createWebSocketServer(httpServer);
  fastify.log.info('WebSocket server attached');

  // Start Redis subscriber to relay worker events to WebSocket
  startRedisSubscriber();

  // Start persistent Telegram connections for incoming messages
  getTelegramManager().startAll().catch((err) => {
    fastify.log.error(err, 'Failed to start Telegram connection manager');
  });
} catch (err) {
  fastify.log.fatal(err);
  process.exit(1);
}

// ─── Graceful shutdown ───

async function shutdown(signal: string) {
  fastify.log.info(`Received ${signal}, shutting down gracefully`);
  await getTelegramManager().shutdown();
  stopRedisSubscriber();
  await fastify.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
