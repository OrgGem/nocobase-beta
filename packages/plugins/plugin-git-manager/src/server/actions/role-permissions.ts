function getRecordValue(record: any, key: string) {
  return record?.get ? record.get(key) : record?.[key];
}

/**
 * GET gitManager:rolePermissions
 * Returns parsed repository access permissions for a specific role.
 */
export async function rolePermissions(ctx: any, _next: () => Promise<void>) {
  const currentRoles = Array.isArray(ctx.state?.currentRoles) ? ctx.state.currentRoles : [];
  if (!currentRoles.includes('root')) {
    const canAccessRoles = await ctx.app.acl.can({ roles: currentRoles, resource: 'roles', action: 'update' });
    if (!canAccessRoles) return ctx.throw(403, 'Permission denied');
  }

  const roleName = ctx.action.params.roleName;
  if (!roleName) return ctx.throw(400, 'roleName is required');

  const resource = await ctx.db.getRepository('rolesResources').findOne({
    filter: { roleName, name: 'gitRepositories' },
  });
  if (!resource) {
    ctx.body = { data: { read: [], write: [] } };
    return;
  }
  const actions = await ctx.db.getRepository('rolesResourcesActions').find({
    filter: { rolesResourceId: getRecordValue(resource, 'id') },
    appends: ['scope'],
  });

  const result = { read: [], write: [] };
  for (const action of actions) {
    const actionData = action.toJSON ? action.toJSON() : action;
    const actionName = actionData.name;
    if (result[actionName]) {
      const scopeRow = actionData.scope;
      const scope = scopeRow?.scope || scopeRow;
      try {
        if (scope && scope.$and && scope.$and[0] && scope.$and[0].id) {
          if (scope.$and[0].id.$in) {
            result[actionName] = scope.$and[0].id.$in;
          } else if (typeof scope.$and[0].id === 'number' || typeof scope.$and[0].id === 'string') {
            result[actionName] = [scope.$and[0].id];
          }
        }
      } catch (e) {
        // Unrecognized scope structure, skip
      }
    }
  }
  ctx.body = result;
}

/**
 * POST gitManager:updateRolePermissions
 * Update Data Scopes in rolesResourcesActions for gitRepositories.
 */
export async function updateRolePermissions(ctx: any, _next: () => Promise<void>) {
  const currentRoles = Array.isArray(ctx.state?.currentRoles) ? ctx.state.currentRoles : [];
  if (!currentRoles.includes('root')) {
    const canAccessRoles = await ctx.app.acl.can({ roles: currentRoles, resource: 'roles', action: 'update' });
    if (!canAccessRoles) return ctx.throw(403, 'Permission denied');
  }

  const payload = ctx.action.params.values || ctx.request.body || {};
  const roleName = payload.roleName || ctx.action.params.roleName;
  const permissions = payload.values || {};
  if (!roleName) return ctx.throw(400, 'roleName is required');

  const resourceRepo = ctx.db.getRepository('rolesResources');
  let resource = await resourceRepo.findOne({ filter: { roleName, name: 'gitRepositories' } });
  if (!resource) {
    resource = await resourceRepo.create({
      values: { roleName, name: 'gitRepositories', usingActionsConfig: true },
    });
  } else if (!getRecordValue(resource, 'usingActionsConfig')) {
    await resource.update({ usingActionsConfig: true });
  }

  const rolesResourceId = getRecordValue(resource, 'id');
  const actionsRepo = ctx.db.getRepository('rolesResourcesActions');
  for (const actionName of ['read', 'write']) {
    const ids = permissions[actionName] || [];
    const action = await actionsRepo.findOne({
      filter: { rolesResourceId, name: actionName },
      appends: ['scope'],
    });

    if (ids.length === 0) {
      // Remove the action if no ids allowed
      if (action) await action.destroy();
    } else {
      const scopeJson = { $and: [{ id: { $in: ids } }] };
      if (action) {
        const actionData = action.toJSON ? action.toJSON() : action;
        const actionScope = actionData.scope;
        const actionScopeId = getRecordValue(actionScope, 'id') || actionData.scopeId || getRecordValue(action, 'scopeId');
        if (actionScopeId) {
          await ctx.db.getRepository('rolesResourcesScopes').update({
            filterByTk: actionScopeId,
            values: { scope: scopeJson },
          });
        } else {
          const newScope = await ctx.db.getRepository('rolesResourcesScopes').create({
            values: { scope: scopeJson },
          });
          await action.update({ scopeId: getRecordValue(newScope, 'id') });
        }
      } else {
        const newScope = await ctx.db.getRepository('rolesResourcesScopes').create({
          values: { scope: scopeJson },
        });
        await actionsRepo.create({
          values: { rolesResourceId, name: actionName, scopeId: getRecordValue(newScope, 'id') },
        });
      }
    }
  }

  // Force reload the ACL cache in memory for this resource
  try {
    await resource.writeToACL({ acl: ctx.app.acl });
  } catch (e) {
    ctx.logger?.warn?.('[git-manager] Failed to write resource to ACL memory cache:', e);
  }

  ctx.body = { data: 'ok' };
}
