import type { Database, Model } from '@nocobase/database';

function getRecordValue(record: unknown, key: string) {
  if (!record || typeof record !== 'object') return undefined;
  const model = record as { get?: (attribute: string) => unknown } & Record<string, unknown>;
  return typeof model.get === 'function' ? model.get(key) : model[key];
}

export const REPOSITORY_READ_ACTIONS = ['list', 'get'] as const;
export const GIT_READ_ACTIONS = [
  'status',
  'log',
  'branches',
  'diff',
  'fileTree',
  'fileContent',
  'commitDetail',
  'mergeRequests',
  'mergeRequestDetail',
  'mergeRequestNotes',
  'pollerStatus',
  'subtreePreview',
  'subtreeOptions',
] as const;
export const GIT_WRITE_ACTIONS = [
  'clone',
  'pull',
  'push',
  'fetch',
  'checkout',
  'triggerReview',
  'reviewApprovePost',
  'reviewReject',
  'pollNow',
  'subtreeRun',
] as const;

export type RepositoryPermissionScope = {
  ids: Array<number | string>;
  unrestricted: boolean;
  supported: boolean;
};

type ScopeResolution = {
  ids: Set<number | string>;
  unrestricted: boolean;
  supported: boolean;
};

function supportedIds(ids: Iterable<number | string>): ScopeResolution {
  return { ids: new Set(ids), unrestricted: false, supported: true };
}

function unsupportedScope(): ScopeResolution {
  return { ids: new Set(), unrestricted: false, supported: false };
}

function combineScopeBranches(operator: '$and' | '$or', branches: unknown[]): ScopeResolution {
  const resolutions = branches.map(resolveRepositoryScope);
  if (resolutions.some((resolution) => !resolution.supported)) return unsupportedScope();

  if (operator === '$or') {
    if (resolutions.some((resolution) => resolution.unrestricted)) {
      return { ids: new Set(), unrestricted: true, supported: true };
    }
    return supportedIds(resolutions.flatMap((resolution) => [...resolution.ids]));
  }

  const restricted = resolutions.filter((resolution) => !resolution.unrestricted);
  if (restricted.length === 0) {
    return { ids: new Set(), unrestricted: true, supported: true };
  }
  const [first, ...rest] = restricted;
  const ids = new Set([...first.ids].filter((id) => rest.every((resolution) => resolution.ids.has(id))));
  return supportedIds(ids);
}

function resolveRepositoryScope(scope: unknown): ScopeResolution {
  if (scope == null) {
    return { ids: new Set(), unrestricted: true, supported: true };
  }
  if (typeof scope !== 'object' || Array.isArray(scope)) return unsupportedScope();

  const condition = scope as Record<string, unknown>;
  const keys = Object.keys(condition);
  if (keys.length === 0) {
    return { ids: new Set(), unrestricted: true, supported: true };
  }

  const operator = keys.find((key) => key === '$and' || key === '$or');
  if (operator) {
    if (keys.length !== 1 || !Array.isArray(condition[operator])) return unsupportedScope();
    return combineScopeBranches(operator as '$and' | '$or', condition[operator] as unknown[]);
  }

  if (keys.length !== 1 || !('id' in condition)) return unsupportedScope();
  const id = condition.id;
  if (typeof id === 'number' || typeof id === 'string') {
    return supportedIds([id]);
  }
  if (!id || typeof id !== 'object' || Array.isArray(id)) return unsupportedScope();

  const idCondition = id as Record<string, unknown>;
  const idKeys = Object.keys(idCondition);
  if (idKeys.length !== 1) return unsupportedScope();
  const equal = idCondition.$eq;
  if (typeof equal === 'number' || typeof equal === 'string') {
    return supportedIds([equal]);
  }
  const included = idCondition.$in;
  if (Array.isArray(included) && included.every((value) => typeof value === 'number' || typeof value === 'string')) {
    return supportedIds(included as Array<number | string>);
  }
  return unsupportedScope();
}

function actionScope(actionData: Record<string, unknown>): unknown {
  const scopeRow = actionData.scope;
  if (!scopeRow || typeof scopeRow !== 'object') return undefined;
  const scopeRecord = scopeRow as Record<string, unknown>;
  return 'scope' in scopeRecord ? scopeRecord.scope : scopeRecord;
}

export function getRepositoryPermissionScope(actions: Model[], names: readonly string[]): RepositoryPermissionScope {
  const ids = new Set<number | string>();
  let unrestricted = false;
  for (const action of actions) {
    const actionData = action.toJSON() as Record<string, unknown>;
    if (typeof actionData.name !== 'string' || !names.includes(actionData.name)) continue;
    const scope = actionScope(actionData);
    const resolution = resolveRepositoryScope(scope);
    if (!resolution.supported) {
      return { ids: [], unrestricted: false, supported: false };
    }
    if (resolution.unrestricted) {
      unrestricted = true;
      continue;
    }
    resolution.ids.forEach((id) => ids.add(id));
  }
  return { ids: [...ids], unrestricted, supported: true };
}

export function getRepositoryPermissionIds(actions: Model[], names: readonly string[]) {
  return getRepositoryPermissionScope(actions, names).ids;
}

export function repositoryPermissionIdsForDisplay(
  scope: RepositoryPermissionScope,
  repositoryIds: Array<number | string>,
): Array<number | string> {
  return scope.unrestricted ? repositoryIds : scope.ids;
}

export async function syncScopedActions(
  db: Database,
  resource: Model,
  actionNames: readonly string[],
  ids: Array<number | string>,
  options: { unrestricted?: boolean } = {},
) {
  const rolesResourceId = getRecordValue(resource, 'id');
  const actionsRepo = db.getRepository('rolesResourcesActions');
  for (const storedActionName of actionNames) {
    const action = await actionsRepo.findOne({
      filter: { rolesResourceId, name: storedActionName },
      appends: ['scope'],
    });
    if (action) {
      if (options.unrestricted) {
        await action.update({ scopeId: null });
        continue;
      }
      const scopeJson = { $and: [{ id: { $in: ids } }] };
      const actionData = action.toJSON() as Record<string, unknown>;
      const actionScopeId =
        getRecordValue(actionData.scope, 'id') || actionData.scopeId || getRecordValue(action, 'scopeId');
      if (actionScopeId) {
        await db.getRepository('rolesResourcesScopes').update({
          filterByTk: actionScopeId,
          values: { scope: scopeJson },
        });
      } else {
        const newScope = await db.getRepository('rolesResourcesScopes').create({ values: { scope: scopeJson } });
        await action.update({ scopeId: getRecordValue(newScope, 'id') });
      }
    } else {
      if (options.unrestricted) {
        await actionsRepo.create({
          values: { rolesResourceId, name: storedActionName },
        });
        continue;
      }
      const scopeJson = { $and: [{ id: { $in: ids } }] };
      const newScope = await db.getRepository('rolesResourcesScopes').create({ values: { scope: scopeJson } });
      await actionsRepo.create({
        values: { rolesResourceId, name: storedActionName, scopeId: getRecordValue(newScope, 'id') },
      });
    }
  }
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
  const gitManagerResource = await ctx.db.getRepository('rolesResources').findOne({
    filter: { roleName, name: 'gitManager' },
  });
  const gitManagerActions = gitManagerResource
    ? await ctx.db.getRepository('rolesResourcesActions').find({
        filter: { rolesResourceId: getRecordValue(gitManagerResource, 'id') },
        appends: ['scope'],
      })
    : [];

  const readScope = getRepositoryPermissionScope(actions, [...REPOSITORY_READ_ACTIONS, 'read']);
  const gitWriteScope = getRepositoryPermissionScope(gitManagerActions, GIT_WRITE_ACTIONS);
  const repositoryWriteScope = getRepositoryPermissionScope(actions, ['write']);
  const requiresRepositoryList =
    readScope.unrestricted || gitWriteScope.unrestricted || repositoryWriteScope.unrestricted;
  const repositoryIds = requiresRepositoryList
    ? (await ctx.db.getRepository('gitRepositories').find({ fields: ['id'] })).map((repository: Model) =>
        getRecordValue(repository, 'id'),
      )
    : [];
  const result = {
    read: repositoryPermissionIdsForDisplay(readScope, repositoryIds),
    write: [
      ...new Set([
        ...repositoryPermissionIdsForDisplay(gitWriteScope, repositoryIds),
        ...repositoryPermissionIdsForDisplay(repositoryWriteScope, repositoryIds),
      ]),
    ],
  };
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

  const actionsRepo = ctx.db.getRepository('rolesResourcesActions');
  const readIds = permissions.read || [];
  const writeIds = permissions.write || [];
  const effectiveReadIds = [...new Set([...readIds, ...writeIds])];
  await syncScopedActions(ctx.db, resource, REPOSITORY_READ_ACTIONS, effectiveReadIds);

  let gitManagerResource = await resourceRepo.findOne({ filter: { roleName, name: 'gitManager' } });
  if (!gitManagerResource) {
    gitManagerResource = await resourceRepo.create({
      values: { roleName, name: 'gitManager', usingActionsConfig: true },
    });
  } else if (!getRecordValue(gitManagerResource, 'usingActionsConfig')) {
    await gitManagerResource.update({ usingActionsConfig: true });
  }
  await syncScopedActions(ctx.db, gitManagerResource, GIT_READ_ACTIONS, effectiveReadIds);
  await syncScopedActions(ctx.db, gitManagerResource, GIT_WRITE_ACTIONS, writeIds);

  const legacyReadAction = await actionsRepo.findOne({
    filter: { rolesResourceId: getRecordValue(resource, 'id'), name: 'read' },
  });
  if (legacyReadAction) await legacyReadAction.destroy();
  const legacyWriteAction = await actionsRepo.findOne({
    filter: { rolesResourceId: getRecordValue(resource, 'id'), name: 'write' },
  });
  if (legacyWriteAction) await legacyWriteAction.destroy();

  // Force reload the ACL cache in memory for this resource
  try {
    await resource.writeToACL({ acl: ctx.app.acl });
    await gitManagerResource.writeToACL({ acl: ctx.app.acl });
  } catch (e) {
    ctx.logger?.warn?.('[git-manager] Failed to write resource to ACL memory cache:', e);
  }

  ctx.body = { data: 'ok' };
}
