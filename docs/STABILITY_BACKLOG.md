# Stability backlog

Agreed 2026-07-10 after the MS Teams launch. Ordered by (likelihood × damage).
Items 1–2 from the original list are done (worker skips inactive chats up front;
send idempotency guard + two-consecutive-misses rule for inactive marking).

## 1. Scheduled Teams session check

A Teams session lasts hours to days and today its death is discovered by the
first failed broadcast. Add a BullMQ repeatable job (~every 30 min) that calls
the teams-agent `GET /session/status`; on `expired`, set the Integration to
`session_expired`, emit the `integration_status_changed` ws event, and let the
dashboard badge go amber — so the re-login (human, MFA) happens *before* a
broadcast, not after it fails.

## 2. Daily encrypted session backup

The Railway volume holding the Teams session is not covered by database
backups; losing it means a manual MFA re-login. The agent already exposes
`GET /session/export`. A daily worker cron should download it, encrypt with
`CREDENTIALS_ENCRYPTION_KEY`, and upload to R2. Document the restore path
(volume → `/data/state/session.json`).

## 3. Auto-flag the integration on repeated Teams send failures

When Microsoft reworks the Teams DOM, sends start dying as selector timeouts
and the circuit breaker halts batches — but the Integration still says
`connected`. On a halt (or N consecutive selector-shaped failures), flip the
Integration to `error` and surface it on the dashboard. Debug snapshots and
`inspectChatReadiness()` already exist for the actual repair.

## 4. WebSocket reconnect with a fresh access token

The socket.io client reconnects with the JWT captured at connect time; after
the 15-minute expiry a long-lived tab loops on `websocket error` forever and
live updates silently stop (observed locally 2026-07-10). On auth failure the
client should refresh the access token (same path HTTP 401 handling uses) and
reconnect with it.

## Known, accepted (not scheduled)

- One Teams session serves the whole system (WAHA-Core model). A second
  organization connecting Teams would see the same account's chats — fine
  while there is one org; must be redesigned before multi-tenant Teams.
- Prisma migration history is dirty (19 DB records vs 14 files) and
  `BroadcastChat.deletedAt` exists only via `repairDatabase()`. Align before
  the next big schema change; never run `prisma migrate dev` against a DB you
  care about — use `migrate deploy`.
- Railway CLI (`railway up`) builds die at Metal-builder scheduling for this
  account; deploys go through GitHub-linked builds. If those break too, the
  fallback is deploying prebuilt Docker images.
