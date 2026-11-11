/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Context, Next } from '@nocobase/actions';

const PRIVATE_RESOURCES = new Set(['aiBuildGuideRunSteps', 'aiBuildGuideRunArtifacts']);
const BUILD_GUIDE_RESOURCES = new Set([
  'aiBuildGuideSpaces',
  'aiBuildGuidePages',
  'aiBuildGuideRuns',
  ...PRIVATE_RESOURCES,
]);
const PRIVATE_SPACE_FIELDS = new Set([
  'status',
  'buildPhase',
  'buildRunId',
  'activeRunId',
  'latestRunId',
  'publishedRunId',
  'published',
  'buildLog',
  'buildQueuedAt',
  'buildStartedAt',
  'buildHeartbeatAt',
  'buildWorkerId',
  'generatedHtml',
  'generatedMarkdown',
  'planJson',
  'pageCount',
  'sourceHash',
]);
const PRIVATE_SPACE_ASSOCIATIONS = new Set(['pages', 'run', 'runs', 'runSteps', 'runArtifacts']);
const SENSITIVE_SPACE_READ_FIELDS = [
  'generatedHtml',
  'generatedMarkdown',
  'planJson',
  'buildLog',
  'buildWorkerId',
  'buildHeartbeatAt',
  'buildQueuedAt',
  'buildStartedAt',
  'sourceHash',
];

function normalizeCollectionName(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim().split(':').at(-1) || null;
}

function resourceRoot(value: string | null) {
  return value?.split('.')[0] || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reject(ctx: Context): never {
  return ctx.throw(
    403,
    ctx.t('Use Build Guide actions to manage runs and guide pages', { ns: 'plugin-build-guide-block' }),
  );
}

function filterSafeAppends(params: Record<string, unknown>, associations: Set<string>) {
  const appends = params.appends;
  if (!Array.isArray(appends)) return;
  params.appends = appends.filter((append) => {
    if (typeof append !== 'string') return false;
    return !associations.has(append.split('.')[0]);
  });
}

function filterSafeFields(params: Record<string, unknown>, associations: Set<string>, excludedFields: string[] = []) {
  const fields = params.fields;
  if (Array.isArray(fields)) {
    params.fields = fields.filter((field): field is string => {
      if (typeof field !== 'string') return false;
      const [root] = field.split('.');
      return !associations.has(root) && !excludedFields.includes(root);
    });
    return;
  }

  const except = Array.isArray(params.except)
    ? params.except.filter((field): field is string => typeof field === 'string')
    : typeof params.except === 'string'
      ? params.except
          .split(',')
          .map((field) => field.trim())
          .filter(Boolean)
      : [];
  params.except = [...new Set([...except, ...excludedFields])];
}

async function assertNoActiveSpacesInDestroyTarget(ctx: Context) {
  const params = ctx.action.params;
  const dataSource = ctx.app.dataSourceManager.get('main');
  const access = await dataSource.acl.resolveActionParams(ctx, {
    resourceName: 'aiBuildGuideSpaces',
    actionName: 'destroy',
    params: {
      filterByTk: params.filterByTk,
      filter: params.filter,
    },
  });
  if (!access.can) return;
  const spaces = await ctx.db.getRepository('aiBuildGuideSpaces').find({
    ...access.mergedParams,
    fields: ['id', 'status'],
    appends: [],
  });
  if (spaces.some((space) => space.get('status') === 'building')) reject(ctx);
}

function mergePublishedPageFilter(filter: unknown) {
  const publicFilter = { $or: [{ published: true }, { runId: null }] };
  return filter == null ? publicFilter : { $and: [filter, publicFilter] };
}

export async function guardBuildGuideResources(ctx: Context, next: Next) {
  const resource = normalizeCollectionName(ctx.action?.resourceName);
  const rootResource = resourceRoot(resource);
  const action = String(ctx.action?.actionName || '');
  const params = ctx.action?.params as Record<string, unknown> | undefined;
  const values: unknown = params?.values;
  const targetCollection = normalizeCollectionName(params?.targetCollection);
  const expectedTarget = resource === 'aiBuildGuideSpaces.pages' ? 'aiBuildGuidePages' : rootResource;

  if (targetCollection) {
    const isBuildGuideTarget = BUILD_GUIDE_RESOURCES.has(targetCollection);
    const isBuildGuideResource = rootResource != null && BUILD_GUIDE_RESOURCES.has(rootResource);
    if ((isBuildGuideTarget || isBuildGuideResource) && targetCollection !== expectedTarget) reject(ctx);
  }

  if (rootResource && PRIVATE_RESOURCES.has(rootResource)) reject(ctx);

  if (rootResource === 'aiBuildGuideRuns') {
    if (!['getStatus', 'cancel', 'retry'].includes(action)) reject(ctx);
    filterSafeAppends(params ?? {}, new Set(['space', 'artifacts', 'steps']));
  }

  if (rootResource === 'aiBuildGuideSpaces') {
    if (['create', 'update', 'firstOrCreate', 'updateOrCreate'].includes(action) && isRecord(values)) {
      if ([...PRIVATE_SPACE_FIELDS].some((field) => field in values)) reject(ctx);
      if ([...PRIVATE_SPACE_ASSOCIATIONS].some((field) => field in values)) reject(ctx);
      if ('engine' in values && values.engine !== 'legacy' && values.engine !== 'workflow') reject(ctx);
    }
    const associationValues = params?.updateAssociationValues;
    if (['create', 'update', 'firstOrCreate', 'updateOrCreate'].includes(action) && isRecord(associationValues)) {
      if ([...PRIVATE_SPACE_ASSOCIATIONS].some((field) => field in associationValues)) {
        reject(ctx);
      }
    }
    if (action === 'destroy') await assertNoActiveSpacesInDestroyTarget(ctx);
    filterSafeAppends(params ?? {}, PRIVATE_SPACE_ASSOCIATIONS);
    filterSafeFields(params ?? {}, PRIVATE_SPACE_ASSOCIATIONS, SENSITIVE_SPACE_READ_FIELDS);
  }

  if (rootResource === 'aiBuildGuidePages' || resource === 'aiBuildGuideSpaces.pages') {
    if (!['list', 'get'].includes(action)) reject(ctx);
    filterSafeAppends(params ?? {}, new Set(['space', 'run', 'runSteps', 'runArtifacts']));
    filterSafeFields(params ?? {}, new Set(['space', 'run', 'runSteps', 'runArtifacts']));
    if (action === 'list') {
      if (!params) reject(ctx);
      params.filter = mergePublishedPageFilter(params.filter);
    } else if (action === 'get') {
      const id = params?.filterByTk;
      if (typeof id !== 'string' && typeof id !== 'number') {
        await next();
        return;
      }
      const page = id == null ? null : await ctx.db.getRepository('aiBuildGuidePages').findById(id);
      if (page && page.get('published') !== true && page.get('runId') != null) {
        ctx.throw(404, ctx.t('User Guide not found', { ns: 'plugin-build-guide-block' }));
      }
    }
  }

  await next();
}
