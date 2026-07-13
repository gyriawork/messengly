import prisma from './prisma.js';

export interface PendingImports {
  [messenger: string]: { count: number; at: string };
}

/**
 * Sync the DiscoveredChat rows for one messenger with the latest scan: chats
 * seen now keep their original firstSeenAt, brand-new ones get a row, and
 * anything no longer in the scan (imported or gone) is dropped. Returns a
 * map externalChatId → firstSeenAt for the current pending set.
 */
export async function syncDiscoveredChats(
  organizationId: string,
  messenger: string,
  pendingChats: Array<{ externalChatId: string; name?: string }>,
): Promise<Record<string, string>> {
  const ids = pendingChats.map((c) => c.externalChatId);

  await prisma.discoveredChat.deleteMany({
    where: { organizationId, messenger, externalChatId: { notIn: ids } },
  });
  if (pendingChats.length > 0) {
    await prisma.discoveredChat.createMany({
      data: pendingChats.map((c) => ({
        organizationId,
        messenger,
        externalChatId: c.externalChatId,
        name: c.name ?? null,
      })),
      skipDuplicates: true,
    });
  }

  const rows = await prisma.discoveredChat.findMany({
    where: { organizationId, messenger },
    select: { externalChatId: true, firstSeenAt: true },
  });
  return Object.fromEntries(rows.map((r) => [r.externalChatId, r.firstSeenAt.toISOString()]));
}

/**
 * Record how many discovered-but-not-imported chats a messenger has, feeding
 * the "new chats pending" banner. Merges per messenger; a zero clears it.
 */
export async function setPendingImports(
  organizationId: string,
  messenger: string,
  count: number,
): Promise<void> {
  try {
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { pendingImports: true },
    });
    const current = (org?.pendingImports as PendingImports | null) ?? {};
    if (count > 0) {
      current[messenger] = { count, at: new Date().toISOString() };
    } else {
      delete current[messenger];
    }
    await prisma.organization.update({
      where: { id: organizationId },
      data: { pendingImports: current },
    });
  } catch {
    // The banner is advisory; never let its bookkeeping break the request.
  }
}
