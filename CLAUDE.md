# CLAUDE.md — Instructions for Claude Code

## Communication Style

- Always explain changes in simple, non-technical language — as if talking to a regular user, not a programmer
- When something is changed, explain what will change from the user's perspective (e.g. "chats will load faster" instead of "added Redis cache layer")
- Always indicate the risk level of changes: low / medium / high
- Save technical details for code comments and commit messages only — keep chat messages human-friendly
- Use the user's language (Russian if they write in Russian)

## Project Overview

You are building **Messengly V1.1** — a SaaS unified inbox for Telegram, Slack, WhatsApp, and Gmail. Messages are sent as the user (not a bot). The product supports multi-tenant organizations, chat management, mass broadcasts with anti-ban rate limiting, and real-time messaging.

## Documentation (read in this order)

1. **`docs/PRODUCT_SPEC.md`** — Full product specification. All sections, screens, buttons, user flows, permissions matrix. Read this FIRST to understand what you're building.
2. **`docs/TECHNICAL_SPEC.md`** — Architecture, database schema (Prisma), all API endpoints with parameters, WebSocket events, project structure, implementation phases. This is your technical blueprint.
3. **`docs/DESIGN_SYSTEM.md`** — Visual design tokens, colors, typography, component CSS, Tailwind config. Reference when building UI components.
4. **`prototype/index.html`** — Interactive HTML prototype. Open in browser to see how each section should look and behave.

## Monorepo Structure

```
apps/
  web/        → Next.js 14+ frontend (deploys to Netlify)
  api/        → Fastify REST API (deploys to Railway)
  worker/     → BullMQ job processor (deploys to Railway)
packages/
  shared/     → Shared TypeScript types, constants, validators
```

This is a Turborepo monorepo. Use `npm run dev` from root to start all services.

## Tech Stack & Conventions

### General
- TypeScript everywhere (strict mode)
- ESM modules
- Node.js 20+
- Use `npm` (not yarn/pnpm)

### Frontend (`apps/web`)
- **Next.js 14+** with App Router (`src/app/`)
- **Tailwind CSS** with custom theme from `docs/DESIGN_SYSTEM.md`
- **Zustand** for client state (active chat, UI state, user session)
- **React Query (TanStack Query)** for server state (chats, messages, broadcasts)
- **Socket.io Client** for real-time updates
- **React Hook Form + Zod** for forms
- **Lucide React** for icons
- Component files: PascalCase (`ChatList.tsx`, `BroadcastWizard.tsx`)
- Hooks: camelCase with `use` prefix (`useChats.ts`, `useSocket.ts`)
- Pages go in `src/app/(dashboard)/` with layout wrapping sidebar

### Backend (`apps/api`)
- **Fastify** (not Express) — faster, built-in validation
- **Prisma** ORM — schema at `apps/api/prisma/schema.prisma`
- **JWT auth** — access token 15min, refresh token 7 days
- Route files: kebab-case (`chats.ts`, `broadcasts.ts`)
- Every route must check `organizationId` from JWT for multi-tenancy
- Use Fastify schema validation for request/response
- Encrypt OAuth tokens before storing (use `apps/api/src/lib/crypto.ts`)

### Worker (`apps/worker`)
- **BullMQ** queues backed by Redis
- Jobs: broadcast sending, auto-retry, chat import, message sync
- Must be idempotent — worker restarts during deploys
- Use delayed jobs for broadcast rate limiting

### Shared (`packages/shared`)
- TypeScript types matching Prisma models
- Enum constants (messenger types, statuses, roles)
- Zod validators shared between frontend and backend

## Database

- **PostgreSQL** via Prisma
- Schema is in `apps/api/prisma/schema.prisma` (already created)
- Run `npx prisma generate` after schema changes
- Run `npx prisma migrate dev` to create migrations
- Every query MUST filter by `organizationId` (row-level security pattern)
- Superadmin queries can bypass org filter

## Key Patterns

### Multi-tenancy
Every database query must include `WHERE organizationId = ?`. Extract `organizationId` from the JWT token in middleware. Superadmin role can access multiple orgs.

### Real-time Messages
1. Messenger webhook/event → API receives incoming message
2. API saves to PostgreSQL
3. API publishes to Redis pub/sub channel `org:{orgId}:chat:{chatId}`
4. WebSocket service subscribes → pushes to connected browser via Socket.io
5. Frontend React Query invalidation + optimistic update

### Broadcast Engine
1. User creates broadcast → saved as `draft` in PostgreSQL
2. On send → API creates parent BullMQ job
3. Parent job splits into per-messenger batches using antiban settings
4. Each message = child job with calculated `delay` (seconds between sends)
5. Worker processes jobs, sends via messenger adapter
6. On failure → job moves to retry queue with exponential backoff (delay × 2^attempt)
7. Status updates via Redis pub/sub → WebSocket → frontend

### Chat Import
Chats don't appear automatically. Users explicitly import via `+ Add Chat`:
1. Frontend calls `GET /api/chats/available/:messenger`
2. API calls messenger's list-dialogs API
3. User selects chats → `POST /api/chats/import`
4. API creates Chat records, subscribes to messenger webhooks
5. Worker syncs message history in background

### Chat Preferences (Pin/Favorite/Mute)
These are per-user, stored in `ChatPreference` table. They affect only the Messenger left panel display, not the underlying chat data. Use a separate API endpoint `PATCH /api/chats/:id/preferences`.

## Security Requirements

### Authentication
- JWT access tokens (15 min expiry) in Authorization header
- Refresh tokens (7 days) stored in `RefreshToken` table with httpOnly cookie
- bcrypt for password hashing (cost factor 12)
- Rate limit login endpoint: 5 attempts per minute per IP

### OAuth Token Encryption
- All messenger OAuth tokens and session data stored in `Integration.credentials`
- Must be encrypted at rest using AES-256-GCM
- Encryption key from env: `CREDENTIALS_ENCRYPTION_KEY`
- Implement in `apps/api/src/lib/crypto.ts`:
  ```typescript
  export function encrypt(data: string): string  // returns base64
  export function decrypt(encrypted: string): string
  ```

### API Security
- CORS: allow only `APP_URL` origin
- Helmet middleware for security headers
- Request body size limit: 10MB
- Rate limiting: 100 req/min per user (general), 10 req/min for auth endpoints
- Input validation on every endpoint (Fastify schema or Zod)
- SQL injection prevention via Prisma (parameterized queries)
- XSS prevention: sanitize user-generated content before storing

### RBAC Middleware
Create `apps/api/src/middleware/rbac.ts`:
```typescript
// Usage: fastify.get('/orgs', { preHandler: [requireRole('superadmin')] }, handler)
export function requireRole(...roles: string[])
export function requireOrganization()  // ensures user belongs to accessed org
```

## Error Handling

### API Error Format
```json
{
  "error": {
    "code": "CHAT_NOT_FOUND",
    "message": "Chat with id xyz not found",
    "statusCode": 404
  }
}
```

### Error Codes
- `AUTH_INVALID_CREDENTIALS` (401)
- `AUTH_TOKEN_EXPIRED` (401)
- `AUTH_INSUFFICIENT_PERMISSIONS` (403)
- `RESOURCE_NOT_FOUND` (404)
- `VALIDATION_ERROR` (422)
- `RATE_LIMIT_EXCEEDED` (429)
- `MESSENGER_API_ERROR` (502)
- `MESSENGER_RATE_LIMITED` (429)
- `INTERNAL_ERROR` (500)

### Frontend Error Handling
- React Query `onError` → toast notification
- 401 responses → auto-refresh token, retry once, then redirect to login
- Network errors → "Connection lost" banner with auto-retry
- Messenger-specific errors → show in chat UI with retry button

## Testing

- Use **Vitest** for unit tests
- Use **Playwright** for E2E tests (Phase 5)
- Test files next to source: `chats.test.ts` alongside `chats.ts`
- Minimum: test all API route handlers, test broadcast job processing, test RBAC middleware

## Implementation Order

Follow the phases in TECHNICAL_SPEC.md:

### Phase 1: Foundation (start here)
1. `npm init` for each app, install dependencies
2. Copy `schema.prisma`, run `prisma generate` and `prisma migrate dev`
3. Implement auth (register, login, refresh, JWT middleware)
4. Implement RBAC middleware
5. Organization CRUD (superadmin)
6. User management (invite, roles)
7. Basic frontend: login page, sidebar layout, routing

### Phase 2: Chats & Messenger
8. Chat CRUD + import mechanism
9. Messages CRUD
10. WebSocket setup (Socket.io server + client)
11. Messenger UI (3-column layout)
12. Chat list features (search, filter, sort, group, pin, favorite, mute)
13. Message actions (reply, edit, forward, pin, delete)

### Phase 3: Integrations
14. Telegram adapter (gramjs)
15. Slack adapter (@slack/web-api)
16. WhatsApp adapter (baileys)
17. Gmail adapter (googleapis)
18. Webhook receivers
19. Integration settings UI

### Phase 4: Broadcast
20. Broadcast CRUD + wizard UI
21. BullMQ worker for sending
22. Antiban settings UI (per-messenger sliders + Risk Meter)
23. Auto-retry logic
24. Broadcast analytics

### Phase 5: Polish
25. Templates CRUD
26. Activity log
27. Dashboard
28. File attachments (R2)
29. Settings pages
30. Deployment configs

## Common Pitfalls

- **Don't use Express** — we use Fastify
- **Don't forget organizationId filter** — every query must be scoped
- **Don't store tokens in plaintext** — encrypt all OAuth credentials
- **Don't use `any` type** — strict TypeScript
- **Don't create one giant component** — keep components under 200 lines
- **Don't hardcode colors** — use Tailwind theme tokens from DESIGN_SYSTEM.md
- **Don't skip validation** — every API endpoint validates input
- **Worker must be idempotent** — Railway restarts containers on deploy

## Environment Setup

```bash
cp .env.example .env
# Fill in DATABASE_URL, REDIS_URL, JWT_SECRET, etc.
# For development: use local PostgreSQL + Redis or Railway dev instances
```

## Useful Commands

```bash
# Root
npm run dev                    # Start all services
npm run build                  # Build all

# API
cd apps/api
npx prisma generate            # Generate Prisma client
npx prisma migrate dev          # Run migrations
npx prisma studio              # Visual DB browser

# Database
npx prisma db push             # Push schema without migration (dev only)

# Deployment
netlify deploy --prod           # Deploy frontend to Netlify (from apps/web)
railway up                      # Deploy backend to Railway (from apps/api or apps/worker)
```

## Deployment

- **Netlify CLI** and **Railway CLI** are installed globally
- Frontend (`apps/web`) deploys via **Netlify**
- Backend (`apps/api`) and worker (`apps/worker`) deploy via **Railway**
