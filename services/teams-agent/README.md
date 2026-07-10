# teams-agent

A private HTTP service that drives the Microsoft Teams web UI with Playwright, so Messengly can
list Teams chats and send broadcasts through them.

Ported from the **meetsbroadcast** project, which has run this agent in production for months.
There is no Microsoft Graph API here: personal Microsoft accounts offer no Graph path for sending
as the user, so the only route is automating `teams.live.com/v2/` in a real browser.

## Why it is a separate service

Playwright needs Chromium (~400 MB) and a long-lived browser process. Bundling it into `apps/worker`
would bloat the image and lose the browser on every deploy restart; `apps/api` would need it too,
for chat scanning. Isolating it also keeps the residential proxy and the session volume in one place.

This mirrors how WhatsApp already works in Messengly, via the external `waha` service.

It deliberately lives in `services/`, **not** `apps/`. The root `package.json` declares workspaces as
`["apps/*", "packages/*"]`, and Netlify builds the frontend with `npm install` at the root — which
would install every workspace's dependencies, dragging a Chromium download into the web build.

## Endpoints

All routes except `/health` require the `X-Api-Key` header.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | liveness; also reports `hasSession`, `busy`, `queueDepth` |
| `GET` | `/session/status` | `active` \| `expired` \| `unknown` |
| `POST` | `/session/check` | force a real re-check (drives a navigation) |
| `POST` | `/session/remote/start` | launch the login browser |
| `GET` | `/session/remote/screenshot` | JPEG frame; `X-Logged-In` header; auto-saves on success |
| `POST` | `/session/remote/click` | `{ x, y }` |
| `POST` | `/session/remote/type` | `{ text }` (≤ 500 chars) |
| `POST` | `/session/remote/key` | `{ key }` from a small allowlist |
| `POST` | `/session/remote/save` | persist the session (refuses unless chats are visible) |
| `POST` | `/session/remote/stop` | tear the login browser down |
| `GET` | `/session/export` | download `storageState` for backup |
| `POST` | `/session/destroy` | sign out and delete the session |
| `GET` | `/chats` | `[{ threadId, name, type }]` |
| `POST` | `/messages` | `{ threadId, text, html?, attachments?, requestId? }` |

### Send outcomes

`POST /messages` distinguishes three cases, and the caller must respect them:

| Response | Meaning | Retry? |
|---|---|---|
| `200 { ok: true }` | delivered | — |
| `200 { ok: false, retriable: true }` | never left the compose box | yes |
| `200 { ok: false, retriable: false }` | may have been delivered, could not confirm | **no** — retrying duplicates it |
| `409 SESSION_EXPIRED` | re-login required | no |
| `404 CHAT_NOT_FOUND` | chat is not in the sidebar | no |
| `422 ATTACHMENT_UNSUPPORTED` | e.g. a PDF to a group chat | no |

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3004` | |
| `TEAMS_AGENT_API_KEY` | — | **required in production**; the process refuses to start without it |
| `DATA_DIR` | `./data` | session and debug snapshots live here; mount a volume in production |
| `AGENT_PROXY_URL` | — | residential/ISP proxy; **required in production** (see below) |
| `HEADED` | `false` | `true` shows the browser locally |
| `TEAMS_SEND_JITTER_MIN_MS` / `_MAX_MS` | `3000` / `10000` | random pause before each send |
| `TEAMS_LOCK_TIMEOUT_MS` | `600000` | how long a request waits for the single browser |
| `TEAMS_MAX_ATTACHMENT_BYTES` | `31457280` | 30 MB |
| `LOG_PRETTY` | `false` | human-readable logs |

## Running locally

```bash
npm install
LOG_PRETTY=true TEAMS_AGENT_API_KEY=dev npm start
curl -H 'X-Api-Key: dev' localhost:3004/session/status
```

Logging in requires driving the remote browser from Messengly's Integrations screen. From a home or
office IP no proxy is needed.

## Deployment

A Railway service with `rootDirectory: services/teams-agent`, this `Dockerfile`, and a **volume
mounted at `/data`**. The session is the only durable state; it is not covered by Messengly's
database backups, so `GET /session/export` exists as a backup hatch.

## Things that will bite you

- **Selectors rot.** Everything hinges on undocumented `data-tid` attributes and Russian-locale text
  anchors (`text="Личное"`). Microsoft reworks them periodically. `src/agent/selectors.js` is the
  single choke point — keep it that way. `inspectChatReadiness()` dumps a live `data-tid` inventory,
  which is how you find the new names.
- **Datacenter IPs are blocked.** Teams refuses connections from cloud hosts. Production needs
  `AGENT_PROXY_URL`.
- **Group chats accept images only.** Chromium's clipboard API writes only `image/png`, and group
  chats expose no file picker. A PDF cannot reach a group chat.
- **Sessions last hours to days** and cannot be refreshed programmatically. Re-login is a human,
  browser-in-the-loop action.
- **The compose box emptying is the only reliable proof a message was sent.** The feed is virtualized,
  so counting message bubbles lies. Do not "optimize" `verifyMessage`.

## Deviations from meetsbroadcast

1. **Chats are identified by `threadId`, not display name.** meetsbroadcast parsed the stable id out
   of the DOM and then threw it away, keying its database on `chat_name`. Messengly needs
   `externalChatId`, and renaming a chat should not orphan it.
2. **`saveSession()` demands positive proof.** The original only rejected a session when Teams showed
   its "sign in again" banner. The signed-out marketing page at `teams.live.com/v2/` shows no banner
   and no chats, so an unauthenticated session was happily persisted. We now require that the chat
   list actually rendered.
3. **`cleanup()` removes only its own `disconnected` listener.** `removeAllListeners('disconnected')`
   also strips the internal once-listener that resolves the promise `browser.close()` awaits —
   Chromium dies, but `close()` hangs forever.
4. **The mutex waits 10 minutes, not 60 seconds.** Messengly's broadcast worker runs three jobs
   concurrently; a 60 s timeout would fail the queued ones for no reason.
