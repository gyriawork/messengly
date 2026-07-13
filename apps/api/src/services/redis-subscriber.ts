// ─── Redis Pub/Sub Subscriber ───
// Subscribes to the `ws:events` Redis channel and relays events to Socket.io.
// The worker publishes broadcast status updates (and history sync notifications)
// to this channel. Without this subscriber, those events never reach the frontend.

import IORedis from 'ioredis';
import { getIO } from '../websocket/index.js';

let subscriber: IORedis | null = null;

export function startRedisSubscriber(): IORedis {
  if (subscriber) return subscriber;

  subscriber = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379');

  // Unhandled 'error' events crash the process; ioredis reconnects itself.
  subscriber.on('error', (err) => console.error('[RedisSubscriber] error:', err?.message ?? String(err)));

  subscriber.subscribe('ws:events').catch((err) => {
    console.error('[RedisSubscriber] Failed to subscribe to ws:events:', err);
  });

  subscriber.on('message', (_channel: string, message: string) => {
    try {
      const payload = JSON.parse(message) as {
        event: string;
        room: string;
        data: unknown;
      };

      const io = getIO();
      io.to(payload.room).emit(payload.event, payload.data);
    } catch (err) {
      console.error('[RedisSubscriber] Failed to relay message:', err);
    }
  });

  console.log('[RedisSubscriber] Subscribed to ws:events channel');
  return subscriber;
}

export function stopRedisSubscriber(): void {
  if (subscriber) {
    subscriber.disconnect();
    subscriber = null;
  }
}
