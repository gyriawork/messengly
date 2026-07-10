# Microsoft Teams Integration — Design

**Date:** 2026-07-10
**Status:** Approved
**Scope:** new `services/teams-agent` sidecar + `teams` adapter in `apps/api` and `apps/worker` + `teams` surfaces in `apps/web`

## Problem

A separate product, **meetsbroadcast**, has been running Microsoft Teams broadcasts in production
for months. Messengly needs the same capability: log in to Teams, discover chats, and include Teams
chats in mass broadcasts alongside Telegram, Slack, WhatsApp and Gmail.

The original task description said this should go "through the Microsoft Graph API". **It does not,
and cannot as written.** meetsbroadcast has no Graph API integration at all — no `msal`, no
`@microsoft/microsoft-graph-client` in its dependencies. What it actually does is drive the
`teams.live.com/v2/` **web UI with Playwright**, using a persisted browser session. Personal
Microsoft accounts have no Graph-API path for sending as the user, which is why the browser route
exists.

So this is a port of a browser-automation agent, not an API client.

## Goal

Teams becomes the **fifth messenger** in Messengly, indistinguishable from the others to the rest of
the system:

1. An operator logs in to Teams from Messengly's Integrations screen.
2. Teams chats are scanned and imported into the existing `Chat` model.
3. Broadcasts can target Teams chats alongside any other messenger.
4. No existing behaviour changes.

## Non-goals

- Reading Teams messages: no history sync, no incoming messages, no webhooks.
  meetsbroadcast does not do this either — it only scans the chat list and sends.
- Multiple Teams accounts. One account serves the whole system (mirrors WAHA Core's single
  `default` session).
- Editing or deleting sent Teams messages.
- Fixing Messengly's pre-existing send-then-mark idempotency gap (documented below).

## Key differences between the two systems

| | meetsbroadcast | Messengly |
|---|---|---|
| Tenancy | single user, single account | multi-tenant (`organizationId`) |
| Storage | SQLite | Postgres + Prisma |
| Jobs | `node-cron` + in-process orchestrator | BullMQ + Redis |
| Chat identity | **display name** (`chats.chat_name UNIQUE`) | `externalChatId` |
| Messages | none stored | full `Message` model |

## Architecture

```
apps/web    → Teams login screen; `teams` in every messenger list
apps/api    → lib/teams-client.ts, integrations/teams.ts, remote-login proxy routes
apps/worker → lib/teams-client.ts, integrations/teams.ts (sendMessage)
                        │  HTTP: TEAMS_AGENT_URL + X-Api-Key
                        ▼
services/teams-agent  ← NEW Railway service: Playwright + Chromium
                        volume /data, AGENT_PROXY_URL (residential proxy)
```

Teams plugs into the **existing** messenger abstraction. Everything already messenger-agnostic picks
it up for free: the `broadcast` BullMQ queue, the per-messenger grouping in `sendMessengerBatch`
(`apps/worker/src/index.ts`), the `ws:events` Redis bridge, `useSocket`, and the Prisma models
(`messenger` is a plain `String` — **no migration required**).

### Why `services/` and not `apps/`

The root `package.json` declares workspaces as `["apps/*", "packages/*"]`, and Netlify builds the
frontend with a bare `npm install` at the repository root — which installs every workspace's
dependencies. An `apps/teams-agent` would therefore drag a 150 MB Chromium download into every web
build. `services/` sits outside the glob, so the sidecar keeps its own lockfile and `node_modules`.

### Why a sidecar

Playwright needs Chromium (~400 MB) and a long-lived browser process. Putting it in `apps/worker`
would bloat the image, and the worker restarts on every deploy — killing the browser and the login
session. `apps/api` would need Chromium too, since chat scanning happens there. A separate service
isolates the browser, the proxy, and the session volume. This mirrors how WhatsApp already works via
the external `waha` service.

### Session storage

The Playwright `storageState` (~160 KB, mostly the MSAL cache in `localStorage`) lives on the
sidecar's **persistent Railway volume** at `/data/state/session.json`. That is the source of truth.

`Integration.credentials` stores only `{ status, lastCheckAt }`. This matches WhatsApp, where
Messengly stores a pointer (`wahaSessionName`) and WAHA owns the real session.

Rejected alternative: storing `storageState` encrypted in `Integration.credentials`. It would push
160 KB through AES-GCM on every broadcast batch, add a push/pull contract on every `connect()`, and
create a rot vector where the DB says `connected` while the cookies are dead. The one real advantage
— surviving volume loss — is covered more cheaply by a `GET /session/export` backup endpoint.

## The sidecar

Roughly 1600 lines are **copied, not rewritten**, from `meetsbroadcast/backend/src/agent/`:
`browser.js`, `remoteBrowser.js`, `selectors.js`, `sidebar.js`, `scanChats.js`, `sendMessage.js`,
`checkSession.js`, `lock.js`, `proxy.js`, `debug.js`, `util/normalizeEmoji.js`.

`teamsLogin.js` (419 lines of automated form-filling) is **not** ported — the streamed remote browser
covers login, including MFA and passwordless email codes, which form-filling handles poorly.

### HTTP surface (Express, `X-Api-Key`)

| Endpoint | Ported from |
|---|---|
| `GET /health` | new (Railway healthcheck) |
| `GET /session/status` → `active \| expired \| unknown` | `checkSession.js` |
| `POST /session/check` | `checkSession.js` |
| `POST /remote/start`, `GET /remote/screenshot`, `POST /remote/{click,type,key,save,stop}` | `remoteBrowser.js` verbatim |
| `POST /session/destroy` | `routes/session.js` |
| `GET /session/export` | new (volume is not in DB backups) |
| `GET /chats` → `[{ threadId, name, type }]` | `scanChats.js` + `sidebar.js` |
| `POST /messages` `{ threadId, html, plain, attachments[] }` | `sendMessage.js` verbatim |

### Deviations from the original

The first two were planned. The last two are bugs found while porting; both exist in meetsbroadcast
today.

**1. Return `threadId`, not the chat name.** `sidebar.js` already parses a stable conversation id out
of `data-fui-tree-item-value`, then throws it away — meetsbroadcast keys chats on `chat_name`, so a
renamed chat silently becomes a different chat. Messengly requires `externalChatId`, so the sidecar
returns the `threadId` and sends by `threadId` via `clickChatById`.

**2. Raise the `lock.js` mutex timeout.** 60 s is too short against the broadcast worker's
`concurrency: 3`; two concurrent broadcasts containing Teams chats would fail to acquire. Raised to
10 minutes, with an explicit queue.

**3. `saveSession()` demands positive proof of a login.** The original refused to save only when
Teams displayed its "sign in again" banner. But the signed-out marketing page at `teams.live.com/v2/`
shows no banner and no chats, so an unauthenticated session was persisted and reported as connected —
observed directly: `chatListItems: 0`, `composer: false`, session written to disk. In meetsbroadcast a
human clicks Save only after seeing their chat list, which hides the flaw. In Messengly it would mean
an Integration marked `connected` whose every broadcast fails. The agent now requires that the chat
list actually rendered, and `/session/status` reports `expired` when the sidebar never appears.

**4. `cleanup()` removes only its own `disconnected` listener.** `removeAllListeners('disconnected')`
also strips the internal once-listener that Playwright's `Browser` constructor registers to resolve
the promise `browser.close()` awaits. Chromium dies, `close()` never resolves, and the HTTP request
hangs forever. Measured: `close()` takes 47 ms standalone, and timed out past 90 s through the
service.

### Load-bearing logic that must be ported verbatim

- **"Compose emptied" as the success signal** (`verifyMessage`). The message feed is virtualized, so
  counting message bubbles is unreliable — Teams only clears the compose box once the message has
  actually left.
- **Clear compose before pasting** (Ctrl+A → Delete), or a retry duplicates the text.
- **A unique temp copy of each attachment per send**, or Teams blocks the send with "this file was
  already shared".
- 3–10 s random jitter between chats, the circuit breaker, the canary send, and debug snapshots.

## Messengly integration

Mirrored files in `api` and `worker` follow the **existing convention** — `waha-client.ts`,
`crypto.ts` and `platform-constants.ts` are already duplicated across both apps rather than shared,
to avoid workspace-dependency problems in Railway builds.

- `apps/{api,worker}/src/lib/teams-client.ts` — shaped after `waha-client.ts`.
- `apps/{api,worker}/src/integrations/teams.ts` — `TeamsAdapter implements MessengerAdapter`:
  - `connect()` verifies `/session/status === 'active'`, else reports `session_expired`
  - `listChats()` → `{ externalChatId: threadId, name, chatType }`
  - `sendMessage()` synthesizes `externalMessageId = "teams:<threadId>:<ts>"` — Teams exposes no
    message id in the DOM, and the field is never used for Teams
  - `editMessage` / `deleteMessage` throw `MessengerError`
  - **`getMessages` is not implemented.** The worker already handles this: it logs "does not support
    history fetch" and marks the chats `synced`.

`teams` must also be added to `MESSENGERS`, `MESSENGER_COLORS`, `MESSAGE_EDIT_LIMITS`,
`DEFAULT_ANTIBAN`, `MESSENGER_PLATFORM_FIELDS` (empty), `MESSENGER_ENV_VARS` (empty), to both
`platform-constants.ts` duplicates, and to every zod enum that would otherwise reject it with a 422.

`platform-credentials.ts` needs **no change**: it already short-circuits on
`Object.keys(envMap).length === 0`.

### Anti-ban defaults

Browser automation is slow and conspicuous, so Teams gets conservative numbers:

```ts
teams: { messagesPerBatch: 5, delayBetweenMessages: 8,
         delayBetweenBatches: 300, maxMessagesPerHour: 40, maxMessagesPerDay: 200 }
```

The 3–10 s random jitter stays inside the agent, on top of Messengly's pacing. The duplication is
deliberate: Messengly has no randomization, and randomization is what actually defeats rate-limit
heuristics.

### Three send outcomes, which must not be collapsed

| Agent result | `BroadcastChat` | Retry |
|---|---|---|
| compose emptied | `sent` | — |
| compose never emptied | `failed` | allowed |
| a bubble appeared but did not match | `failed`, `errorReason: "unverified: …"` | **forbidden** |

Retrying the third case duplicates the message in a real chat. The adapter raises distinct errors for
the second and third cases; the UI blocks Retry on `unverified:`.

## Verification

Run in order; do not proceed past a red step.

1. `npm run build` (4 workspaces) + `npm test` in `apps/api`. After any `npm install`, run
   `cd apps/api && npx prisma generate` — install wipes the generated client.
2. Sidecar locally: `GET /health` → 200, `GET /session/status` → `unknown`.
3. Log in through Settings → Integrations → Teams → remote browser. `GET /session/status` → `active`.
4. `POST /integrations/teams/list-chats` returns `externalChatId` equal to the threadId (not a name).
   Import; chats appear on `/chats` with `messenger: teams`.
5. Worker logs "Adapter for teams does not support history fetch, marking as synced".
6. Broadcast to one 1:1 Teams chat → delivered, `BroadcastChat.status = sent`. Then a group chat with
   an image → delivered. Then a group chat with a PDF → **a clear error, not a crash**.
7. Regression: a broadcast mixing Telegram and Slack chats still delivers to both.
8. Kill the worker mid-broadcast and restart: chats already `sent` are not re-sent.

## Known limitations (accepted)

- **Selectors rot.** The integration hinges on undocumented `data-tid` attributes and Russian-locale
  text anchors (`text="Личное"`, `has-text("Войти")`). Microsoft reworks them. `selectors.js` is the
  single choke point and must stay that way.
- **Datacenter IPs are blocked** by Microsoft. Production requires `AGENT_PROXY_URL` pointing at a
  residential/ISP proxy.
- **Group chats accept images only.** Chromium's clipboard API writes only `image/png`, and group
  chats expose no file picker. A PDF cannot be sent to a group chat.
- **Sessions last hours to days** and cannot be refreshed programmatically. Re-login is a human,
  browser-in-the-loop action.
- **The volume is not in database backups.** Losing it means a manual MFA login. Mitigated by
  `GET /session/export`.
- **Messengly's idempotency gap** — if the worker dies between `adapter.sendMessage()` and the
  `status → sent` update, the chat stays `pending` and is re-sent. For Teams that means a **duplicate
  message in a real chat**, not a harmless repeated API call. Not fixed here; recorded.
