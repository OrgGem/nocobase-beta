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
  const currentUserId = (ctx.state as any)?.currentUser?.id;
  if (!currentUserId) {
    ctx.throw(401, 'Login required');
  }
  const createdById = model?.get?.('createdById');
  if (createdById && createdById === currentUserId) return;
  if (userHasAdminSnippet(ctx)) return;
  ctx.throw(403, 'You do not have permission to access this diagram');
}
