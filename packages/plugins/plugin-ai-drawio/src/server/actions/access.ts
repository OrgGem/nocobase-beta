import { Context } from '@nocobase/actions';

const ACL_SNIPPET = 'pm.ai-drawio';

function userHasAdminSnippet(ctx: Context): boolean {
  const roleName = (ctx.state as any)?.currentRole;
  if (!roleName) return false;
  const acl = (ctx.app as any)?.acl;
  if (!acl?.getRole) return false;
  const role = acl.getRole(roleName);
  if (!role?.snippetAllowed) return false;
  return role.snippetAllowed(`${ACL_SNIPPET}:list`) || role.snippetAllowed(ACL_SNIPPET);
}

export function assertDiagramAccess(ctx: Context, model: any) {
  const isRead = ['get', 'getMeta', 'list', 'loadXml'].includes(ctx.action.actionName);

  // Admin snippet holders bypass all checks
  if (userHasAdminSnippet(ctx)) return;

  const currentUserId = (ctx.state as any)?.currentUser?.id;

  // Read operations are allowed for any authenticated user
  if (isRead) {
    return;
  }

  if (!currentUserId) {
    ctx.throw(401, 'Login required');
  }

  const createdById = model?.get?.('createdById');

  // If diagram has no owner (createdById is null/undefined), allow any
  // authenticated user to write. This covers diagrams created via admin
  // CRUD or before the createdById field was populated.
  if (!createdById) return;

  // Owner can always write their own diagrams
  if (createdById === currentUserId) return;

  ctx.throw(403, 'You do not have permission to access this diagram');
}
