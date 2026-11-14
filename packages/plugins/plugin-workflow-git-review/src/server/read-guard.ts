/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Context, Next } from '@nocobase/actions';
import { hasRepositoryAccess } from 'plugin-git-manager/server';
import { isRecord, type ID } from './contracts';
import {
  findReviewFlowBinding,
  findReviewRequest,
  listReviewFlowKeys,
  listReviewRequests,
  targetsReviewCollection,
} from './review-schema';

type Policy = 'unmanaged' | 'allowed' | 'denied';
type WorkflowIdentityRow = { id: ID; key?: unknown; config?: unknown; options?: { gitReview?: unknown } | null };

function id(value: unknown): value is ID {
  return typeof value === 'string' || typeof value === 'number';
}

function denied(ctx: Context): never {
  return ctx.throw(403, ctx.t('Permission denied', { ns: 'plugin-workflow-git-review' }));
}

const ROUTE_KEYS = new Set(['targetCollection', 'resourceName', 'associatedName', '__collection']);
const PROTECTED_TARGETS = new Set(['jobs', 'executions']);

function containsOtherTarget(value: unknown, expected: string): boolean {
  if (typeof value === 'string')
    return value.split(/[.[\],:/()=\s]+/).some((part) => PROTECTED_TARGETS.has(part) && part !== expected);
  if (Array.isArray(value)) return value.some((item) => containsOtherTarget(item, expected));
  return isRecord(value) && Object.values(value).some((item) => containsOtherTarget(item, expected));
}

function crossTarget(value: unknown, expected: string, resource: string): boolean {
  if (Array.isArray(value)) return value.some((item) => crossTarget(item, expected, resource));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, nested]) => {
    const parts = key.split(/[.[\],:/()=\s]+/).filter((part) => ROUTE_KEYS.has(part));
    const isOriginalRoute =
      typeof nested === 'string' &&
      nested === resource &&
      parts.every((part) => part === 'resourceName' || part === 'associatedName');
    return (
      (!isOriginalRoute && parts.length > 0 && containsOtherTarget(nested, expected)) ||
      crossTarget(nested, expected, resource)
    );
  });
}

/** Apply the Git Manager repository scope to workflow records, including expanded associations. */
export async function guardReviewReads(ctx: Context, next: Next) {
  const action = ctx.action?.actionName;
  const resource = ctx.action?.resourceName;
  let currentTarget: string | undefined;
  if (resource) {
    try {
      const repository = ctx.getCurrentRepository?.();
      currentTarget = repository?.targetCollection?.name || repository?.collection?.name;
    } catch (_error) {
      // Custom actions may not have a repository.
    }
    const expected = currentTarget || resource.split('.').pop() || resource;
    if (
      [
        { targetCollection: ctx.action?.params?.targetCollection, __collection: ctx.action?.params?.__collection },
        ctx.request?.body,
        ctx.query,
        ctx.request?.query,
      ].some((value) => crossTarget(value, expected, resource))
    )
      denied(ctx);
  }
  if (!resource || !['get', 'list', 'listMine', 'cancel'].includes(action)) return next();
  const target = currentTarget || resource.split('.').pop() || resource;
  const roles: unknown = ctx.state?.currentRoles;
  const currentRoles = Array.isArray(roles) && roles.every((item) => typeof item === 'string') ? roles : [];
  const cache = new Map<string, Policy>();

  const executionPolicy = async (executionId: ID): Promise<Policy> => {
    const key = String(executionId);
    const existing = cache.get(key);
    if (existing) return existing;
    const execution = await ctx.db.getRepository('executions').findOne({ filterByTk: executionId });
    const request = await findReviewRequest(ctx.db, { executionId });
    const workflow = execution?.workflowId
      ? await ctx.db.getRepository('workflows').findOne({ filterByTk: execution.workflowId })
      : null;
    const bound = workflow ? await findReviewFlowBinding(ctx.db, workflow.key) : 'missing';
    const workflowRequest =
      !request && workflow?.id ? await findReviewRequest(ctx.db, { workflowId: workflow.id }) : null;
    const managed = Boolean(
      request ||
        workflowRequest ||
        isRecord(workflow?.options?.gitReview) ||
        targetsReviewCollection(workflow?.config) ||
        bound === 'found',
    );
    if (!managed) return 'unmanaged';
    let result: Policy = 'denied';
    if (
      ctx.state?.currentUser?.id != null &&
      execution &&
      request &&
      workflow &&
      String(request.workflowId) === String(execution.workflowId) &&
      id(request.repositoryId)
    ) {
      const review = await ctx.db.getRepository('gitCodeReviews').findOne({ filterByTk: request.reviewId });
      if (review && String(review.repositoryId) === String(request.repositoryId)) {
        const gitAction = review.targetType === 'mr' ? 'mergeRequestDetail' : 'fileContent';
        if (
          await hasRepositoryAccess({
            acl: ctx.app.acl,
            roles: currentRoles,
            repositoryId: request.repositoryId,
            action: gitAction,
          })
        ) {
          result = 'allowed';
        }
      }
    }
    cache.set(key, result);
    return result;
  };

  const jobPolicy = async (jobId: ID): Promise<Policy> => {
    const job = await ctx.db.getRepository('jobs').findOne({ filterByTk: jobId });
    if (!job) return 'unmanaged';
    if (id(job.executionId)) {
      const policy = await executionPolicy(job.executionId);
      if (policy !== 'unmanaged') return policy;
    }
    const node = id(job.nodeId) ? await ctx.db.getRepository('flow_nodes').findOne({ filterByTk: job.nodeId }) : null;
    const workflow = node?.workflowId
      ? await ctx.db.getRepository('workflows').findOne({ filterByTk: node.workflowId })
      : null;
    const bound = workflow ? await findReviewFlowBinding(ctx.db, workflow.key) : 'missing';
    if (isRecord(workflow?.options?.gitReview) || targetsReviewCollection(workflow?.config) || bound === 'found')
      return 'denied';
    if (workflow?.id && (await findReviewRequest(ctx.db, { workflowId: workflow.id }))) {
      return 'denied';
    }
    if (!workflow && typeof job.nodeKey === 'string' && job.nodeKey.startsWith('gr_')) return 'denied';
    return 'unmanaged';
  };

  const tk = ctx.action.params.filterByTk;
  let rootIdentity: ID | undefined;
  if (action === 'get') {
    if (
      (ctx.action.sourceId == null || ctx.action.sourceId === '_') &&
      (!PROTECTED_TARGETS.has(target) || resource === target)
    ) {
      if (id(tk)) rootIdentity = tk;
    }
  }
  if (target === 'jobs' && action === 'get' && rootIdentity != null && (await jobPolicy(rootIdentity)) === 'denied')
    denied(ctx);
  const directExecutionId = action === 'cancel' && id(tk) ? tk : rootIdentity;
  if (
    target === 'executions' &&
    ['get', 'cancel'].includes(action) &&
    directExecutionId != null &&
    (await executionPolicy(directExecutionId)) === 'denied'
  )
    denied(ctx);
  if (
    resource === 'executions.jobs' &&
    id(ctx.action.sourceId) &&
    (await executionPolicy(ctx.action.sourceId)) === 'denied'
  )
    denied(ctx);
  if (resource.startsWith('jobs.') && id(ctx.action.sourceId) && (await jobPolicy(ctx.action.sourceId)) === 'denied')
    denied(ctx);
  if (
    resource.startsWith('executions.') &&
    id(ctx.action.sourceId) &&
    (await executionPolicy(ctx.action.sourceId)) === 'denied'
  )
    denied(ctx);

  if (action === 'list' && (target === 'executions' || target === 'jobs')) {
    const requests = await listReviewRequests(ctx.db);
    const keys = new Set(await listReviewFlowKeys(ctx.db));
    const requestWorkflows = new Set(
      requests.filter((request) => id(request.workflowId)).map((request) => String(request.workflowId)),
    );
    const workflows = (await ctx.db.getRepository('workflows').find({
      fields: ['id', 'key', 'options', 'config'],
    })) as WorkflowIdentityRow[];
    const managedIds = workflows
      .filter(
        (workflow) =>
          isRecord(workflow.options?.gitReview) ||
          targetsReviewCollection(workflow.config) ||
          keys.has(String(workflow.key)) ||
          requestWorkflows.has(String(workflow.id)),
      )
      .map((workflow) => workflow.id);
    const executions = managedIds.length
      ? await ctx.db.getRepository('executions').find({ filter: { workflowId: { $in: managedIds } }, fields: ['id'] })
      : [];
    const candidates = new Map<string, ID>();
    for (const request of requests)
      if (id(request.executionId)) candidates.set(String(request.executionId), request.executionId);
    for (const execution of executions) if (id(execution.id)) candidates.set(String(execution.id), execution.id);
    const excluded: ID[] = [];
    for (const executionId of candidates.values()) {
      if ((await executionPolicy(executionId)) === 'denied') excluded.push(executionId);
    }
    if (excluded.length) {
      ctx.action.mergeParams({ filter: { [target === 'jobs' ? 'executionId' : 'id']: { $notIn: excluded } } });
    }
  }

  const association = (collectionName: string, name: string) => {
    const collection = ctx.db.getCollection(collectionName);
    const field = collection?.getField(name);
    if (!field?.isRelationField()) return null;
    const relation = field as unknown as { target?: unknown };
    const modelAssociation = collection.model.associations[name] as unknown as
      | { associationType?: string; foreignKey?: string; targetKey?: string }
      | undefined;
    return typeof relation.target === 'string' ? { target: relation.target, modelAssociation } : null;
  };
  await next();
  const scrub = async (value: unknown, collectionName: string, identity?: ID, executionHint?: ID): Promise<unknown> => {
    if (Array.isArray(value)) {
      const rows = await Promise.all(value.map((item) => scrub(item, collectionName, undefined, executionHint)));
      return rows.filter((item) => item !== null);
    }
    if (!value || typeof value !== 'object') return value;
    if (value instanceof Date || Buffer.isBuffer(value)) return value;
    const candidate = value as { toJSON?: () => unknown };
    const plain = typeof candidate.toJSON === 'function' ? candidate.toJSON() : value;
    if (!isRecord(plain)) return plain;
    const record = { ...plain };
    const paginationKeys = new Set([
      'rows',
      'items',
      'count',
      'page',
      'pageSize',
      'totalPage',
      'hasNext',
      'snapshot',
      'nextCursor',
      'total',
    ]);
    if (
      (Array.isArray(record.rows) || Array.isArray(record.items)) &&
      Object.keys(record).every((key) => paginationKeys.has(key))
    ) {
      for (const key of ['rows', 'items']) {
        if (Array.isArray(record[key]))
          record[key] = await scrub(record[key], collectionName, undefined, executionHint);
      }
      return record;
    }
    const recordId = id(record.id) ? record.id : identity;
    const isExecution = collectionName === 'executions';
    const isJob = collectionName === 'jobs';
    const executionId = isExecution ? recordId : id(record.executionId) ? record.executionId : executionHint;
    if (isExecution && executionId != null && (await executionPolicy(executionId)) === 'denied') return null;
    if (isExecution && executionId == null) delete record.context;
    if (isJob) {
      const policy =
        recordId != null
          ? await jobPolicy(recordId)
          : executionId != null
            ? await executionPolicy(executionId)
            : 'denied';
      if (policy === 'denied') return null;
    }
    for (const [key, nested] of Object.entries(record)) {
      if (!nested || typeof nested !== 'object') continue;
      const relation = association(collectionName, key);
      if (!relation) continue;
      let relatedId: ID | undefined;
      const { modelAssociation } = relation;
      const targetPrimaryKey = ctx.db.getCollection(relation.target)?.model.primaryKeyAttribute;
      if (
        recordId != null &&
        modelAssociation?.associationType === 'BelongsTo' &&
        modelAssociation.foreignKey &&
        modelAssociation.targetKey &&
        modelAssociation.targetKey === targetPrimaryKey
      ) {
        const foreignKey = modelAssociation.foreignKey;
        const foreignId: unknown = record[foreignKey];
        if (id(foreignId)) relatedId = foreignId;
      }
      record[key] = await scrub(nested, relation.target, relatedId);
    }
    return record;
  };
  ctx.body = await scrub(
    ctx.body,
    target,
    rootIdentity,
    id(ctx.action.sourceId) && resource === 'executions.jobs' ? ctx.action.sourceId : undefined,
  );
}
