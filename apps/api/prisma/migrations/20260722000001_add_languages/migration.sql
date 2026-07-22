-- Item 3: per-chat Language labels (multi-value, org-scoped), mirroring Tag/ChatTag.

CREATE TABLE IF NOT EXISTS "Language" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "organizationId" TEXT NOT NULL,
    CONSTRAINT "Language_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Language_name_organizationId_key" ON "Language"("name", "organizationId");

CREATE TABLE IF NOT EXISTS "ChatLanguage" (
    "chatId" TEXT NOT NULL,
    "languageId" TEXT NOT NULL,
    CONSTRAINT "ChatLanguage_pkey" PRIMARY KEY ("chatId", "languageId")
);

CREATE INDEX IF NOT EXISTS "ChatLanguage_languageId_idx" ON "ChatLanguage"("languageId");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'Language_organizationId_fkey') THEN
    ALTER TABLE "Language" ADD CONSTRAINT "Language_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'ChatLanguage_chatId_fkey') THEN
    ALTER TABLE "ChatLanguage" ADD CONSTRAINT "ChatLanguage_chatId_fkey"
      FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'ChatLanguage_languageId_fkey') THEN
    ALTER TABLE "ChatLanguage" ADD CONSTRAINT "ChatLanguage_languageId_fkey"
      FOREIGN KEY ("languageId") REFERENCES "Language"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
