const REPOSITORY_ID_ACTIONS = new Set([
  'clone',
  'pull',
  'push',
  'fetch',
  'diff',
  'status',
  'log',
  'branches',
  'checkout',
  'fileTree',
  'fileContent',
  'commitDetail',
  'mergeRequests',
  'mergeRequestDetail',
  'mergeRequestNotes',
  'triggerReview',
  'subtreeOptions',
]);

const SUBTREE_CONFIG_ACTIONS = new Set(['subtreePreview', 'subtreeRun', 'subtreeReplace']);

const REVIEW_ID_ACTIONS = new Set(['reviewApprovePost', 'reviewReject']);

type RepositoryId = number | string;

type ScopedCollectionName =
  | 'gitRepositories'
  | 'gitAccounts'
  | 'gitReviewFlows'
  | 'gitCodeReviews'
  | 'gitSubtreeConfigs'
  | 'gitSubtreeRuns';

type ActionParams = Record<string, unknown> & { values?: unknown };

type RecordWithGetter = Record<string, unknown> & {
  get?: (attribute: string) => unknown;
};

export type RegistryGitAccessContext =
  | {
      kind: 'user';
      roles: string[];
    }
  | {
      kind: 'system';
      reason: 'scheduled-sync';
    };

export type RepositoryPermissionResult = { params?: { filter?: unknown } } | null;

type ResolvedRepositoryScope = {
  ids: RepositoryId[];
  unrestricted: boolean;
  supported: boolean;
};

export interface RepositoryPermissionChecker {
  can(input: {
    roles: string[];
    resource: string;
    action: string;
  }): Promise<RepositoryPermissionResult> | RepositoryPermissionResult;
}

type RepositoryLookup = {
  findOne(input: { filterByTk: RepositoryId }): Promise<unknown>;
};

type RepositoryAccessDatabase = {
  getRepository(name: 'gitSubtreeConfigs' | 'gitCodeReviews'): RepositoryLookup;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asRepositoryId(value: unknown): RepositoryId | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) return value;
  return undefined;
}

function getRecordValue(record: unknown, attribute: string): unknown {
  if (!record || typeof record !== 'object') return undefined;
  const model = record as RecordWithGetter;
  return typeof model.get === 'function' ? model.get(attribute) : model[attribute];
}

/**
 * NocoBase actions can receive values in the URL parameters, the action
 * values envelope, or the request body. Keep this precedence identical to
 * the actions themselves so authorization always checks the repository that
 * will actually be used.
 */
export function getEffectiveActionParams(ctx: {
  action?: { params?: ActionParams };
  request?: { body?: unknown };
}): Record<string, unknown> {
  const params = asRecord(ctx.action?.params);
  return {
    ...params,
    ...asRecord(params.values),
    ...asRecord(ctx.request?.body),
  };
}

function supportedRepositoryIds(ids: Iterable<RepositoryId>): ResolvedRepositoryScope {
  const uniqueIds: RepositoryId[] = [];
  for (const id of ids) {
    if (!uniqueIds.some((candidate) => String(candidate) === String(id))) {
      uniqueIds.push(id);
    }
  }
  return { ids: uniqueIds, unrestricted: false, supported: true };
}

function unsupportedRepositoryScope(): ResolvedRepositoryScope {
  return { ids: [], unrestricted: false, supported: false };
}

function resolveRepositoryScopeBranches(operator: '$and' | '$or', branches: unknown[]): ResolvedRepositoryScope {
  const resolutions = branches.map(resolveRepositoryScope);
  if (resolutions.some((resolution) => !resolution.supported)) {
    return unsupportedRepositoryScope();
  }

  if (operator === '$or') {
    if (resolutions.some((resolution) => resolution.unrestricted)) {
      return { ids: [], unrestricted: true, supported: true };
    }
    return supportedRepositoryIds(resolutions.flatMap((resolution) => resolution.ids));
  }

  const restricted = resolutions.filter((resolution) => !resolution.unrestricted);
  if (restricted.length === 0) {
    return { ids: [], unrestricted: true, supported: true };
  }
  const [first, ...rest] = restricted;
  return supportedRepositoryIds(
    first.ids.filter((id) =>
      rest.every((resolution) => resolution.ids.some((candidate) => String(candidate) === String(id))),
    ),
  );
}

/**
 * Parses the limited ID-only scope grammar written by Repository Permissions.
 * An unknown condition must fail closed: translating it to a collection filter
 * could otherwise turn a restrictive scope into a broader one.
 */
export function resolveRepositoryScope(scope: unknown): ResolvedRepositoryScope {
  if (scope == null) {
    return { ids: [], unrestricted: true, supported: true };
  }
  if (typeof scope !== 'object' || Array.isArray(scope)) {
    return unsupportedRepositoryScope();
  }

  const condition = scope as Record<string, unknown>;
  const keys = Object.keys(condition);
  if (keys.length === 0) {
    return { ids: [], unrestricted: true, supported: true };
  }

  const operator = keys.find((key) => key === '$and' || key === '$or');
  if (operator) {
    if (keys.length !== 1 || !Array.isArray(condition[operator])) {
      return unsupportedRepositoryScope();
    }
    return resolveRepositoryScopeBranches(operator as '$and' | '$or', condition[operator] as unknown[]);
  }

  if (keys.length !== 1 || !('id' in condition)) {
    return unsupportedRepositoryScope();
  }
  const id = condition.id;
  if (typeof id === 'number' || typeof id === 'string') {
    return supportedRepositoryIds([id]);
  }
  if (!id || typeof id !== 'object' || Array.isArray(id)) {
    return unsupportedRepositoryScope();
  }

  const idCondition = id as Record<string, unknown>;
  const idKeys = Object.keys(idCondition);
  if (idKeys.length !== 1) {
    return unsupportedRepositoryScope();
  }
  const equal = idCondition.$eq;
  if (typeof equal === 'number' || typeof equal === 'string') {
    return supportedRepositoryIds([equal]);
  }
  const included = idCondition.$in;
  if (Array.isArray(included) && included.every((value) => typeof value === 'number' || typeof value === 'string')) {
    return supportedRepositoryIds(included as RepositoryId[]);
  }
  return unsupportedRepositoryScope();
}

export function scopeIncludesRepository(filter: unknown, repositoryId: number | string): boolean {
  const scope = resolveRepositoryScope(filter);
  return scope.supported && (scope.unrestricted || scope.ids.some((id) => String(id) === String(repositoryId)));
}

/**
 * Checks the same Git Manager repository scope used by HTTP actions.  Registry
 * content reads use `fileContent` because a source sync ultimately reads file
 * bytes, even when its first request is a tree listing.
 */
export async function hasRepositoryAccess(input: {
  acl?: RepositoryPermissionChecker;
  roles: string[];
  repositoryId: number | string;
  action?: string;
}): Promise<boolean> {
  if (input.roles.includes('root')) {
    return true;
  }
  if (!input.acl) {
    return false;
  }
  const permission = await input.acl.can({
    roles: input.roles,
    resource: 'gitManager',
    action: input.action || 'fileContent',
  });
  return Boolean(permission && scopeIncludesRepository(permission.params?.filter, input.repositoryId));
}

async function hasUnrestrictedRepositoryAccess(input: {
  acl?: RepositoryPermissionChecker;
  roles: string[];
  action: string;
}): Promise<boolean> {
  if (input.roles.includes('root')) return true;
  if (!input.acl) return false;
  const permission = await input.acl.can({
    roles: input.roles,
    resource: 'gitManager',
    action: input.action,
  });
  const scope = resolveRepositoryScope(permission?.params?.filter);
  return Boolean(permission && scope.supported && scope.unrestricted);
}

type RepositoryAccessContext = {
  action?: {
    resourceName?: string;
    actionName?: string;
    params?: ActionParams;
  };
  state?: { currentRoles?: unknown };
  request?: { body?: unknown };
  db?: RepositoryAccessDatabase;
  app: { acl: RepositoryPermissionChecker };
  throw(status: number, message: string): never;
};

type RepositoryCollectionAccessContext = {
  action?: {
    resourceName?: string;
    actionName?: string;
    params?: ActionParams;
    mergeParams?: (params: { filter: unknown }) => void;
  };
  state?: { currentRoles?: unknown };
  query?: unknown;
  request?: { body?: unknown; query?: unknown };
  db?: {
    getRepository(name: 'gitSubtreeConfigs'): RepositoryLookup;
  };
  app: { acl: RepositoryPermissionChecker };
  getCurrentRepository?: () => { targetCollection?: { name?: string } } | null;
  throw(status: number, message: string): never;
};

const COLLECTION_SCOPE_FIELDS: Record<Exclude<ScopedCollectionName, 'gitAccounts'>, string> = {
  gitRepositories: 'id',
  gitReviewFlows: 'repositoryId',
  gitCodeReviews: 'repositoryId',
  gitSubtreeConfigs: 'repositoryId',
  gitSubtreeRuns: 'config.repositoryId',
};

const STANDARD_COLLECTION_ACTIONS = new Set(['list', 'get', 'create', 'update', 'destroy']);

function currentRoles(ctx: {
  state?: { currentRoles?: unknown };
  throw(status: number, message: string): never;
}): string[] {
  const rawRoles = ctx.state?.currentRoles;
  const roles = Array.isArray(rawRoles) ? rawRoles.filter((role): role is string => typeof role === 'string') : [];
  if (Array.isArray(rawRoles) && roles.length !== rawRoles.length) {
    return ctx.throw(403, 'Permission denied');
  }
  return roles;
}

function scopedCollectionName(ctx: RepositoryCollectionAccessContext): ScopedCollectionName | null {
  let targetCollectionName: string | undefined;
  try {
    targetCollectionName = ctx.getCurrentRepository?.()?.targetCollection?.name;
  } catch {
    // Some custom resource routes do not resolve a backing repository. Their
    // route parameters below are still sufficient to identify a scoped target.
  }
  if (targetCollectionName && Object.prototype.hasOwnProperty.call(COLLECTION_SCOPE_FIELDS, targetCollectionName)) {
    return targetCollectionName as Exclude<ScopedCollectionName, 'gitAccounts'>;
  }
  if (targetCollectionName === 'gitAccounts') {
    return targetCollectionName;
  }

  const params = asRecord(ctx.action?.params);
  const candidates = [ctx.action?.resourceName, params.resourceName, params.associatedName, params.targetCollection]
    .filter((value): value is string => typeof value === 'string')
    .flatMap((value) => value.split('.'));
  return (
    candidates.find(
      (candidate): candidate is ScopedCollectionName =>
        candidate === 'gitAccounts' || Object.prototype.hasOwnProperty.call(COLLECTION_SCOPE_FIELDS, candidate),
    ) || null
  );
}

function collectionFilter(collectionName: Exclude<ScopedCollectionName, 'gitAccounts'>, ids: RepositoryId[]): unknown {
  if (collectionName === 'gitSubtreeRuns') {
    return { config: { repositoryId: { $in: ids } } };
  }
  return { [COLLECTION_SCOPE_FIELDS[collectionName]]: { $in: ids } };
}

function effectiveMutationValues(ctx: RepositoryCollectionAccessContext): Record<string, unknown> {
  const body = asRecord(ctx.request?.body);
  return { ...asRecord(body.values), ...getEffectiveActionParams(ctx) };
}

/**
 * `targetCollection` is forwarded by the generic repository actions. If a
 * request changes it after routing has selected a Git Manager collection, the
 * repository implementation can execute against a different collection while
 * ACL and repository-scope filters still describe the original one. The
 * `__collection` value is the equivalent association payload form.
 */
function rejectTargetCollectionOverride(
  ctx: RepositoryCollectionAccessContext,
  collectionName: ScopedCollectionName,
): void {
  const actionParams = asRecord(ctx.action?.params);
  const requestBody = asRecord(ctx.request?.body);
  const actionValues = asRecord(actionParams.values);
  const bodyValues = asRecord(requestBody.values);
  const requestedCollections = [
    actionParams.targetCollection,
    actionParams.__collection,
    actionValues.targetCollection,
    actionValues.__collection,
    requestBody.targetCollection,
    requestBody.__collection,
    bodyValues.targetCollection,
    bodyValues.__collection,
  ];
  for (const requestedCollection of requestedCollections) {
    if (requestedCollection == null || requestedCollection === collectionName) continue;
    ctx.throw(403, 'Permission denied');
  }
}

/**
 * A repository scope limits which repository rows a role can edit; it does not
 * grant the role use of every shared Git credential. Otherwise a user could
 * attach a guessed global account to an allowed repository, change its URL or
 * local checkout, and use that account's PAT or another repository's clone
 * through a permitted Git action.
 */
function rejectScopedRepositoryConnectionMutation(ctx: RepositoryCollectionAccessContext): void {
  const valueSources = [ctx.action?.params, ctx.query, ctx.request?.query, ctx.request?.body];
  if (valueSources.some((values) => containsMutationField(values, REPOSITORY_CONNECTION_FIELD_SEGMENTS))) {
    ctx.throw(403, 'Permission denied');
  }
}

function rejectScopedAssociationMutation(
  ctx: RepositoryCollectionAccessContext,
  associationSegments: ReadonlySet<string>,
): void {
  const valueSources = [ctx.action?.params, ctx.query, ctx.request?.query, ctx.request?.body];
  if (valueSources.some((values) => containsMutationField(values, associationSegments))) {
    ctx.throw(403, 'Permission denied');
  }
}

/**
 * Standard collection handlers can interpret an array as a bulk update and
 * apply it after the scoped filter has been merged. This policy only supports
 * one scoped mutation at a time, so reject arrays instead of attempting to
 * validate a partially normalized bulk payload.
 */
function rejectScopedBulkMutationValues(ctx: RepositoryCollectionAccessContext, actionName: string): void {
  if (actionName !== 'create' && actionName !== 'update') {
    return;
  }

  const actionParams = asRecord(ctx.action?.params);
  const requestBody = ctx.request?.body;
  const bodyValues = asRecord(requestBody).values;
  if (Array.isArray(actionParams.values) || Array.isArray(requestBody) || Array.isArray(bodyValues)) {
    ctx.throw(403, 'Permission denied');
  }
}

const ASSOCIATION_READ_PARAM_KEYS = ['appends', 'include', 'fields'] as const;
const CREDENTIAL_ASSOCIATION_SEGMENTS = new Set(['gitAccount', 'gitAccounts']);
const REPOSITORY_CONNECTION_FIELD_SEGMENTS = new Set(['gitAccount', 'gitAccountId', 'repoUrl', 'localPath']);
const REPOSITORY_ASSOCIATION_SEGMENTS = new Set(['repository']);
const SUBTREE_RUN_ASSOCIATION_SEGMENTS = new Set(['config']);

function pathSegments(value: string): string[] {
  return value.split(/[.[\],:/()=\s'"]+/);
}

function containsCredentialAssociationSegment(value: string): boolean {
  return pathSegments(value).some((segment) => CREDENTIAL_ASSOCIATION_SEGMENTS.has(segment));
}

/**
 * UpdateGuard expands dotted and bracket notation after middleware runs. Walk
 * request object keys recursively so an attacker cannot smuggle a protected
 * connection or association field through dotted, bracket, or nested
 * association-update payloads.
 */
function containsMutationField(
  value: unknown,
  fieldSegments: ReadonlySet<string>,
  visited = new WeakSet<object>(),
): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  if (visited.has(value)) {
    return false;
  }
  visited.add(value);

  if (Array.isArray(value)) {
    return value.some((item) => containsMutationField(item, fieldSegments, visited));
  }

  return Object.entries(value as Record<string, unknown>).some(
    ([key, item]) =>
      pathSegments(key).some((segment) => fieldSegments.has(segment)) ||
      containsMutationField(item, fieldSegments, visited),
  );
}

/**
 * Generic collection reads accept association projections in more than one
 * shape: an `appends` array, an ORM-style `include` object, or a relation
 * field path. Limit the inspection to those projection parameters so a normal
 * filter value cannot accidentally be treated as a credential request.
 */
function containsCredentialAssociation(value: unknown, visited = new WeakSet<object>()): boolean {
  if (typeof value === 'string') {
    return containsCredentialAssociationSegment(value);
  }
  if (!value || typeof value !== 'object') {
    return false;
  }
  if (visited.has(value)) {
    return false;
  }
  visited.add(value);

  if (Array.isArray(value)) {
    return value.some((item) => containsCredentialAssociation(item, visited));
  }

  return Object.entries(value as Record<string, unknown>).some(
    ([key, item]) => containsCredentialAssociationSegment(key) || containsCredentialAssociation(item, visited),
  );
}

function isAssociationReadParamKey(key: string): boolean {
  return ASSOCIATION_READ_PARAM_KEYS.some(
    (paramKey) => key === paramKey || key.startsWith(`${paramKey}[`) || key.startsWith(`${paramKey}.`),
  );
}

function rejectScopedCredentialAssociationRoute(ctx: RepositoryCollectionAccessContext): void {
  const actionParams = asRecord(ctx.action?.params);
  const requestBody = asRecord(ctx.request?.body);
  const routeValues = [
    ctx.action?.resourceName,
    actionParams.resourceName,
    actionParams.associatedName,
    actionParams.targetCollection,
    requestBody.resourceName,
    requestBody.associatedName,
    requestBody.targetCollection,
    asRecord(actionParams.values).resourceName,
    asRecord(actionParams.values).associatedName,
    asRecord(actionParams.values).targetCollection,
    asRecord(requestBody.values).resourceName,
    asRecord(requestBody.values).associatedName,
    asRecord(requestBody.values).targetCollection,
    asRecord(ctx.query).resourceName,
    asRecord(ctx.query).associatedName,
    asRecord(ctx.query).targetCollection,
    asRecord(ctx.request?.query).resourceName,
    asRecord(ctx.request?.query).associatedName,
    asRecord(ctx.request?.query).targetCollection,
  ];
  if (routeValues.some((value) => typeof value === 'string' && containsCredentialAssociationSegment(value))) {
    ctx.throw(403, 'Permission denied');
  }
}

/**
 * A scoped role is allowed to read only selected repository rows, not the
 * global Git account that happens to be attached to those rows. An `appends`
 * or `include` projection of `gitAccount` would otherwise serialize its PAT
 * through the permitted gitRepositories endpoint.
 */
function rejectScopedRepositoryCredentialAssociationRead(
  ctx: RepositoryCollectionAccessContext,
  actionName: string,
): void {
  if (actionName !== 'list' && actionName !== 'get') {
    return;
  }

  const actionParams = asRecord(ctx.action?.params);
  const requestBody = asRecord(ctx.request?.body);
  const valueSources = [
    actionParams,
    asRecord(actionParams.values),
    asRecord(ctx.query),
    asRecord(ctx.request?.query),
    requestBody,
    asRecord(requestBody.values),
  ];
  for (const values of valueSources) {
    for (const [key, value] of Object.entries(values)) {
      if (isAssociationReadParamKey(key) && containsCredentialAssociation(value)) {
        ctx.throw(403, 'Permission denied');
      }
    }
  }
}

function scopeAllowsRepository(scope: ResolvedRepositoryScope, repositoryId: RepositoryId): boolean {
  return scope.unrestricted || scope.ids.some((id) => String(id) === String(repositoryId));
}

function hasOwn(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function requireScopedRepositoryValue(
  ctx: RepositoryCollectionAccessContext,
  values: Record<string, unknown>,
  scope: ResolvedRepositoryScope,
  actionName: string,
): void {
  if (hasOwn(values, 'repository')) {
    ctx.throw(403, 'Permission denied');
  }
  if (!hasOwn(values, 'repositoryId')) {
    if (actionName === 'create') {
      ctx.throw(400, 'repositoryId is required');
    }
    return;
  }
  const repositoryId = asRepositoryId(values.repositoryId);
  if (repositoryId == null || !scopeAllowsRepository(scope, repositoryId)) {
    ctx.throw(403, 'Permission denied');
  }
}

async function requireScopedRunConfigValue(
  ctx: RepositoryCollectionAccessContext,
  values: Record<string, unknown>,
  scope: ResolvedRepositoryScope,
  actionName: string,
): Promise<void> {
  if (hasOwn(values, 'config')) {
    ctx.throw(403, 'Permission denied');
  }
  if (!hasOwn(values, 'configId')) {
    if (actionName === 'create') {
      ctx.throw(400, 'configId is required');
    }
    return;
  }
  const configId = asRepositoryId(values.configId);
  const database = ctx.db;
  if (configId == null || !database) {
    ctx.throw(403, 'Permission denied');
  }
  const config = await database.getRepository('gitSubtreeConfigs').findOne({ filterByTk: configId });
  if (!config) {
    ctx.throw(404, 'Subtree configuration not found');
  }
  const repositoryId = asRepositoryId(getRecordValue(config, 'repositoryId'));
  if (repositoryId == null || !scopeAllowsRepository(scope, repositoryId)) {
    ctx.throw(403, 'Permission denied');
  }
}

/**
 * Repository Permissions persist their scope on gitRepositories and custom
 * gitManager actions. Generic collection snippets are otherwise unscoped, so
 * apply the same scope before the standard collection handlers run.
 */
export async function enforceRepositoryCollectionAccess(
  ctx: RepositoryCollectionAccessContext,
  next: () => Promise<void>,
): Promise<void> {
  const collectionName = scopedCollectionName(ctx);
  if (!collectionName) {
    await next();
    return;
  }

  rejectTargetCollectionOverride(ctx, collectionName);

  const roles = currentRoles(ctx);
  if (roles.includes('root')) {
    await next();
    return;
  }
  const repositoryPermission = await ctx.app.acl.can({
    roles,
    resource: 'gitRepositories',
    action: 'list',
  });
  // No Repository Permissions action exists for this role. Preserve the
  // independently configured collection ACL instead of inventing a scope.
  if (!repositoryPermission) {
    await next();
    return;
  }
  const scope = resolveRepositoryScope(repositoryPermission.params?.filter);
  if (!scope.supported) {
    ctx.throw(403, 'Permission denied');
  }
  if (scope.unrestricted) {
    await next();
    return;
  }

  const actionName = ctx.action?.actionName;
  if (!actionName || !STANDARD_COLLECTION_ACTIONS.has(actionName)) {
    ctx.throw(403, 'Permission denied');
  }
  if (collectionName === 'gitAccounts') {
    ctx.throw(403, 'Permission denied');
  }
  if (collectionName === 'gitCodeReviews' && (actionName === 'create' || actionName === 'update')) {
    // Review rows are durable worker jobs. Their flow, metadata, status and
    // session fields control execution, so scoped users must use the checked
    // gitManager review actions instead of generic collection mutations.
    ctx.throw(403, 'Permission denied');
  }
  rejectScopedCredentialAssociationRoute(ctx);
  rejectScopedRepositoryCredentialAssociationRead(ctx, actionName);
  rejectScopedBulkMutationValues(ctx, actionName);

  const mergeParams = ctx.action?.mergeParams;
  if (!mergeParams) {
    ctx.throw(403, 'Permission denied');
  }
  mergeParams({ filter: collectionFilter(collectionName, scope.ids) });

  if (actionName === 'create' && collectionName === 'gitRepositories') {
    ctx.throw(403, 'Permission denied');
  }
  if (actionName === 'create' || actionName === 'update') {
    const values = effectiveMutationValues(ctx);
    if (collectionName === 'gitSubtreeRuns') {
      rejectScopedAssociationMutation(ctx, SUBTREE_RUN_ASSOCIATION_SEGMENTS);
      await requireScopedRunConfigValue(ctx, values, scope, actionName);
    } else if (collectionName === 'gitRepositories') {
      if (actionName === 'update') {
        rejectScopedRepositoryConnectionMutation(ctx);
      }
    } else {
      rejectScopedAssociationMutation(ctx, REPOSITORY_ASSOCIATION_SEGMENTS);
      requireScopedRepositoryValue(ctx, values, scope, actionName);
    }
  }

  await next();
}

async function repositoryIdFromSubtreeConfig(
  ctx: RepositoryAccessContext,
  configId: RepositoryId,
): Promise<RepositoryId> {
  if (!ctx.db) ctx.throw(403, 'Permission denied');
  const config = await ctx.db.getRepository('gitSubtreeConfigs').findOne({ filterByTk: configId });
  if (!config) ctx.throw(404, 'Subtree configuration not found');
  const repositoryId = asRepositoryId(getRecordValue(config, 'repositoryId'));
  if (repositoryId == null) ctx.throw(403, 'Permission denied');
  return repositoryId;
}

async function repositoryIdFromReview(ctx: RepositoryAccessContext, reviewId: RepositoryId): Promise<RepositoryId> {
  if (!ctx.db) ctx.throw(403, 'Permission denied');
  const review = await ctx.db.getRepository('gitCodeReviews').findOne({ filterByTk: reviewId });
  if (!review) ctx.throw(404, 'Review not found');
  const repositoryId = asRepositoryId(getRecordValue(review, 'repositoryId'));
  if (repositoryId == null) ctx.throw(403, 'Permission denied');
  return repositoryId;
}

export async function enforceRepositoryAccess(ctx: RepositoryAccessContext, next: () => Promise<void>) {
  const action = ctx.action;
  const actionName = action?.actionName;
  if (action?.resourceName !== 'gitManager' || !actionName) {
    return next();
  }

  const currentRoles = ctx.state?.currentRoles;
  const roles = Array.isArray(currentRoles)
    ? currentRoles.filter((role): role is string => typeof role === 'string')
    : [];
  if (Array.isArray(currentRoles) && roles.length !== currentRoles.length) {
    return ctx.throw(403, 'Permission denied');
  }

  const params = getEffectiveActionParams(ctx);
  let repositoryId: RepositoryId | undefined;
  if (REPOSITORY_ID_ACTIONS.has(actionName)) {
    repositoryId = asRepositoryId(params.repositoryId);
    if (repositoryId == null) return ctx.throw(400, 'repositoryId is required');
  } else if (SUBTREE_CONFIG_ACTIONS.has(actionName)) {
    const configId = asRepositoryId(params.configId);
    if (configId == null) return ctx.throw(400, 'configId is required');
    repositoryId = await repositoryIdFromSubtreeConfig(ctx, configId);
  } else if (REVIEW_ID_ACTIONS.has(actionName)) {
    const reviewId = asRepositoryId(params.reviewId);
    if (reviewId == null) return ctx.throw(400, 'reviewId is required');
    repositoryId = await repositoryIdFromReview(ctx, reviewId);
  } else if (actionName === 'pollNow') {
    repositoryId = asRepositoryId(params.repositoryId);
    if (repositoryId == null) {
      const allowed = await hasUnrestrictedRepositoryAccess({
        acl: ctx.app.acl,
        roles,
        action: actionName,
      });
      if (!allowed) return ctx.throw(403, 'Permission denied');
      return next();
    }
  } else {
    return next();
  }

  const allowed = await hasRepositoryAccess({
    acl: ctx.app.acl,
    roles,
    repositoryId,
    action: actionName,
  });
  if (!allowed) {
    return ctx.throw(403, 'Permission denied');
  }

  return next();
}
