/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Context, Next } from '@nocobase/actions';
import { NoPermissionError } from '@nocobase/acl';
import { WORKFLOW_KEY, WORKFLOW_MARKER } from './templates';

const WORKFLOW_MUTATIONS = new Set([
  'create',
  'update',
  'destroy',
  'execute',
  'trigger',
  'rerun',
  'resume',
  'revision',
  'enable',
  'disable',
  'sync',
  'firstOrCreate',
  'updateOrCreate',
]);
const NODE_MUTATIONS = new Set([
  'create',
  'update',
  'destroy',
  'destroyBranch',
  'duplicate',
  'move',
  'test',
  'trigger',
  'firstOrCreate',
  'updateOrCreate',
]);
const READ_ACTIONS = new Set(['list', 'get']);
const BUILD_GUIDE_COLLECTIONS = new Set([
  'aiBuildGuideSpaces',
  'aiBuildGuidePages',
  'aiBuildGuideRuns',
  'aiBuildGuideRunSteps',
  'aiBuildGuideRunArtifacts',
]);

type ID = number | string;
type ModelLike = { get?: (field: string) => unknown } & Record<string, unknown>;
type ScopeIndex = {
  managedWorkflowIds: Set<string>;
  allowedExecutionIds: Set<string>;
  executionWorkflowIds: Map<string, string>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function valueOf(model: unknown, key: string): unknown {
  if (!model || typeof model !== 'object') return undefined;
  const record = model as ModelLike;
  return typeof record.get === 'function' ? record.get(key) : record[key];
}

function idKey(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

function normalizeCollectionName(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim().split(':').at(-1) || null;
}

function isManagedWorkflowRecord(workflow: unknown): boolean {
  if (valueOf(workflow, 'key') === WORKFLOW_KEY) return true;
  const options: unknown = valueOf(workflow, 'options');
  const marker = isRecord(options) ? options[WORKFLOW_MARKER] : undefined;
  if (isRecord(marker) && marker.managed === true) return true;
  const config: unknown = valueOf(workflow, 'config');
  return isRecord(config) && normalizeCollectionName(config.collection) === 'aiBuildGuideRuns';
}

function targetsManaged(values: unknown) {
  if (!isRecord(values)) return false;
  const config = isRecord(values.config) ? values.config : {};
  const options = isRecord(values.options) ? values.options : {};
  return (
    values.key === WORKFLOW_KEY ||
    normalizeCollectionName(config.collection) === 'aiBuildGuideRuns' ||
    (isRecord(options[WORKFLOW_MARKER]) && options[WORKFLOW_MARKER].managed === true)
  );
}

function reject(ctx: Context): never {
  return ctx.throw(
    403,
    ctx.t('Use Build Guide settings to manage this workflow', { ns: 'plugin-workflow-build-guide' }),
  );
}

function expectedTargetCollection(resource: string) {
  if (resource === 'executions.jobs' || resource.startsWith('executions.jobs.')) return 'jobs';
  if (resource === 'jobs.execution' || resource.startsWith('jobs.execution.')) return 'executions';
  if (resource === 'workflows.nodes' || resource.startsWith('workflows.nodes.')) return 'flow_nodes';
  if (resource === 'workflows.executions' || resource.startsWith('workflows.executions.')) return 'executions';
  if (resource.includes('.')) return null;
  return normalizeCollectionName(resource);
}

async function getManagedWorkflowById(ctx: Context, workflowId: unknown) {
  if (typeof workflowId !== 'string' && typeof workflowId !== 'number') return null;
  const workflow = await ctx.db.getRepository('workflows').findOne({
    filterByTk: workflowId,
    fields: ['id', 'key', 'config', 'options'],
    appends: [],
  });
  return workflow && isManagedWorkflowRecord(workflow) ? workflow : null;
}

async function getExecutionForJob(ctx: Context, job: unknown) {
  const executionId = valueOf(job, 'executionId');
  if (typeof executionId !== 'string' && typeof executionId !== 'number') return null;
  return ctx.db.getRepository('executions').findOne({
    filterByTk: executionId,
    fields: ['id', 'workflowId'],
    appends: [],
  });
}

async function canReadSpace(ctx: Context, spaceId: unknown) {
  const safeSpaceId = idKey(spaceId);
  if (safeSpaceId == null) return false;
  const dataSource = ctx.app.dataSourceManager.get('main');
  let access;
  try {
    access = await dataSource.acl.resolveActionParams(ctx, {
      resourceName: 'aiBuildGuideSpaces',
      actionName: 'get',
      params: { filterByTk: safeSpaceId, fields: ['id'], appends: [] },
    });
  } catch (error) {
    if (error instanceof NoPermissionError) return false;
    throw error;
  }
  if (!access.can) return false;
  const space = await ctx.db.getRepository('aiBuildGuideSpaces').findOne({
    ...access.mergedParams,
    fields: ['id'],
    appends: [],
  });
  return Boolean(space);
}

async function buildScopeIndex(ctx: Context, rows: unknown[], resource: 'executions' | 'jobs'): Promise<ScopeIndex> {
  const executionIds = new Set<string>();
  if (resource === 'executions') {
    for (const row of rows) {
      const id = idKey(valueOf(row, 'id'));
      if (id) executionIds.add(id);
    }
  } else {
    for (const row of rows) {
      const id = idKey(valueOf(row, 'executionId'));
      if (id) executionIds.add(id);
    }
  }
  if (!executionIds.size) {
    return {
      managedWorkflowIds: new Set<string>(),
      allowedExecutionIds: new Set<string>(),
      executionWorkflowIds: new Map<string, string>(),
    };
  }

  const executionRows = await ctx.db.getRepository('executions').find({
    filter: { id: { $in: [...executionIds] } },
    fields: ['id', 'workflowId'],
    appends: [],
  });
  const executionWorkflowIds = new Map<string, string>();
  const workflowIds = new Set<string>();
  for (const execution of executionRows) {
    const executionId = idKey(valueOf(execution, 'id'));
    const workflowId = idKey(valueOf(execution, 'workflowId'));
    if (!executionId || !workflowId) continue;
    executionWorkflowIds.set(executionId, workflowId);
    workflowIds.add(workflowId);
  }
  if (!workflowIds.size) {
    return { managedWorkflowIds: new Set<string>(), allowedExecutionIds: new Set<string>(), executionWorkflowIds };
  }

  const workflows = await ctx.db.getRepository('workflows').find({
    filter: { id: { $in: [...workflowIds] } },
    fields: ['id', 'key', 'config', 'options'],
    appends: [],
  });
  const managedWorkflowIds = new Set<string>();
  for (const workflow of workflows) {
    if (!isManagedWorkflowRecord(workflow)) continue;
    const workflowId = idKey(valueOf(workflow, 'id'));
    if (workflowId) managedWorkflowIds.add(workflowId);
  }
  if (!managedWorkflowIds.size) {
    return { managedWorkflowIds, allowedExecutionIds: new Set<string>(), executionWorkflowIds };
  }

  const runs = await ctx.db.getRepository('aiBuildGuideRuns').find({
    filter: { engine: 'workflow', workflowRevisionId: { $in: [...managedWorkflowIds] } },
    fields: ['id', 'spaceId', 'workflowKey', 'workflowRevisionId', 'executionId'],
    appends: [],
  });
  const spaceByExecution = new Map<string, string>();
  for (const run of runs) {
    const executionId = idKey(valueOf(run, 'executionId'));
    const revisionId = idKey(valueOf(run, 'workflowRevisionId'));
    const spaceId = idKey(valueOf(run, 'spaceId'));
    if (
      !executionId ||
      !revisionId ||
      !spaceId ||
      valueOf(run, 'workflowKey') !== WORKFLOW_KEY ||
      !managedWorkflowIds.has(revisionId) ||
      executionWorkflowIds.get(executionId) !== revisionId
    ) {
      continue;
    }
    spaceByExecution.set(executionId, spaceId);
  }

  const readableSpaces = new Set<string>();
  for (const spaceId of new Set(spaceByExecution.values())) {
    if (await canReadSpace(ctx, spaceId)) readableSpaces.add(spaceId);
  }
  const allowedExecutionIds = new Set<string>();
  for (const [executionId, spaceId] of spaceByExecution) {
    if (readableSpaces.has(spaceId)) allowedExecutionIds.add(executionId);
  }
  return { managedWorkflowIds, allowedExecutionIds, executionWorkflowIds };
}

function isManagedExecution(index: ScopeIndex, executionId: unknown) {
  const key = idKey(executionId);
  if (!key) return false;
  const workflowId = index.executionWorkflowIds.get(key);
  return workflowId != null && index.managedWorkflowIds.has(workflowId);
}

function filterAccessibleRows(ctx: Context, rows: unknown[], index: ScopeIndex, resource: 'executions' | 'jobs') {
  const inaccessibleIds = rows
    .filter((row) => {
      const executionId = resource === 'executions' ? valueOf(row, 'id') : valueOf(row, 'executionId');
      return isManagedExecution(index, executionId) && !index.allowedExecutionIds.has(String(executionId));
    })
    .map((row) => idKey(valueOf(row, 'id')))
    .filter((id): id is string => id != null);
  if (String(ctx.action.actionName || '') === 'get' && paramsHasFilterByTk(ctx)) {
    if (inaccessibleIds.length) ctx.throw(404);
    return;
  }
  if (!inaccessibleIds.length) return;
  const params = ctx.action.params as Record<string, unknown>;
  const existingFilter = isRecord(params.filter) || Array.isArray(params.filter) ? params.filter : {};
  params.filter = { $and: [existingFilter, { id: { $notIn: inaccessibleIds } }] };
}

function paramsHasFilterByTk(ctx: Context) {
  const params = ctx.action.params as Record<string, unknown>;
  return params.filterByTk != null;
}

function normalizedReadParams(ctx: Context) {
  const params = { ...(ctx.action.params as Record<string, unknown>) };
  const action = String(ctx.action.actionName || 'list');
  for (const key of [
    'page',
    'pageSize',
    'limit',
    'offset',
    'sort',
    'paginate',
    'fields',
    'appends',
    'except',
    'tree',
  ]) {
    delete params[key];
  }
  if (action === 'list') delete params.filterByTk;
  return params;
}

async function findScopedRows(ctx: Context, resource: 'executions' | 'jobs') {
  const params = normalizedReadParams(ctx);
  const action = String(ctx.action.actionName || 'list');
  const access = await ctx.app.dataSourceManager.get('main').acl.resolveActionParams(ctx, {
    resourceName: resource,
    actionName: action,
    params,
  });
  if (!access.can) return [];
  return ctx.db.getRepository(resource).find({
    ...access.mergedParams,
    fields: resource === 'executions' ? ['id', 'workflowId'] : ['id', 'executionId'],
    appends: [],
  });
}

async function guardScopedRead(ctx: Context, resource: 'executions' | 'jobs') {
  const rows = await findScopedRows(ctx, resource);
  const index = await buildScopeIndex(ctx, rows, resource);
  filterAccessibleRows(ctx, rows, index, resource);
}

async function guardNestedWorkflowAccess(ctx: Context, resource: string, isRead: boolean) {
  const sourceId = idKey(ctx.action.sourceId);
  if (sourceId == null) return;
  if (resource.startsWith('workflows.executions')) {
    const workflow = await getManagedWorkflowById(ctx, sourceId);
    if (!workflow) return;
    if (!isRead) reject(ctx);
    const params = normalizedReadParams(ctx);
    const action = String(ctx.action.actionName || 'list');
    const requestedFilter = params.filter;
    const access = await ctx.app.dataSourceManager.get('main').acl.resolveActionParams(ctx, {
      resourceName: 'executions',
      actionName: action,
      params: {
        ...params,
        filter: { $and: [requestedFilter ?? {}, { workflowId: sourceId }] },
      },
    });
    if (!access.can) reject(ctx);
    const rows = await ctx.db.getRepository('executions').find({
      ...access.mergedParams,
      filter: { $and: [access.mergedParams.filter ?? {}, { workflowId: sourceId }] },
      fields: ['id', 'workflowId'],
      appends: [],
    });
    const index = await buildScopeIndex(ctx, rows, 'executions');
    filterAccessibleRows(ctx, rows, index, 'executions');
    return;
  }
  if (resource.startsWith('executions.jobs')) {
    if (!isRead) {
      const execution = await ctx.db.getRepository('executions').findOne({
        filterByTk: sourceId,
        fields: ['id', 'workflowId'],
        appends: [],
      });
      if (execution && (await getManagedWorkflowById(ctx, valueOf(execution, 'workflowId')))) reject(ctx);
      return;
    }
    const execution = await ctx.db.getRepository('executions').findOne({
      filterByTk: sourceId,
      fields: ['id', 'workflowId'],
      appends: [],
    });
    if (!execution) return;
    const index = await buildScopeIndex(ctx, [execution], 'executions');
    const executionId = idKey(valueOf(execution, 'id'));
    if (executionId && isManagedExecution(index, executionId) && !index.allowedExecutionIds.has(executionId)) {
      ctx.throw(404);
    }
  } else if (resource.startsWith('jobs.execution')) {
    if (!isRead) {
      const job = await ctx.db.getRepository('jobs').findOne({
        filterByTk: sourceId,
        fields: ['id', 'executionId'],
        appends: [],
      });
      const execution = job ? await getExecutionForJob(ctx, job) : null;
      if (execution && (await getManagedWorkflowById(ctx, valueOf(execution, 'workflowId')))) reject(ctx);
      return;
    }
    const job = await ctx.db.getRepository('jobs').findOne({
      filterByTk: sourceId,
      fields: ['id', 'executionId'],
      appends: [],
    });
    if (!job) return;
    const index = await buildScopeIndex(ctx, [job], 'jobs');
    const executionId = idKey(valueOf(job, 'executionId'));
    if (executionId && isManagedExecution(index, executionId) && !index.allowedExecutionIds.has(executionId)) {
      ctx.throw(404);
    }
  }
}

function hasManagedExecutionExpansion(params: Record<string, unknown>) {
  const includesExecutions = (value: unknown) => typeof value === 'string' && value.split('.')[0] === 'executions';
  return (
    (Array.isArray(params.appends) && params.appends.some(includesExecutions)) ||
    (Array.isArray(params.fields) && params.fields.some(includesExecutions))
  );
}

function stripManagedExecutionExpansion(params: Record<string, unknown>) {
  if (Array.isArray(params.appends)) {
    params.appends = params.appends.filter(
      (append) => !(typeof append === 'string' && append.split('.')[0] === 'executions'),
    );
  }
  if (Array.isArray(params.fields)) {
    params.fields = params.fields.filter(
      (field) => !(typeof field === 'string' && field.split('.')[0] === 'executions'),
    );
  }
}

async function guardWorkflowExecutionExpansion(ctx: Context) {
  const params = ctx.action.params as Record<string, unknown>;
  if (!hasManagedExecutionExpansion(params)) return;
  const action = String(ctx.action.actionName || 'list');
  const probeParams = normalizedReadParams(ctx);
  const access = await ctx.app.dataSourceManager.get('main').acl.resolveActionParams(ctx, {
    resourceName: 'workflows',
    actionName: action,
    params: probeParams,
  });
  if (!access.can) return;
  const workflows = await ctx.db.getRepository('workflows').find({
    ...access.mergedParams,
    fields: ['id', 'key', 'config', 'options'],
    appends: [],
  });
  if (workflows.some(isManagedWorkflowRecord)) stripManagedExecutionExpansion(params);
}

async function findMutationRows(ctx: Context, resource: 'workflows' | 'flow_nodes' | 'executions' | 'jobs') {
  const params = ctx.action.params as Record<string, unknown>;
  const access = await ctx.app.dataSourceManager.get('main').acl.resolveActionParams(ctx, {
    resourceName: resource,
    actionName: String(ctx.action.actionName || 'list'),
    params: { filterByTk: params.filterByTk, filter: params.filter },
  });
  if (!access.can) return [];
  const fields =
    resource === 'workflows'
      ? ['id', 'key', 'config', 'options']
      : resource === 'flow_nodes'
        ? ['id', 'workflowId']
        : resource === 'executions'
          ? ['id', 'workflowId']
          : ['id', 'executionId'];
  return ctx.db.getRepository(resource).find({ ...access.mergedParams, fields, appends: [] });
}

async function assertManagedMutationRows(ctx: Context, resource: 'workflows' | 'flow_nodes' | 'executions' | 'jobs') {
  const rows = await findMutationRows(ctx, resource);
  if (resource === 'workflows') {
    if (rows.some(isManagedWorkflowRecord)) reject(ctx);
    return;
  }
  if (resource === 'flow_nodes') {
    for (const row of rows) {
      if (await getManagedWorkflowById(ctx, valueOf(row, 'workflowId'))) reject(ctx);
    }
    return;
  }
  for (const row of rows) {
    const execution = resource === 'executions' ? row : await getExecutionForJob(ctx, row);
    if (execution && (await getManagedWorkflowById(ctx, valueOf(execution, 'workflowId')))) reject(ctx);
  }
}

async function assertManagedCreate(ctx: Context, resource: 'workflows' | 'flow_nodes' | 'executions' | 'jobs') {
  const params = ctx.action.params as Record<string, unknown>;
  const values: unknown = params.values;
  if (!isRecord(values)) return;
  if (resource === 'workflows') {
    if (targetsManaged(values)) reject(ctx);
    return;
  }
  if (resource === 'flow_nodes') {
    if (await getManagedWorkflowById(ctx, values.workflowId)) reject(ctx);
    return;
  }
  if (resource === 'executions') {
    if (await getManagedWorkflowById(ctx, values.workflowId)) reject(ctx);
    const context: unknown = values.context;
    const data = isRecord(context) && isRecord(context.data) ? context.data : null;
    if (data && (data.workflowKey === WORKFLOW_KEY || data.engine === 'workflow')) {
      const workflowId = data.workflowRevisionId;
      if (await getManagedWorkflowById(ctx, workflowId)) reject(ctx);
    }
    return;
  }
  if (values.executionId != null) {
    const executionId = idKey(values.executionId);
    if (executionId == null) return;
    const execution = await ctx.db.getRepository('executions').findOne({
      filterByTk: executionId,
      fields: ['id', 'workflowId'],
      appends: [],
    });
    if (execution && (await getManagedWorkflowById(ctx, valueOf(execution, 'workflowId')))) reject(ctx);
  }
}

export async function guardManagedWorkflowActions(ctx: Context, next: Next) {
  const rawResource = String(ctx.action?.resourceName || '');
  const resource = normalizeCollectionName(rawResource);
  const expectedTarget = resource ? expectedTargetCollection(resource) : null;
  const targetCollection = normalizeCollectionName(ctx.action?.params?.targetCollection);
  const action = String(ctx.action?.actionName || '');
  const values: unknown = ctx.action?.params?.values;
  const workflowResource = resource?.split('.')[0] || null;
  const protectedTarget =
    BUILD_GUIDE_COLLECTIONS.has(targetCollection || '') ||
    ['workflows', 'flow_nodes', 'executions', 'jobs'].includes(expectedTarget || '') ||
    ['workflows', 'flow_nodes', 'executions', 'jobs'].includes(workflowResource || '');

  if (targetCollection && protectedTarget && targetCollection !== expectedTarget) {
    reject(ctx);
  }

  if (resource?.includes('.')) {
    if (['workflows.executions', 'executions.jobs', 'jobs.execution'].some((prefix) => resource.startsWith(prefix))) {
      await guardNestedWorkflowAccess(ctx, resource, READ_ACTIONS.has(action));
      await next();
      return;
    }
  }

  if (workflowResource === 'workflows' && resource === 'workflows') {
    if (action === 'create' && targetsManaged(values)) reject(ctx);
    if (WORKFLOW_MUTATIONS.has(action)) {
      await assertManagedMutationRows(ctx, 'workflows');
      if (['create', 'update', 'firstOrCreate', 'updateOrCreate'].includes(action)) {
        if (targetsManaged(values)) reject(ctx);
      }
    }
    if (READ_ACTIONS.has(action)) await guardWorkflowExecutionExpansion(ctx);
  }

  if (resource === 'flow_nodes' || resource?.startsWith('workflows.nodes')) {
    if (NODE_MUTATIONS.has(action)) {
      if (resource === 'flow_nodes') await assertManagedMutationRows(ctx, 'flow_nodes');
      else if (await getManagedWorkflowById(ctx, ctx.action.sourceId)) reject(ctx);
      if (
        ['create', 'update', 'firstOrCreate', 'updateOrCreate'].includes(action) &&
        resource === 'flow_nodes' &&
        isRecord(values)
      ) {
        if (await getManagedWorkflowById(ctx, values.workflowId)) reject(ctx);
      }
    }
  }

  if (resource === 'executions' || resource === 'jobs') {
    if (READ_ACTIONS.has(action)) {
      await guardScopedRead(ctx, resource);
    } else {
      await assertManagedMutationRows(ctx, resource);
      if (['create', 'firstOrCreate', 'updateOrCreate'].includes(action)) await assertManagedCreate(ctx, resource);
    }
  }

  await next();
}
