import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import IORedis from 'ioredis';
import jwt from 'jsonwebtoken';
import prisma from '../lib/prisma.js';
import { cacheInvalidate, cacheKey } from '../lib/cache.js';

// ─── Types ───

interface JwtPayload {
  id: string;
  email: string;
  name: string;
  role: string;
  organizationId: string | null;
}

interface SocketUser {
  id: string;
  email: string;
  name: string;
  role: string;
  organizationId: string | null;
}

// ─── Singleton ───

let io: Server | null = null;

/**
 * Returns the Socket.io server instance. Throws if called before
 * `createWebSocketServer()`. Use this in route handlers to emit events.
 */
export function getIO(): Server {
  if (!io) {
    throw new Error('WebSocket server has not been initialized. Call createWebSocketServer() first.');
  }
  return io;
}

// ─── Helpers ───

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set');
  return secret;
}

/**
 * Verify that a chat belongs to the given organization.
 */
async function chatBelongsToOrg(chatId: string, organizationId: string): Promise<boolean> {
  const chat = await prisma.chat.findFirst({
    where: { id: chatId, organizationId },
    select: { id: true },
  });
  return chat !== null;
}

// ─── Typing throttle state ───

const typingThrottle = new Map<string, number>(); // `userId:chatId` → last emit timestamp
const TYPING_THROTTLE_MS = 2000;

// Periodic cleanup of stale typing throttle entries (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, lastTime] of typingThrottle.entries()) {
    if (now - lastTime > 300_000) {
      typingThrottle.delete(key);
    }
  }
}, 300_000);

// ─── mark_read debounce state ───

const markReadPending = new Map<string, NodeJS.Timeout>(); // `userId:chatId` → timer
const MARK_READ_DEBOUNCE_MS = 300;

// ─── Factory ───

/**
 * Creates and configures the Socket.io server, attaching it to the provided
 * HTTP server so it shares the same port as Fastify.
 */
export function createWebSocketServer(httpServer: HttpServer): Server {
  if (io) return io;

  io = new Server(httpServer, {
    cors: {
      origin: process.env.APP_URL ?? 'http://localhost:3000',
      credentials: true,
    },
    path: '/socket.io',
  });

  // ── Authentication middleware ──

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;

    if (!token) {
      return next(new Error('Authentication required'));
    }

    try {
      // Pin the algorithm like middleware/auth.ts does — never accept
      // whatever alg the token header claims.
      const payload = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] }) as JwtPayload;

      // Attach user data to socket
      (socket.data as { user: SocketUser }).user = {
        id: payload.id,
        email: payload.email,
        name: payload.name,
        role: payload.role,
        organizationId: payload.organizationId,
      };

      next();
    } catch {
      next(new Error('Invalid or expired token'));
    }
  });

  // ── Connection handler ──

  io.on('connection', (socket) => {
    const user = (socket.data as { user: SocketUser }).user;

    // Automatically join the organization room
    if (user.organizationId) {
      socket.join(`org:${user.organizationId}`);
    }

    // Join a personal room for user-specific events (e.g., WhatsApp QR pairing)
    socket.join(`user:${user.id}`);
    console.log(`[WS] User connected: ${user.id} (${user.email}), socket: ${socket.id}`);

    // Broadcast online status to org
    if (user.organizationId) {
      socket.to(`org:${user.organizationId}`).emit('presence', {
        userId: user.id,
        userName: user.name,
        status: 'online',
      });
    }

    // ── join_chat ──

    socket.on('join_chat', async (data: { chatId: string }) => {
      const { chatId } = data;

      if (!chatId || !user.organizationId) {
        socket.emit('error', { message: 'Invalid chatId or no organization' });
        return;
      }

      const belongs = await chatBelongsToOrg(chatId, user.organizationId);
      if (!belongs) {
        socket.emit('error', { message: 'Chat not found or access denied' });
        return;
      }

      socket.join(`chat:${chatId}`);
    });

    // ── leave_chat ──

    socket.on('leave_chat', (data: { chatId: string }) => {
      const { chatId } = data;
      if (chatId) {
        socket.leave(`chat:${chatId}`);
      }
    });

    // ── typing ──

    socket.on('typing', async (data: { chatId: string }) => {
      const { chatId } = data;
      if (!chatId || !user.organizationId) return;

      // Verify the user's org owns this chat before broadcasting
      const belongs = await chatBelongsToOrg(chatId, user.organizationId);
      if (!belongs) return;

      // Throttle: one typing event per user per chat every TYPING_THROTTLE_MS
      const key = `${user.id}:${chatId}`;
      const now = Date.now();
      const lastEmit = typingThrottle.get(key) ?? 0;

      if (now - lastEmit < TYPING_THROTTLE_MS) return;

      typingThrottle.set(key, now);

      // Broadcast to room, excluding the sender
      socket.to(`chat:${chatId}`).emit('typing', {
        chatId,
        userId: user.id,
        userName: user.name,
      });
    });

    // ── mark_read ──

    socket.on('mark_read', async (data: { chatId: string; messageId: string }) => {
      const { chatId, messageId } = data;

      if (!chatId || !user.organizationId) return;

      const belongs = await chatBelongsToOrg(chatId, user.organizationId);
      if (!belongs) return;

      // Debounce: batch writes per user-chat pair
      const key = `${user.id}:${chatId}`;
      const existing = markReadPending.get(key);
      if (existing) clearTimeout(existing);

      markReadPending.set(
        key,
        setTimeout(async () => {
          markReadPending.delete(key);
          await prisma.chatPreference.upsert({
            where: {
              userId_chatId: {
                userId: user.id,
                chatId,
              },
            },
            update: { unread: false },
            create: {
              userId: user.id,
              chatId,
              unread: false,
            },
          });
          if (user.organizationId) {
            await cacheInvalidate(cacheKey(user.organizationId, 'chats', '*'));
          }
        }, MARK_READ_DEBOUNCE_MS),
      );
    });

    // ── disconnect ──

    socket.on('disconnect', () => {
      // Broadcast offline status
      if (user.organizationId) {
        socket.to(`org:${user.organizationId}`).emit('presence', {
          userId: user.id,
          userName: user.name,
          status: 'offline',
        });
      }

      // Clean up typing throttle entries for this user
      for (const [key] of typingThrottle) {
        if (key.startsWith(`${user.id}:`)) {
          typingThrottle.delete(key);
        }
      }

      // Clean up markReadPending timers for this user
      for (const [key, timer] of markReadPending) {
        if (key.startsWith(`${user.id}:`)) {
          clearTimeout(timer);
          markReadPending.delete(key);
        }
      }
    });
  });

  // ── Redis subscriber for worker events ──

  const ALLOWED_WS_EVENTS = new Set([
    'new_message', 'message_updated', 'message_deleted',
    'typing', 'mark_read', 'chat_updated', 'new_reaction',
    'broadcast_status', 'broadcast_progress', 'sync_progress',
    'integration_status_changed',
  ]);

  const redisSub = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    retryStrategy(times) {
      const delay = Math.min(times * 200, 5000);
      console.warn(`[ws:redis] Reconnecting subscriber (attempt ${times}, delay ${delay}ms)`);
      return delay;
    },
    maxRetriesPerRequest: null,
  });

  redisSub.on('error', (err) => {
    console.error('[ws:redis] Subscriber error:', err.message);
  });

  redisSub.on('reconnecting', () => {
    console.warn('[ws:redis] Subscriber reconnecting...');
  });

  redisSub.on('connect', () => {
    console.info('[ws:redis] Subscriber connected');
  });

  redisSub.subscribe('ws:events').catch((err) => {
    console.error('Failed to subscribe to ws:events', err);
  });

  redisSub.on('message', (_channel: string, message: string) => {
    try {
      const parsed = JSON.parse(message) as {
        event: string;
        room: string;
        data: unknown;
      };

      // Validate event name against whitelist to prevent arbitrary event emission
      if (!parsed.event || !parsed.room || !ALLOWED_WS_EVENTS.has(parsed.event)) {
        console.warn(`[ws:redis] Rejected unknown event: ${parsed.event}`);
        return;
      }

      // A background status change (e.g. the worker found a dead account) must
      // also bust the cached integrations list, or the browser's refetch would
      // just re-read the 5-min-stale "connected" (M6).
      if (parsed.event === 'integration_status_changed' && parsed.room.startsWith('org:')) {
        const orgId = parsed.room.slice(4);
        void cacheInvalidate(cacheKey(orgId, 'integrations', '*'));
      }

      io!.to(parsed.room).emit(parsed.event, parsed.data);
    } catch (err) {
      console.error('Failed to parse ws:events message', err);
    }
  });

  return io;
}
