# Messengly V1.1

Unified inbox for **Telegram**, **Slack**, **WhatsApp**, and **Gmail**. Send messages as yourself (not a bot), manage chats across messengers, and broadcast to hundreds of contacts with smart anti-ban rate limiting.

## Quick Start

```bash
# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Fill in your API keys and database URL

# Start development
npm run dev
```

## Documentation

| File | Description |
|------|-------------|
| [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md) | Full product specification — all sections, screens, buttons, logic |
| [`docs/TECHNICAL_SPEC.md`](docs/TECHNICAL_SPEC.md) | Technical spec — architecture, DB schema, API endpoints, project structure |
| [`docs/DESIGN_SYSTEM.md`](docs/DESIGN_SYSTEM.md) | Design tokens, colors, typography, component styles, Tailwind config |
| [`prototype/index.html`](prototype/index.html) | Interactive HTML prototype — open in browser to test all sections |

## Architecture

```
Netlify (Frontend)  →  Railway (API + WebSocket + Worker + PostgreSQL + Redis)
                    →  Cloudflare R2 (files)
                    →  Telegram / Slack / WhatsApp / Gmail APIs
```

## Tech Stack

**Frontend:** Next.js 14+, Tailwind CSS, Socket.io Client, React Query, Zustand
**Backend:** Node.js, Fastify, Socket.io, BullMQ, Prisma, JWT
**Database:** PostgreSQL + Redis
**External:** gramjs (Telegram), @slack/web-api, Baileys (WhatsApp), Google APIs (Gmail)

## Project Structure

```
apps/
  web/          → Next.js frontend (→ Netlify)
  api/          → Fastify REST API (→ Railway)
  worker/       → BullMQ job processor (→ Railway)
packages/
  shared/       → Shared types, constants, validators
docs/           → Specifications
prototype/      → HTML mockup
```

## Implementation Phases

1. **Foundation** (Week 1-2): Auth, RBAC, organizations, basic UI
2. **Chats & Messenger** (Week 3-4): Chat CRUD, messages, real-time, 3-column UI
3. **Integrations** (Week 5-6): Telegram, Slack, WhatsApp, Gmail adapters
4. **Broadcast** (Week 7-8): Wizard, BullMQ worker, antiban, analytics
5. **Polish** (Week 9-10): Templates, activity log, dashboard, deployment

## Estimated Cost (MVP)

~$30-85/month (Railway + Netlify free + Cloudflare R2 free tier)
