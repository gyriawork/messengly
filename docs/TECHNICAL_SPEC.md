# Messengly V1.1 — Technical Specification for Claude Code

> This document is the primary technical reference for implementing the Messengly.
> Read PRODUCT_SPEC.md first for full product context.

## Architecture Overview

```
Netlify (CDN)                    Railway
┌──────────────────┐             ┌──────────────────────────────────┐
│  Frontend        │   REST/WS   │  API Service (Node.js/Fastify)  │
│  Next.js 14+     │────────────▶│  - Auth (JWT)                   │
│  Tailwind CSS    │             │  - REST endpoints               │
│  Socket.io       │             │  - Organization management      │
│  React Query     │             │                                 │
│  Zustand         │             │  WebSocket Service (Socket.io)  │
│                  │             │  - Real-time messages           │
└──────────────────┘             │  - Presence / typing            │
                                 │                                 │
                                 │  Worker Service (BullMQ)        │
                                 │  - Broadcast sender             │
                                 │  - Auto-retry processor         │
                                 │  - Chat import / sync           │
                                 │                                 │
                                 │  PostgreSQL + Redis              │
                                 └───────────────┬────────────────┘
                                                 │
                     ┌───────────┐  ┌───────────┐  ┌────────────┐
                     │ Telegram  │  │   Slack   │  │ WhatsApp   │
                     │ MTProto   │  │  Web API  │  │ Baileys/   │
                     │ (gramjs)  │  │  Events   │  │ Cloud API  │
                     └───────────┘  └───────────┘  └────────────┘
                     ┌───────────┐  ┌─────────────┐
                     │  Gmail    │  │ Cloudflare  │
                     │  API      │  │ R2 (files)  │
                     └───────────┘  └─────────────┘
```

## Tech Stack

### Frontend
- **Next.js 14+** (App Router, TypeScript)
- **Tailwind CSS** (with custom theme matching design system)
- **Socket.io Client** (real-time messages)
- **React Query / TanStack Query** (server state, caching)
- **Zustand** (client state: active chat, user session, UI state)
- **Lucide React** (icons)
- **React Hook Form + Zod** (forms, validation)

### Backend
- **Node.js + Fastify** (HTTP API)
- **Socket.io** (WebSocket server)
- **BullMQ** (job queue, Redis-based)
- **Prisma** (ORM, PostgreSQL)
- **JWT** (auth: access 15min + refresh 7days)
- **Passport.js** (OAuth: Slack, Gmail)
- **gramjs** (Telegram Client API / MTProto)
- **@whiskeysockets/baileys** (WhatsApp Web)
- **googleapis** (Gmail API)
- **@slack/web-api** (Slack)

### Infrastructure
- **PostgreSQL** (Railway)
- **Redis** (Railway)
- **Cloudflare R2** (file storage, S3-compatible)

---

## Database Schema (Prisma)

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ─── MULTI-TENANCY ───

model Organization {
  id                   String   @id @default(uuid())
  name                 String
  logo                 String?
  defaultLanguage      String   @default("en")
  timezone             String   @default("UTC")
  chatVisibilityAll    Boolean  @default(true)
  status               String   @default("active") // active | suspended
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt

  users                User[]
  chats                Chat[]
  broadcasts           Broadcast[]
  templates            Template[]
  tags                 Tag[]
  integrations         Integration[]
  antibanSettings      AntibanSettings[]
  activityLogs         ActivityLog[]
  globalBroadcastLimits Json?   // max values admin can't exceed
}

// ─── USERS ───

model User {
  id               String   @id @default(uuid())
  email            String   @unique
  name             String
  passwordHash     String
  avatar           String?
  role             String   @default("user") // superadmin | admin | user
  status           String   @default("active") // active | deactivated
  lastActiveAt     DateTime?
  organizationId   String?
  organization     Organization? @relation(fields: [organizationId], references: [id])
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  ownedChats       Chat[]   @relation("ChatOwner")
  importedChats    Chat[]   @relation("ChatImporter")
  broadcasts       Broadcast[]
  templates        Template[]
  refreshTokens    RefreshToken[]
  chatPreferences  ChatPreference[]
}

model RefreshToken {
  id        String   @id @default(uuid())
  token     String   @unique
  userId    String
  user      User     @relation(fields: [userId], references: [id])
  expiresAt DateTime
  createdAt DateTime @default(now())
}

// ─── CHATS ───

model Chat {
  id               String   @id @default(uuid())
  name             String
  messenger        String   // telegram | slack | whatsapp | gmail
  externalChatId   String   // ID in the messenger's system
  chatType         String   @default("direct") // direct | group | channel
  status           String   @default("active") // active | read-only
  organizationId   String
  organization     Organization @relation(fields: [organizationId], references: [id])
  ownerId          String?
  owner            User?    @relation("ChatOwner", fields: [ownerId], references: [id])
  importedById     String
  importedBy       User     @relation("ChatImporter", fields: [importedById], references: [id])
  messageCount     Int      @default(0)
  lastActivityAt   DateTime?
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  messages         Message[]
  tags             ChatTag[]
  preferences      ChatPreference[]
  broadcastChats   BroadcastChat[]
  participants     ChatParticipant[]

  @@unique([externalChatId, messenger, organizationId])
  @@index([organizationId])
  @@index([ownerId])
  @@index([importedById])
}

model ChatTag {
  chatId  String
  tagId   String
  chat    Chat @relation(fields: [chatId], references: [id], onDelete: Cascade)
  tag     Tag  @relation(fields: [tagId], references: [id], onDelete: Cascade)

  @@id([chatId, tagId])
}

model ChatPreference {
  id       String  @id @default(uuid())
  userId   String
  chatId   String
  pinned   Boolean @default(false)
  favorite Boolean @default(false)
  muted    Boolean @default(false)
  unread   Boolean @default(false) // manual unread mark
  user     User    @relation(fields: [userId], references: [id])
  chat     Chat    @relation(fields: [chatId], references: [id], onDelete: Cascade)

  @@unique([userId, chatId])
}

model ChatParticipant {
  id             String @id @default(uuid())
  chatId         String
  chat           Chat   @relation(fields: [chatId], references: [id], onDelete: Cascade)
  externalUserId String
  displayName    String
  role           String? // admin | member

  @@unique([chatId, externalUserId])
}

// ─── MESSAGES ───

model Message {
  id               String   @id @default(uuid())
  chatId           String
  chat             Chat     @relation(fields: [chatId], references: [id], onDelete: Cascade)
  externalMessageId String?
  senderName       String
  senderExternalId String?
  isSelf           Boolean  @default(false)
  text             String
  editedAt         DateTime?
  replyToMessageId String?  // internal message ID
  replyToMessage   Message? @relation("MessageReply", fields: [replyToMessageId], references: [id])
  replies          Message[] @relation("MessageReply")
  isPinned         Boolean  @default(false)
  deliveryStatus   String?  // sent | delivered | read | failed
  attachments      Json?    // [{url, filename, mimeType, size}]
  createdAt        DateTime @default(now())

  @@index([chatId, createdAt])
}

// ─── BROADCASTS ───

model Broadcast {
  id               String   @id @default(uuid())
  name             String
  messageText      String
  attachments      Json?
  status           String   @default("draft") // draft | scheduled | sending | sent | partially_failed | failed
  scheduledAt      DateTime?
  sentAt           DateTime?
  deliveryRate     Float?
  organizationId   String
  organization     Organization @relation(fields: [organizationId], references: [id])
  createdById      String
  createdBy        User     @relation(fields: [createdById], references: [id])
  templateId       String?
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  chats            BroadcastChat[]

  @@index([organizationId])
}

model BroadcastChat {
  id            String  @id @default(uuid())
  broadcastId   String
  broadcast     Broadcast @relation(fields: [broadcastId], references: [id], onDelete: Cascade)
  chatId        String
  chat          Chat    @relation(fields: [chatId], references: [id])
  status        String  @default("pending") // pending | sent | failed | retrying | retry_exhausted
  errorReason   String?
  retryCount    Int     @default(0)
  sentAt        DateTime?

  @@unique([broadcastId, chatId])
}

// ─── TEMPLATES ───

model Template {
  id             String   @id @default(uuid())
  name           String
  messageText    String
  usageCount     Int      @default(0)
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id])
  createdById    String
  createdBy      User     @relation(fields: [createdById], references: [id])
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
}

// ─── TAGS ───

model Tag {
  id             String   @id @default(uuid())
  name           String
  color          String
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id])
  chats          ChatTag[]

  @@unique([name, organizationId])
}

// ─── INTEGRATIONS ───

model Integration {
  id             String   @id @default(uuid())
  messenger      String   // telegram | slack | whatsapp | gmail
  status         String   @default("disconnected") // connected | disconnected | token_expired | session_expired
  credentials    Json     // encrypted: tokens, session data, etc.
  settings       Json?    // per-integration settings (e.g. Slack channels)
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id])
  userId         String   // which user connected this integration
  connectedAt    DateTime?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@unique([messenger, organizationId, userId])
}

// ─── ANTIBAN ───

model AntibanSettings {
  id                    String @id @default(uuid())
  messenger             String // telegram | slack | whatsapp | gmail
  messagesPerBatch      Int
  delayBetweenMessages  Int    // seconds
  delayBetweenBatches   Int    // seconds
  maxMessagesPerHour    Int
  maxMessagesPerDay     Int
  autoRetryEnabled      Boolean @default(true)
  maxRetryAttempts      Int     @default(3)
  retryWindowHours      Int     @default(6)
  organizationId        String
  organization          Organization @relation(fields: [organizationId], references: [id])

  @@unique([messenger, organizationId])
}

// ─── ACTIVITY LOG ───

model ActivityLog {
  id             String   @id @default(uuid())
  category       String   // chats | messages | broadcast | templates | users | integrations | settings | organizations
  action         String   // e.g. "chat_imported", "broadcast_sent"
  description    String
  targetType     String?  // chat | broadcast | template | user | integration | organization
  targetId       String?
  userId         String?
  userName       String?
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id])
  metadata       Json?
  createdAt      DateTime @default(now())

  @@index([organizationId, createdAt])
  @@index([category])
}
```

---

## API Endpoints

### Auth
```
POST   /api/auth/login          { email, password } → { accessToken, refreshToken, user }
POST   /api/auth/refresh        { refreshToken } → { accessToken }
POST   /api/auth/logout         { refreshToken }
POST   /api/auth/register       { email, password, name, inviteToken }
```

### Organizations (Superadmin)
```
GET    /api/organizations                      → [organizations]
POST   /api/organizations                      { name, adminEmail }
PATCH  /api/organizations/:id                  { name, status, globalBroadcastLimits }
GET    /api/organizations/:id/stats            → { userCount, chatCount, broadcastCount }
```

### Users
```
GET    /api/users                              → [users] (filtered by org)
POST   /api/users/invite                       { email, role }
PATCH  /api/users/:id                          { name, role, status }
GET    /api/users/me                           → user profile
PATCH  /api/users/me                           { name, avatar }
PATCH  /api/users/me/password                  { oldPassword, newPassword }
```

### Chats
```
GET    /api/chats                              → [chats] (filtered, sorted, paginated)
GET    /api/chats/:id                          → chat detail
PATCH  /api/chats/:id                          { ownerId, tags }
DELETE /api/chats/:id                          → remove from system
POST   /api/chats/import                       { messenger, externalChatIds[] }
GET    /api/chats/available/:messenger         → [available chats from messenger API]
POST   /api/chats/:id/participants             { externalUserId, displayName }
POST   /api/chats/bulk/assign                  { chatIds[], ownerId }
POST   /api/chats/bulk/tag                     { chatIds[], tagId, action: add|remove }
DELETE /api/chats/bulk                         { chatIds[] }
```

### Chat Preferences (per-user)
```
GET    /api/chats/:id/preferences              → { pinned, favorite, muted, unread }
PATCH  /api/chats/:id/preferences              { pinned?, favorite?, muted?, unread? }
```

### Messages
```
GET    /api/chats/:id/messages                 → [messages] (paginated, cursor-based)
POST   /api/chats/:id/messages                 { text, replyToMessageId?, attachments? }
PATCH  /api/messages/:id                       { text } → edit own message
DELETE /api/messages/:id                       → delete own message
PATCH  /api/messages/:id/pin                   { isPinned }
GET    /api/chats/:id/messages/search          ?q=text → [messages]
```

### Broadcasts
```
GET    /api/broadcasts                         → [broadcasts] (filtered, sorted)
GET    /api/broadcasts/:id                     → broadcast detail + failed chats
POST   /api/broadcasts                         { name, messageText, chatIds[], scheduledAt?, templateId? }
PATCH  /api/broadcasts/:id                     { name, messageText, status }
DELETE /api/broadcasts/:id
POST   /api/broadcasts/:id/send                → trigger sending
POST   /api/broadcasts/:id/retry               → retry failed chats
POST   /api/broadcasts/:id/duplicate           → create copy as draft
```

### Broadcast Analytics
```
GET    /api/broadcasts/analytics               ?period=30d&messenger=telegram → analytics data
GET    /api/broadcasts/analytics/by-messenger   → per-messenger breakdown
```

### Templates
```
GET    /api/templates                          → [templates]
POST   /api/templates                          { name, messageText }
PATCH  /api/templates/:id                      { name, messageText }
DELETE /api/templates/:id
POST   /api/templates/:id/duplicate
```

### Tags
```
GET    /api/tags                               → [tags]
POST   /api/tags                               { name, color }
PATCH  /api/tags/:id                           { name, color }
DELETE /api/tags/:id
```

### Integrations
```
GET    /api/integrations                       → [integrations]
POST   /api/integrations/:messenger/connect    { credentials/token }
POST   /api/integrations/:messenger/disconnect
POST   /api/integrations/:messenger/reconnect
PATCH  /api/integrations/:messenger/settings   { settings }
```

### Antiban Settings
```
GET    /api/settings/antiban                    → [antibanSettings per messenger]
PATCH  /api/settings/antiban/:messenger         { messagesPerBatch, delays, limits... }
GET    /api/settings/antiban/risk-score         ?messenger=telegram&params... → { score, zone, text }
```

### Workspace Settings
```
GET    /api/settings/workspace                 → workspace settings
PATCH  /api/settings/workspace                 { name, timezone, chatVisibilityAll, ... }
```

### Activity Log
```
GET    /api/activity                           → [events] (filtered by user, category, date range)
```

### WebSocket Events
```
// Client → Server
ws:join_chat          { chatId }
ws:leave_chat         { chatId }
ws:typing             { chatId }
ws:mark_read          { chatId, messageId }

// Server → Client
ws:new_message        { chatId, message }
ws:message_updated    { chatId, messageId, text, editedAt }
ws:message_deleted    { chatId, messageId }
ws:chat_updated       { chatId, changes }
ws:broadcast_status   { broadcastId, status, deliveryRate }
ws:typing             { chatId, userId, userName }
ws:presence           { userId, status: online|offline }
```

---

## Project Structure

```
messengly/
├── apps/
│   ├── web/                          # Next.js frontend (Netlify)
│   │   ├── src/
│   │   │   ├── app/                  # App Router pages
│   │   │   │   ├── (auth)/
│   │   │   │   │   ├── login/
│   │   │   │   │   └── register/
│   │   │   │   ├── (dashboard)/
│   │   │   │   │   ├── page.tsx      # Dashboard
│   │   │   │   │   ├── chats/
│   │   │   │   │   ├── messenger/
│   │   │   │   │   ├── broadcast/
│   │   │   │   │   ├── activity/
│   │   │   │   │   └── settings/
│   │   │   │   └── layout.tsx
│   │   │   ├── components/
│   │   │   │   ├── ui/               # Base UI components (Button, Input, Modal, etc.)
│   │   │   │   ├── layout/           # Sidebar, Topbar, etc.
│   │   │   │   ├── chats/            # Chat-specific components
│   │   │   │   ├── messenger/        # Messenger-specific components
│   │   │   │   ├── broadcast/        # Broadcast-specific components
│   │   │   │   ├── activity/
│   │   │   │   └── settings/
│   │   │   ├── hooks/                # Custom hooks
│   │   │   ├── lib/                  # Utils, API client, socket client
│   │   │   ├── stores/               # Zustand stores
│   │   │   └── types/                # TypeScript types
│   │   ├── tailwind.config.ts
│   │   ├── next.config.js
│   │   └── package.json
│   │
│   ├── api/                          # Fastify API service (Railway)
│   │   ├── src/
│   │   │   ├── routes/               # Route handlers
│   │   │   │   ├── auth.ts
│   │   │   │   ├── organizations.ts
│   │   │   │   ├── users.ts
│   │   │   │   ├── chats.ts
│   │   │   │   ├── messages.ts
│   │   │   │   ├── broadcasts.ts
│   │   │   │   ├── templates.ts
│   │   │   │   ├── tags.ts
│   │   │   │   ├── integrations.ts
│   │   │   │   ├── settings.ts
│   │   │   │   └── activity.ts
│   │   │   ├── middleware/           # Auth, RBAC, org-scoping
│   │   │   ├── services/            # Business logic
│   │   │   ├── integrations/        # Messenger adapters
│   │   │   │   ├── telegram.ts
│   │   │   │   ├── slack.ts
│   │   │   │   ├── whatsapp.ts
│   │   │   │   └── gmail.ts
│   │   │   ├── websocket/           # Socket.io server
│   │   │   ├── lib/                 # Utils, crypto, validation
│   │   │   └── index.ts             # Entry point
│   │   ├── prisma/
│   │   │   ├── schema.prisma
│   │   │   └── migrations/
│   │   └── package.json
│   │
│   └── worker/                       # BullMQ worker service (Railway)
│       ├── src/
│       │   ├── jobs/
│       │   │   ├── broadcast.ts      # Broadcast sender
│       │   │   ├── retry.ts          # Auto-retry processor
│       │   │   ├── import.ts         # Chat import
│       │   │   └── sync.ts           # Message sync
│       │   ├── queues/               # Queue definitions
│       │   └── index.ts
│       └── package.json
│
├── packages/
│   └── shared/                       # Shared types, constants
│       ├── src/
│       │   ├── types.ts
│       │   ├── constants.ts
│       │   └── validators.ts
│       └── package.json
│
├── docs/
│   ├── PRODUCT_SPEC.md
│   ├── TECHNICAL_SPEC.md
│   └── DESIGN_SYSTEM.md
│
├── prototype/
│   └── index.html                    # Interactive HTML prototype
│
├── turbo.json                        # Turborepo config
├── package.json                      # Root workspace
├── .env.example
└── README.md
```

---

## Implementation Priorities (Phases)

### Phase 1: Foundation (Week 1-2)
1. Project scaffolding (monorepo, Turborepo)
2. Database schema + Prisma setup
3. Auth system (JWT, register, login, refresh)
4. User management + organization RBAC
5. Basic UI: Sidebar, routing, auth pages

### Phase 2: Chats & Messenger (Week 3-4)
1. Chat CRUD + import mechanism
2. Message CRUD + real-time (WebSocket)
3. Messenger UI (3-column layout)
4. Chat list: search, filter, sort, group, pin, favorite, mute
5. Reply, Edit, Forward, Pin messages

### Phase 3: Integrations (Week 5-6)
1. Telegram adapter (gramjs — MTProto)
2. Slack adapter (Web API + Events)
3. WhatsApp adapter (Baileys)
4. Gmail adapter (Google API)
5. Webhook receivers for incoming messages
6. Integration settings UI

### Phase 4: Broadcast (Week 7-8)
1. Broadcast CRUD + wizard UI
2. BullMQ worker for sending with delays
3. Antiban settings (per-messenger sliders + Risk Meter)
4. Auto-retry with exponential backoff
5. Broadcast analytics

### Phase 5: Polish (Week 9-10)
1. Templates CRUD
2. Activity log
3. Dashboard with metrics
4. File attachments (Cloudflare R2)
5. Settings pages (Profile, Workspace, General)
6. Deployment (Railway + Netlify)

---

## Environment Variables (.env.example)

```env
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/omnichannel
REDIS_URL=redis://localhost:6379

# Auth
JWT_SECRET=your-jwt-secret
JWT_REFRESH_SECRET=your-refresh-secret

# Telegram
TELEGRAM_API_ID=your-api-id
TELEGRAM_API_HASH=your-api-hash

# Slack
SLACK_CLIENT_ID=your-client-id
SLACK_CLIENT_SECRET=your-client-secret
SLACK_SIGNING_SECRET=your-signing-secret

# WhatsApp
WHATSAPP_SESSION_PATH=./sessions

# Gmail
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret

# Cloudflare R2
R2_ACCOUNT_ID=your-account-id
R2_ACCESS_KEY_ID=your-access-key
R2_SECRET_ACCESS_KEY=your-secret-key
R2_BUCKET_NAME=omnichannel-files

# App
APP_URL=http://localhost:3000
API_URL=http://localhost:3001
WS_URL=ws://localhost:3002
PORT=3001
WS_PORT=3002
```

---

## Design System Reference

See PRODUCT_SPEC.md → ДИЗАЙН-СИСТЕМА section for full details.

**Quick reference:**
- Font: Inter, weight 600-700 headings, 400 body
- Accent: #6366f1 (Indigo-500)
- Text: Slate-800 / Slate-500 / Slate-400
- Sidebar: gradient #1e1b4b → #312e81
- Cards: shadow-xs, no borders, 12px radius
- Buttons: 8px radius, translateY(-1px) hover
- Inputs: 1.5px border, focus ring
- Messages: 18px radius bubbles
- Transitions: cubic-bezier(.4,0,.2,1)
