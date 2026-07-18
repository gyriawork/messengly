-- v2.2 foundations. Shipped dark: columns/tables land with defaults that
-- replicate current behavior; later phases wire them up. Backfills touch small
-- tables and run inside the migration transaction.

-- gen_random_uuid() is built into PG13+; the extension is only a fallback for
-- older servers, so a permission failure here must not fail the migration.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- Per-user permission toggles (defaults preserve pre-v2.2 behavior)
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "canCreateTags" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "canSelfConnectMessengers" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "canViewAllChats" BOOLEAN NOT NULL DEFAULT true;

-- Integration scope: every existing row is an org-level connection
ALTER TABLE "Integration" ADD COLUMN IF NOT EXISTS "scope" TEXT NOT NULL DEFAULT 'org';

-- Unique-key swap: (messenger, organizationId, userId) -> (..., scope), so one
-- user can hold both the org-level row and a personal row of the same
-- messenger. New index first, then drop the old one; no rows are touched.
CREATE UNIQUE INDEX IF NOT EXISTS "Integration_messenger_organizationId_userId_scope_key"
  ON "Integration"("messenger", "organizationId", "userId", "scope");
DROP INDEX IF EXISTS "Integration_messenger_organizationId_userId_key";

-- Per-organization messenger app credentials
CREATE TABLE IF NOT EXISTS "OrgMessengerConfig" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "messenger" TEXT NOT NULL,
    "credentials" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrgMessengerConfig_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "OrgMessengerConfig_organizationId_messenger_key"
  ON "OrgMessengerConfig"("organizationId", "messenger");
ALTER TABLE "OrgMessengerConfig" ADD CONSTRAINT "OrgMessengerConfig_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed org credentials from the global PlatformConfig so existing orgs keep
-- working identically once resolution becomes org-scoped. Encrypted blobs are
-- key-based (CREDENTIALS_ENCRYPTION_KEY), not org-based, so copying is valid.
INSERT INTO "OrgMessengerConfig" ("id", "organizationId", "messenger", "credentials", "enabled", "updatedBy", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, o."id", pc."messenger", pc."credentials", pc."enabled", pc."updatedBy", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Organization" o
CROSS JOIN "PlatformConfig" pc
ON CONFLICT ("organizationId", "messenger") DO NOTHING;

-- Many-to-many chat ownership
CREATE TABLE IF NOT EXISTS "ChatOwner" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "integrationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChatOwner_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ChatOwner_chatId_userId_key" ON "ChatOwner"("chatId", "userId");
CREATE INDEX IF NOT EXISTS "ChatOwner_userId_idx" ON "ChatOwner"("userId");
CREATE INDEX IF NOT EXISTS "ChatOwner_integrationId_idx" ON "ChatOwner"("integrationId");
ALTER TABLE "ChatOwner" ADD CONSTRAINT "ChatOwner_chatId_fkey"
  FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatOwner" ADD CONSTRAINT "ChatOwner_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: one owner link per live chat. importedById is NOT NULL, so every
-- chat gets exactly one link and current orgs behave identically.
INSERT INTO "ChatOwner" ("id", "chatId", "userId")
SELECT gen_random_uuid()::text, c."id", COALESCE(c."ownerId", c."importedById")
FROM "Chat" c
WHERE c."deletedAt" IS NULL
ON CONFLICT ("chatId", "userId") DO NOTHING;

-- Per-messenger sending account for broadcasts; NULL = legacy behavior
ALTER TABLE "Broadcast" ADD COLUMN IF NOT EXISTS "senderConfig" JSONB;

-- Chat type detected at discovery time (Teams DOM scan), carried into imports
ALTER TABLE "DiscoveredChat" ADD COLUMN IF NOT EXISTS "chatType" TEXT;
