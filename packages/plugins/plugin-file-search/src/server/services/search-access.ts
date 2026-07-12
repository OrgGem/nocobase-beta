import type { Context } from '@nocobase/actions';

function getUserId(ctx: Context): number | string | undefined {
  return ctx.state?.currentUser?.id || ctx.auth?.user?.id;
}

function getRoleNames(ctx: Context): string[] {
  const currentRole = ctx.state?.currentRole;
  if (typeof currentRole === 'string' && currentRole) return [currentRole];
  const roles = ctx.state?.currentUser?.roles;
  if (!Array.isArray(roles)) return [];
  return roles
    .map((role) => (typeof role === 'string' ? role : role?.name))
    .filter((role): role is string => typeof role === 'string' && !!role);
}

function getPermissionFilter(permission: unknown): Record<string, unknown> | null {
  if (!permission || typeof permission !== 'object') return null;
  const params = (permission as { params?: { filter?: Record<string, unknown> } }).params;
  return params?.filter || null;
}

export async function canAccessReference(ctx: Context, document: any, references: any[]): Promise<boolean> {
  const userId = getUserId(ctx);
  if (!userId) return false;

  if (!references.length) {
    return String(document.get?.('createdById') || document.createdById || '') === String(userId);
  }

  const roles = getRoleNames(ctx);
  for (const reference of references) {
    const ownerCollection = reference.get?.('ownerCollection') || reference.ownerCollection;
    const ownerRecordId = reference.get?.('ownerRecordId') || reference.ownerRecordId;
    if (!ownerCollection || !ownerRecordId) {
      if (String(document.get?.('createdById') || document.createdById || '') === String(userId)) return true;
      continue;
    }

    const repo = ctx.db.getRepository(ownerCollection);
    if (!repo) continue;

    for (const role of roles) {
      const permission =
        ctx.app?.acl?.can?.({ role, resource: ownerCollection, action: 'get' }) ||
        ctx.app?.acl?.can?.({ role, resource: ownerCollection, action: 'list' });
      if (!permission) continue;

      const permissionFilter = getPermissionFilter(permission);
      const filter = permissionFilter ? { $and: [permissionFilter, { id: ownerRecordId }] } : { id: ownerRecordId };
      const record = await repo.findOne({ filter }).catch(() => null);
      if (record) return true;
    }
  }

  return false;
}
