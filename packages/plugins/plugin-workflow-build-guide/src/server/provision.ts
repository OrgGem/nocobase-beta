/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Application } from '@nocobase/server';
import type { Transaction } from '@nocobase/database';
import type WorkflowPlugin from '@nocobase/plugin-workflow';
import { buildTemplate, WORKFLOW_KEY, WORKFLOW_MARKER, type TemplateNode } from './templates';

export type ID = string | number;
export type SetupResult = { workflowId: ID | null; workflowKey: string; enabled: boolean; blockers: string[] };
type WorkflowNodeRecord = {
  id: ID;
  key: string;
  type: string;
  config: Record<string, unknown>;
  branchIndex?: number | null;
  upstreamId?: ID | null;
  downstreamId?: ID | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => equal(value, right[index]))
    );
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => key === rightKeys[index] && equal(left[key], right[key]))
    );
  }
  return false;
}

export function expectedConfig(workflowId: ID) {
  return {
    collection: 'aiBuildGuideRuns',
    mode: 1,
    condition: {
      engine: { $eq: 'workflow' },
      workflowRevisionId: { $eq: String(workflowId) },
    },
  };
}

export async function assertSafeWorkflow(
  app: Application,
  workflowId: ID,
  transaction?: Transaction,
): Promise<boolean> {
  const workflow = await app.db.getRepository('workflows').findOne({ filterByTk: workflowId, transaction });
  if (
    !workflow ||
    workflow.key !== WORKFLOW_KEY ||
    workflow.type !== 'collection' ||
    !equal(workflow.config, expectedConfig(workflow.id))
  ) {
    return false;
  }
  const options = workflow.options;
  const marker = isRecord(options) ? options[WORKFLOW_MARKER] : null;
  if (!isRecord(marker) || marker.managed !== true || marker.templateVersion !== 1) return false;
  const expected = buildTemplate();
  const nodes = (await app.db.getRepository('flow_nodes').find({
    filter: { workflowId },
    sort: ['id'],
    transaction,
  })) as unknown as WorkflowNodeRecord[];
  if (nodes.length !== expected.length) return false;
  const nodeByKey = new Map(nodes.map((node) => [node.key, node]));
  for (const definition of expected) {
    const node = nodeByKey.get(definition.key);
    if (
      !node ||
      node.type !== definition.type ||
      !equal(node.config, definition.config) ||
      node.branchIndex !== (definition.branchIndex ?? null)
    ) {
      return false;
    }
  }
  const prepare = nodeByKey.get('guide_prepare');
  const plan = nodeByKey.get('guide_plan');
  const loop = nodeByKey.get('guide_chapters');
  const chapter = nodeByKey.get('guide_chapter');
  const publish = nodeByKey.get('guide_publish');
  return Boolean(
    prepare &&
      plan &&
      loop &&
      chapter &&
      publish &&
      String(plan.upstreamId) === String(prepare.id) &&
      String(loop.upstreamId) === String(plan.id) &&
      String(chapter.upstreamId) === String(loop.id) &&
      String(loop.downstreamId) === String(publish.id) &&
      String(prepare.downstreamId) === String(plan.id) &&
      String(plan.downstreamId) === String(loop.id),
  );
}

async function activeRunsForRevision(app: Application, revisionId: ID, transaction?: unknown) {
  return app.db.getRepository('aiBuildGuideRuns').count({
    filter: {
      engine: 'workflow',
      workflowRevisionId: String(revisionId),
      status: ['queued', 'running', 'unknown'],
    },
    transaction,
  } as never);
}

async function createRevision(app: Application): Promise<ID> {
  const repo = app.db.getRepository('workflows');
  const existing = await repo.find({ filter: { key: WORKFLOW_KEY }, sort: ['-id'] });
  for (const revision of existing) {
    if (revision.enabled && !(await assertSafeWorkflow(app, revision.id))) {
      throw new Error('An enabled Build Guide workflow revision is not managed safely');
    }
    if (revision.enabled) return revision.id;
    if (await activeRunsForRevision(app, revision.id)) {
      throw new Error('Drain all runs from the previous Build Guide workflow revision before setup');
    }
  }

  return app.db.sequelize.transaction(async (transaction) => {
    const workflow = await repo.create({
      values: {
        key: WORKFLOW_KEY,
        current: null,
        enabled: false,
        title: 'Build Guide generation',
        type: 'collection',
        sync: false,
        config: { collection: 'aiBuildGuideRuns', mode: 1, condition: {} },
        options: { timeout: 60 * 60 * 1000, [WORKFLOW_MARKER]: { managed: true, templateVersion: 1 } },
      },
      transaction,
    });
    await workflow.update({ config: expectedConfig(workflow.id) }, { transaction });
    const definitions = buildTemplate();
    const created = new Map<string, Awaited<ReturnType<typeof workflow.createNode>>>();
    let previous: Awaited<ReturnType<typeof workflow.createNode>> | null = null;
    for (const definition of definitions) {
      const values: TemplateNode & { upstreamId?: ID | null } = {
        ...definition,
        upstreamId:
          definition.key === 'guide_publish'
            ? created.get('guide_chapters')?.id ?? null
            : definition.branchIndex === 0
              ? created.get('guide_chapters')?.id ?? null
              : previous?.id ?? null,
      };
      const node = await workflow.createNode(values, { transaction });
      created.set(definition.key, node);
      if (definition.branchIndex === 0) continue;
      if (previous) await previous.update({ downstreamId: node.id }, { transaction });
      previous = node;
    }
    if (!(await assertSafeWorkflow(app, workflow.id, transaction))) {
      throw new Error('The managed Build Guide workflow graph failed validation');
    }
    const active = await repo.find({
      filter: { key: WORKFLOW_KEY, enabled: true },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    for (const revision of active) await revision.update({ enabled: false }, { transaction });
    await workflow.update({ enabled: true }, { transaction });
    if (!(await assertSafeWorkflow(app, workflow.id, transaction))) {
      throw new Error('The managed Build Guide workflow graph failed validation');
    }
    return workflow.id;
  });
}

export async function setupWorkflow(app: Application, _workflowPlugin: WorkflowPlugin): Promise<SetupResult> {
  const lock = await app.lockManager.tryAcquire('workflow-build-guide:provision', 60_000);
  const workflowId = await lock.runExclusive(() => createRevision(app), 120_000);
  const revision = await app.db.getRepository('workflows').findOne({ filterByTk: workflowId });
  return {
    workflowId,
    workflowKey: WORKFLOW_KEY,
    enabled: Boolean(revision?.enabled),
    blockers: revision?.enabled && (await assertSafeWorkflow(app, workflowId)) ? [] : ['unsafe_or_disabled_revision'],
  };
}
