import type { Context } from '@nocobase/actions';

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
