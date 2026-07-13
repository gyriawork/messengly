import prisma from './prisma.js';

export interface PendingImports {
  [messenger: string]: { count: number; at: string };
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
