import prisma from './prisma.js';

export interface PendingImports {
  [messenger: string]: { count: number; at: string };
}

/**
 * Sync the DiscoveredChat rows for one messenger with the latest scan: chats
 * seen now keep their original firstSeenAt, brand-new ones get a row, and
 * anything no longer in the scan (imported or gone) is dropped. Returns a
 * map externalChatId → firstSeenAt for the current pending set.
 *
 * Runs in a transaction so a concurrent scan never observes (or leaves
 * behind) a half-replaced set, which would reset firstSeenAt.
 */
export async function syncDiscoveredChats(
  organizationId: string,
  messenger: string,
  pendingChats: Array<{ externalChatId: string; name?: string }>,
): Promise<Record<string, string>> {
  const ids = pendingChats.map((c) => c.externalChatId);

  const rows = await prisma.$transaction(async (tx) => {
    await tx.discoveredChat.deleteMany({
      where: { organizationId, messenger, externalChatId: { notIn: ids } },
    });
    if (pendingChats.length > 0) {
      await tx.discoveredChat.createMany({
        data: pendingChats.map((c) => ({
          organizationId,
          messenger,
          externalChatId: c.externalChatId,
          name: c.name ?? null,
        })),
        skipDuplicates: true,
      });
    }

    return tx.discoveredChat.findMany({
      where: { organizationId, messenger },
      select: { externalChatId: true, firstSeenAt: true },
    });
  });

  return Object.fromEntries(rows.map((r) => [r.externalChatId, r.firstSeenAt.toISOString()]));
}

/**
 * Record how many discovered-but-not-imported chats a messenger has, feeding
 * the "new chats pending" banner. Merges per messenger; a zero clears it.
 *
 * Uses an atomic jsonb update: two concurrent scans for DIFFERENT messengers
 * (e.g. the 6-hourly worker discovery and a manual scan) each touch only
 * their own key, instead of read-modify-writing the whole object and
 * clobbering each other.
 */
export async function setPendingImports(
  organizationId: string,
  messenger: string,
  count: number,
): Promise<void> {
  try {
    if (count > 0) {
      const entry = JSON.stringify({ count, at: new Date().toISOString() });
      await prisma.$executeRaw`
        UPDATE "Organization"
        SET "pendingImports" = jsonb_set(COALESCE("pendingImports", '{}'::jsonb), ARRAY[${messenger}], ${entry}::jsonb, true)
        WHERE id = ${organizationId}
      `;
    } else {
      await prisma.$executeRaw`
        UPDATE "Organization"
        SET "pendingImports" = COALESCE("pendingImports", '{}'::jsonb) - ${messenger}
        WHERE id = ${organizationId}
      `;
    }
  } catch {
    // The banner is advisory; never let its bookkeeping break the request.
  }
}
