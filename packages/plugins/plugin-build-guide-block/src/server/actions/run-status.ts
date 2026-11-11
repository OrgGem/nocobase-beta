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

function fieldsAllow(fields: unknown, excluded: unknown, required: string[]) {
  const allowedFields = Array.isArray(fields) ? fields.map(String) : undefined;
  const excludedFields = Array.isArray(excluded) ? excluded.map(String) : [];
  return required.every(
    (field) => (!allowedFields || allowedFields.includes(field)) && !excludedFields.includes(field),
  );
}

async function getAccessibleRun(ctx: Context, runId: unknown, actionName: 'getStatus' | 'cancel' | 'retry') {
  if (typeof runId !== 'string' || !runId)
    ctx.throw(400, ctx.t('Run id is required', { ns: 'plugin-build-guide-block' }));
  const dataSource = ctx.app.dataSourceManager.get('main');
  let runAccess;
  try {
    runAccess = await dataSource.acl.resolveActionParams(ctx, {
      resourceName: 'aiBuildGuideRuns',
      actionName,
      params: { filterByTk: runId },
    });
  } catch (error) {
    if (error instanceof NoPermissionError)
      ctx.throw(403, ctx.t('Guide access denied.', { ns: 'plugin-build-guide-block' }));
    throw error;
  }
  if (!runAccess.can) ctx.throw(403, ctx.t('Guide access denied.', { ns: 'plugin-build-guide-block' }));
  const requiredRunFields =
    actionName === 'getStatus'
      ? ['id', 'spaceId', 'engine', 'status', 'stage', 'expectedCount', 'completedCount', 'errorCode', 'executionId']
      : ['id', 'spaceId', 'engine', 'status'];
  if (!fieldsAllow(runAccess.parsedParams?.fields, runAccess.parsedParams?.except, requiredRunFields)) {
    ctx.throw(403, ctx.t('Guide access denied.', { ns: 'plugin-build-guide-block' }));
  }
  const run = await ctx.db.getRepository('aiBuildGuideRuns').findOne({
    ...runAccess.mergedParams,
    filterByTk: runId,
    appends: [],
  });
  if (!run) ctx.throw(404, ctx.t('Build run not found', { ns: 'plugin-build-guide-block' }));

  let spaceAccess;
  try {
    spaceAccess = await dataSource.acl.resolveActionParams(ctx, {
      resourceName: 'aiBuildGuideSpaces',
      actionName: 'get',
      params: { filterByTk: run.get('spaceId') },
    });
  } catch (error) {
    if (error instanceof NoPermissionError)
      ctx.throw(403, ctx.t('Guide access denied.', { ns: 'plugin-build-guide-block' }));
    throw error;
  }
  if (!spaceAccess.can) ctx.throw(403, ctx.t('Guide access denied.', { ns: 'plugin-build-guide-block' }));
  if (!fieldsAllow(spaceAccess.parsedParams?.fields, spaceAccess.parsedParams?.except, ['id'])) {
    ctx.throw(403, ctx.t('Guide access denied.', { ns: 'plugin-build-guide-block' }));
  }
  const space = await ctx.db.getRepository('aiBuildGuideSpaces').findOne({
    ...spaceAccess.mergedParams,
    filterByTk: run.get('spaceId'),
    fields: ['id'],
    appends: [],
  });
  if (!space) ctx.throw(404, ctx.t('Build run not found', { ns: 'plugin-build-guide-block' }));
  return { run, dataSource };
}

async function canAccessRunControl(
  ctx: Context,
  runId: string,
  spaceId: string,
  actionName: 'cancel' | 'retry',
): Promise<boolean> {
  const dataSource = ctx.app.dataSourceManager.get('main');
  try {
    const runAccess = await dataSource.acl.resolveActionParams(ctx, {
      resourceName: 'aiBuildGuideRuns',
      actionName,
      params: { filterByTk: runId },
    });
    if (
      !runAccess.can ||
      !fieldsAllow(runAccess.parsedParams?.fields, runAccess.parsedParams?.except, [
        'id',
        'spaceId',
        'engine',
        'status',
      ])
    ) {
      return false;
    }
    const run = await ctx.db.getRepository('aiBuildGuideRuns').findOne({
      ...runAccess.mergedParams,
      filterByTk: runId,
      fields: ['id', 'spaceId'],
      appends: [],
    });
    if (!run || String(run.get('spaceId')) !== spaceId) return false;

    const spaceAccess = await dataSource.acl.resolveActionParams(ctx, {
      resourceName: 'aiBuildGuideSpaces',
      actionName: 'get',
      params: { filterByTk: spaceId },
    });
    if (!spaceAccess.can || !fieldsAllow(spaceAccess.parsedParams?.fields, spaceAccess.parsedParams?.except, ['id'])) {
      return false;
    }
    const space = await ctx.db.getRepository('aiBuildGuideSpaces').findOne({
      ...spaceAccess.mergedParams,
      filterByTk: spaceId,
      fields: ['id'],
      appends: [],
    });
    return Boolean(space);
  } catch (error) {
    if (error instanceof NoPermissionError) return false;
    throw error;
  }
}

async function canReadRunSources(ctx: Context, runId: string): Promise<boolean> {
  const artifact = await ctx.db.getRepository('aiBuildGuideRunArtifacts').findOne({
    filter: { runId, artifactKey: 'input' },
    appends: [],
  });
  const payload: unknown = artifact?.get('payload');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const documents: unknown = (payload as Record<string, unknown>).documents;
  if (!Array.isArray(documents)) return false;

  const dataSource = ctx.app.dataSourceManager.get('main');
  const requiredFields = ['id', 'updatedAt', 'filename', 'mimetype', 'extname', 'url', 'storageId'];
  for (const document of documents) {
    if (!document || typeof document !== 'object' || Array.isArray(document)) return false;
    const saved = document as Record<string, unknown>;
    if (
      (typeof saved.id !== 'string' && typeof saved.id !== 'number') ||
      typeof saved.updatedAt !== 'string' ||
      typeof saved.filename !== 'string' ||
      typeof saved.mimetype !== 'string' ||
      typeof saved.extname !== 'string'
    ) {
      return false;
    }
    let attachmentAccess;
    try {
      attachmentAccess = await dataSource.acl.resolveActionParams(ctx, {
        resourceName: 'attachments',
        actionName: 'get',
        params: { filterByTk: saved.id },
      });
    } catch (error) {
      if (error instanceof NoPermissionError) return false;
      throw error;
    }
    if (
      !attachmentAccess.can ||
      !fieldsAllow(attachmentAccess.parsedParams?.fields, attachmentAccess.parsedParams?.except, requiredFields)
    ) {
      return false;
    }
    const attachment = await ctx.db.getRepository('attachments').findOne({
      ...attachmentAccess.mergedParams,
      filterByTk: saved.id,
      appends: [],
      fields: requiredFields,
    });
    if (!attachment) return false;
    const updatedAt = attachment.get('updatedAt');
    const updatedAtValue = updatedAt instanceof Date ? updatedAt.toISOString() : String(updatedAt ?? '');
    if (
      String(attachment.get('id')) !== String(saved.id) ||
      updatedAtValue !== saved.updatedAt ||
      String(attachment.get('filename') ?? '') !== saved.filename ||
      String(attachment.get('mimetype') ?? '') !== saved.mimetype ||
      String(attachment.get('extname') ?? '') !== saved.extname
    ) {
      return false;
    }
  }
  return true;
}

export async function getBuildGuideRunStatus(ctx: Context, next: Next) {
  const { run, dataSource } = await getAccessibleRun(ctx, ctx.action.params.filterByTk, 'getStatus');
  const runId = String(run.get('id'));

  const stepRows = await ctx.db.getRepository('aiBuildGuideRunSteps').find({
    filter: { runId },
    fields: ['stepKey', 'status', 'attempt', 'errorCode'],
    sort: ['createdAt'],
    appends: [],
  });
  let executionId: string | number | undefined;
  const rawExecutionId: unknown = run.get('executionId');
  if (typeof rawExecutionId === 'string' || typeof rawExecutionId === 'number') {
    try {
      const executionAccess = await dataSource.acl.resolveActionParams(ctx, {
        resourceName: 'executions',
        actionName: 'get',
        params: { filterByTk: rawExecutionId },
      });
      if (
        executionAccess.can &&
        fieldsAllow(executionAccess.parsedParams?.fields, executionAccess.parsedParams?.except, ['id'])
      ) {
        const execution = await ctx.db.getRepository('executions').findOne({
          ...executionAccess.mergedParams,
          filterByTk: rawExecutionId,
          fields: ['id'],
          appends: [],
        });
        if (execution) executionId = rawExecutionId;
      }
    } catch (error) {
      if (!(error instanceof NoPermissionError)) throw error;
    }
  }

  const runStatus = String(run.get('status'));
  const runEngine = String(run.get('engine'));
  const adapter = (ctx.app.pm.get('plugin-workflow-build-guide') || ctx.app.pm.get('workflow-build-guide')) as
    | { canRetryRun?: (runId: string) => Promise<boolean>; cancelRun?: unknown }
    | undefined;
  const canCancel = Boolean(
    runEngine === 'workflow' &&
      ['queued', 'running', 'unknown'].includes(runStatus) &&
      typeof adapter?.cancelRun === 'function' &&
      (await canAccessRunControl(ctx, runId, String(run.get('spaceId')), 'cancel')),
  );
  const canRetry = Boolean(
    runEngine === 'workflow' &&
      ['failed', 'cancelled'].includes(runStatus) &&
      (await canAccessRunControl(ctx, runId, String(run.get('spaceId')), 'retry')) &&
      (await adapter?.canRetryRun?.(runId)) &&
      (await canReadRunSources(ctx, runId)),
  );

  ctx.body = {
    id: run.get('id'),
    spaceId: run.get('spaceId'),
    engine: runEngine,
    status: runStatus,
    stage: run.get('stage'),
    expectedCount: run.get('expectedCount'),
    completedCount: run.get('completedCount'),
    errorCode: run.get('errorCode') || undefined,
    canCancel,
    canRetry,
    ...(executionId === undefined ? {} : { executionId }),
    steps: stepRows.map((step: { get: (field: string) => unknown }) => ({
      stepKey: step.get('stepKey'),
      status: step.get('status'),
      attempt: step.get('attempt'),
      errorCode: step.get('errorCode') || undefined,
    })),
  };
  await next();
}

export async function cancelBuildGuideRun(ctx: Context, next: Next) {
  const { run } = await getAccessibleRun(ctx, ctx.action.params.filterByTk, 'cancel');
  const runId = String(run.get('id'));
  const adapter = (ctx.app.pm.get('plugin-workflow-build-guide') || ctx.app.pm.get('workflow-build-guide')) as
    | { cancelRun?: (runId: string) => Promise<boolean> }
    | undefined;
  if (!adapter?.cancelRun) {
    ctx.throw(503, ctx.t('Workflow Build Guide adapter is unavailable', { ns: 'plugin-build-guide-block' }));
    return;
  }
  const changed = await adapter.cancelRun(runId);
  if (!changed) ctx.throw(409, ctx.t('This build run cannot be cancelled', { ns: 'plugin-build-guide-block' }));
  ctx.body = { status: 'cancelled', runId };
  await next();
}

export async function retryBuildGuideRun(ctx: Context, next: Next) {
  const { run } = await getAccessibleRun(ctx, ctx.action.params.filterByTk, 'retry');
  const runId = String(run.get('id'));
  if (!(await canReadRunSources(ctx, runId))) {
    ctx.throw(403, ctx.t('Guide access denied.', { ns: 'plugin-build-guide-block' }));
  }
  const adapter = (ctx.app.pm.get('plugin-workflow-build-guide') || ctx.app.pm.get('workflow-build-guide')) as
    | { retryRun?: (runId: string, requesterId: string) => Promise<string> }
    | undefined;
  if (!adapter?.retryRun) {
    ctx.throw(503, ctx.t('Workflow Build Guide adapter is unavailable', { ns: 'plugin-build-guide-block' }));
    return;
  }
  const newRunId = await adapter.retryRun(runId, String(ctx.state?.currentUser?.id ?? ''));
  ctx.body = { status: 'queued', runId: newRunId };
  await next();
}
