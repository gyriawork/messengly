/**
 * Client-side permission check — informational for rendering only. The API
 * enforces every one of these server-side (see apps/api/src/middleware/rbac.ts
 * requirePermission()); this never substitutes for that.
 */

interface PermissionSubject {
  role: string;
  permissions?: {
    canCreateTags: boolean;
    canSelfConnectMessengers: boolean;
    canViewAllChats: boolean;
  };
}

export type Permission = 'canCreateTags' | 'canSelfConnectMessengers' | 'canViewAllChats';

/**
 * Admin/superadmin always pass — these toggles exist to loosen or restrict a
 * regular `user`, not to gate the roles that manage them (mirrors the
 * server-side rule). `permissions` may be briefly absent right after login
 * (before fetchMe() resolves); it defaults to false rather than granting
 * access during that window.
 */
export function can(user: PermissionSubject | null | undefined, permission: Permission): boolean {
  if (!user) return false;
  if (user.role === 'admin' || user.role === 'superadmin') return true;
  return user.permissions?.[permission] ?? false;
}

export function isAdmin(user: Pick<PermissionSubject, 'role'> | null | undefined): boolean {
  return user?.role === 'admin' || user?.role === 'superadmin';
}
