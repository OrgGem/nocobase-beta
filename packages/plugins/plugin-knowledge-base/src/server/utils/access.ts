import type { Context } from '@nocobase/actions';

export type KnowledgeBaseAccessLevel = 'BASIC' | 'SHARED' | 'PUBLIC';

export function getAuthUserId(ctx: Context): string | undefined {
  const id = ctx.auth?.user?.id ?? ctx.state?.currentUser?.id;
  return id == null ? undefined : String(id);
}

export function getCurrentRoles(ctx: Context): string[] {
  const roles = new Set<string>();

  const currentRoles = ctx.state?.currentRoles;
  if (Array.isArray(currentRoles)) {
    for (const role of currentRoles) {
      if (role) roles.add(String(role));
    }
  }

  const userRoles = ctx.state?.currentUser?.roles;
  if (Array.isArray(userRoles)) {
    for (const role of userRoles) {
      const name = typeof role === 'string' ? role : role?.name;
      if (name) roles.add(String(name));
    }
  }

  const currentRole = ctx.state?.currentRole;
  if (currentRole) {
    roles.add(String(currentRole));
  }

  return Array.from(roles);
}

export function isAdminRole(roles: string[]): boolean {
  return roles.includes('root') || roles.includes('admin');
}

export function sameId(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

export function normalizeRoles(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((role) => role != null && role !== '').map(String);
}

export function hasAnyRole(allowedRoles: unknown, currentRoles: string[]): boolean {
  const allowed = normalizeRoles(allowedRoles);
  if (!allowed.length || !currentRoles.length) {
    return false;
  }
  return currentRoles.some((role) => allowed.includes(role));
}

export function getKnowledgeBaseAccessLevel(kbData: any): KnowledgeBaseAccessLevel {
  if (kbData?.accessLevel === 'BASIC' || kbData?.accessLevel === 'SHARED') {
    return kbData.accessLevel;
  }
  return 'PUBLIC';
}

/**
 * Row-level ACL for the three supported Knowledge Base modes:
 * - BASIC: owner-only personal KB
 * - SHARED: users whose current ACL role is in allowedRoles
 * - PUBLIC: all logged-in users can read/use, only admins can manage
 */
export function canReadKnowledgeBase(ctx: Context, kbData: any): boolean {
  const roles = getCurrentRoles(ctx);
  if (isAdminRole(roles)) {
    return true;
  }

  const level = getKnowledgeBaseAccessLevel(kbData);
  if (level === 'PUBLIC') {
    return true;
  }
  if (level === 'BASIC') {
    return sameId(kbData?.ownerId, getAuthUserId(ctx));
  }
  return hasAnyRole(kbData?.allowedRoles, roles);
}

export function canManageKnowledgeBase(ctx: Context, kbData: any): boolean {
  const roles = getCurrentRoles(ctx);
  if (isAdminRole(roles)) {
    return true;
  }

  const level = getKnowledgeBaseAccessLevel(kbData);
  if (level === 'BASIC') {
    return sameId(kbData?.ownerId, getAuthUserId(ctx));
  }
  if (level === 'SHARED') {
    return hasAnyRole(kbData?.allowedRoles, roles);
  }
  return false;
}

export function buildAccessibleKnowledgeBaseFilter(ctx: Context, ids?: string[]) {
  const userId = getAuthUserId(ctx);
  const roles = getCurrentRoles(ctx);
  const isAdmin = isAdminRole(roles);

  const baseFilter: Record<string, any> = {
    enabled: true,
    ...(ids?.length ? { id: { $in: ids } } : {}),
  };

  if (isAdmin) {
    return baseFilter;
  }

  return {
    ...baseFilter,
    $or: [
      { accessLevel: 'PUBLIC' },
      ...(userId ? [{ accessLevel: 'BASIC', ownerId: userId }] : []),
      ...(roles.length ? [{ accessLevel: 'SHARED', 'allowedRoles.$anyOf': roles }] : []),
    ],
  };
}
