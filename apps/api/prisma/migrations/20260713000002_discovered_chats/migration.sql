CREATE TABLE "DiscoveredChat" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "messenger" TEXT NOT NULL,
    "externalChatId" TEXT NOT NULL,
    "name" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiscoveredChat_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DiscoveredChat_organizationId_messenger_externalChatId_key" ON "DiscoveredChat"("organizationId", "messenger", "externalChatId");
CREATE INDEX "DiscoveredChat_organizationId_messenger_idx" ON "DiscoveredChat"("organizationId", "messenger");
