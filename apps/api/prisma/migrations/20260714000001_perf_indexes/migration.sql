-- Hot-path composite indexes. All additive; safe on live data.
CREATE INDEX IF NOT EXISTS "Chat_organizationId_messenger_deletedAt_idx" ON "Chat"("organizationId", "messenger", "deletedAt");
CREATE INDEX IF NOT EXISTS "Chat_organizationId_status_idx" ON "Chat"("organizationId", "status");
CREATE INDEX IF NOT EXISTS "Broadcast_organizationId_status_idx" ON "Broadcast"("organizationId", "status");
CREATE INDEX IF NOT EXISTS "RefreshToken_userId_idx" ON "RefreshToken"("userId");
