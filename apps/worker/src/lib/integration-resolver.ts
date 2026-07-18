// ─── Integration Resolver ───
// Single place that decides WHICH Integration row serves a given
// messenger+organization request. Introduced for Task 3/4 (per-user
// connections) so callers can pin a specific account (explicit integrationId,
// or a specific user's connection) while every existing caller that doesn't
// pass opts keeps getting exactly today's behavior: the org's oldest
// connected row for that messenger.

import prisma from './prisma.js';
import type { Integration } from '@prisma/client';

export interface ResolveIntegrationOptions {
  /** Pin to this exact integration (validated to belong to the org and be connected). */
  integrationId?: string;
  /** Prefer this user's personal (scope='user') connection for the messenger. */
  userId?: string;
}

/**
 * Resolve the Integration row to use for messenger+organizationId.
 *
 * 1. opts.integrationId, if given — must belong to the org and be connected.
 * 2. opts.userId's personal (scope='user') connection, if one exists and is connected.
 * 3. Legacy fallback: the org's oldest connected row for the messenger
 *    (byte-identical to the `findFirst({..., orderBy: createdAt asc})` calls
 *    this replaces, so omitting opts changes nothing).
 *
 * Returns null if nothing connected matches.
 */
export async function resolveIntegration(
  messenger: string,
  organizationId: string,
  opts: ResolveIntegrationOptions = {},
): Promise<Integration | null> {
  if (opts.integrationId) {
    const pinned = await prisma.integration.findUnique({ where: { id: opts.integrationId } });
    if (pinned && pinned.organizationId === organizationId && pinned.messenger === messenger && pinned.status === 'connected') {
      return pinned;
    }
    return null;
  }

  if (opts.userId) {
    const personal = await prisma.integration.findUnique({
      where: {
        messenger_organizationId_userId_scope: {
          messenger,
          organizationId,
          userId: opts.userId,
          scope: 'user',
        },
      },
    });
    if (personal && personal.status === 'connected') {
      return personal;
    }
  }

  return prisma.integration.findFirst({
    where: { messenger, organizationId, status: 'connected' },
    orderBy: { createdAt: 'asc' },
  });
}
