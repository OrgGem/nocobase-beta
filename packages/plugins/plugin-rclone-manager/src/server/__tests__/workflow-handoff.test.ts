// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SequelizeDataSource } from '@nocobase/data-source-manager';
import type WorkflowPlugin from '@nocobase/plugin-workflow';
import {
  EXECUTION_STATUS,
  JOB_STATUS,
  type ExecutionModel,
  type JobModel,
  type WorkflowModel,
} from '@nocobase/plugin-workflow';
import { createMockServer, type MockServer } from '@nocobase/test';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { COLLECTIONS, PLUGIN_NAME } from '../../shared/constants';
import RclonePlugin from '../plugin';
import type { RcloneTransferInstruction } from '../workflow/RcloneTransferInstruction';

let directory: string;
let app: MockServer;
let ds2: SequelizeDataSource;
let workflow: WorkflowPlugin;
const transfer = {
  connectionId: 1,
  operation: 'sync/copy',
  srcFs: 'a:',
  dstFs: 'b:',
  status: 'completed',
  triggerSource: 'workflow',
};

beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rclone-handoff-'));
  app = await createMockServer({
    skipSupervisor: true,
    acl: false,
    database: { dialect: 'sqlite', storage: path.join(directory, 'main.sqlite') },
    plugins: [
      'field-sort',
      'system-settings',
      'users',
      'auth',
      'acl',
      'data-source-manager',
      'data-source-main',
      'error-handler',
      'workflow',
      'workflow-delay',
      [RclonePlugin, { name: PLUGIN_NAME, packageName: PLUGIN_NAME, enabled: true, isPreset: true }],
    ],
    beforeInstall: async (server) => {
      server.db.collection({ name: 'effects', fields: [{ type: 'string', name: 'tag' }] });
    },
  });
  (app.pm.get(PLUGIN_NAME) as RclonePlugin).reconciler.stop();
  workflow = app.pm.get('workflow') as WorkflowPlugin;
  ds2 = new SequelizeDataSource({
    name: 'ds2',
    collectionManager: { dialect: 'sqlite', storage: path.join(directory, 'ds2.sqlite') },
  });
  ds2.collectionManager.db.collection({ name: 'effects', fields: [{ type: 'string', name: 'tag' }] });
  await ds2.collectionManager.sync();
  await app.dataSourceManager.add(ds2);
}, 45_000);

afterAll(async () => {
  await app?.stop();
  await ds2?.collectionManager.db.close();
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});

async function preparePath(steps: Array<{ type: string; config?: Record<string, unknown> }>) {
  const wf = (await app.db
    .getRepository('workflows')
    .create({ values: { type: 'collection', config: { collection: 'users', mode: 1 } } })) as WorkflowModel;
  const root = await wf.createNode({ type: 'rclone-transfer', config: {} });
  const nodes = [root];
  let previous = root;
  for (const step of steps) {
    const next = await wf.createNode({ ...step, upstreamId: previous.id });
    await previous.update({ downstreamId: next.id });
    nodes.push(next);
    previous = next;
  }
  const id = () => workflow.snowflake.getUniqueID().toString();
  const exec = await app.db.getRepository('executions').create({
    values: {
      id: id(),
      workflowId: wf.id,
      key: wf.key,
      dispatched: true,
      status: EXECUTION_STATUS.STARTED,
      context: {},
    },
  });
  const task = await app.db
    .getRepository(COLLECTIONS.tasks)
    .create({ values: { ...transfer, workflowId: wf.id, executionId: exec.id } });
  const job = await app.db.getRepository('jobs').create({
    values: {
      id: id(),
      executionId: exec.id,
      nodeId: root.id,
      nodeKey: root.key,
      status: JOB_STATUS.RESOLVED,
      result: { taskId: task.id, success: true, resumeToken: 'resume' },
    },
  });
  await task.update({ workflowJobId: String(job.id), resumePending: true, resumeToken: 'resume' });
  async function resume() {
    const execution = (await app.db
      .getRepository('executions')
      .findOne({ filterByTk: exec.id, appends: ['workflow', 'workflow.nodes', 'jobs'] })) as ExecutionModel;
    const anchor = execution.jobs?.find((row) => String(row.id) === String(job.id));
    if (!anchor) throw new Error('Rclone job missing from fixture');
    anchor.execution = execution;
    await workflow.createProcessor(execution).resume(anchor);
  }
  return { exec, task, job, nodes, resume };
}

it.each([false, true])(
  'fails the mutation before writing when the ledger cannot be created or written (provisioned=%s)',
  async (provisioned) => {
    const db = ds2.collectionManager.db;
    if (provisioned) {
      await db.sequelize.query(
        'CREATE TABLE _rclone_wf_tx_ledger (step_key TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at BIGINT NOT NULL)',
      );
    }
    const fixture = await preparePath([
      { type: 'create', config: { collection: 'ds2:effects', params: { values: { tag: 'denied' } } } },
    ]);
    await db.sequelize.query('PRAGMA query_only = ON');
    try {
      await fixture.resume();
      const failed = await app.db
        .getRepository('jobs')
        .findOne({ filter: { executionId: fixture.exec.id, nodeId: fixture.nodes[1].id } });
      expect(failed?.get('status')).toBe(JOB_STATUS.ERROR);
      expect(failed?.get('result').message).toContain('_rclone_wf_tx_ledger');
      expect(failed?.get('result').message).toContain('ds2');
      expect((await fixture.exec.reload()).get('status')).toBe(EXECUTION_STATUS.ERROR);
      expect((await fixture.task.reload()).get('resumePending')).toBe(false);
      expect(await db.getRepository('effects').count()).toBe(0);
    } finally {
      await db.sequelize.query('PRAGMA query_only = OFF');
      await db.sequelize.query('DROP TABLE IF EXISTS _rclone_wf_tx_ledger');
    }
  },
);

it('can query a read-only secondary data source without a ledger', async () => {
  const db = ds2.collectionManager.db;
  const fixture = await preparePath([{ type: 'query', config: { collection: 'ds2:effects', multiple: true } }]);
  await db.sequelize.query('PRAGMA query_only = ON');
  try {
    await fixture.resume();
    expect((await fixture.exec.reload()).get('status')).toBe(EXECUTION_STATUS.RESOLVED);
    const [rows] = await db.sequelize.query("SELECT name FROM sqlite_master WHERE name = '_rclone_wf_tx_ledger'");
    expect(rows).toHaveLength(0);
  } finally {
    await db.sequelize.query('PRAGMA query_only = OFF');
  }
});

it('continues when this worker has resolved its own pre-saved Rclone job', async () => {
  const fixture = await preparePath([
    { type: 'rclone-transfer', config: { failOnError: false } },
    { type: 'create', config: { collection: 'effects', params: { values: { tag: 'local-resolution' } } } },
  ]);
  const instruction = workflow.instructions.get('rclone-transfer') as RcloneTransferInstruction;
  const hook = vi.spyOn(instruction, 'run').mockImplementationOnce(async (node, prev, processor) => {
    const pending = processor.saveJob({
      nodeId: node.id,
      nodeKey: node.key,
      upstreamId: prev.id,
      status: JOB_STATUS.PENDING,
    });
    await pending.save();
    pending.set({ status: JOB_STATUS.RESOLVED, result: { success: false } });
    return pending;
  });
  try {
    await fixture.resume();
    expect((await fixture.exec.reload()).get('status')).toBe(EXECUTION_STATUS.RESOLVED);
    expect(await app.db.getRepository('effects').count({ filter: { tag: 'local-resolution' } })).toBe(1);
  } finally {
    hook.mockRestore();
  }
});

it.each(['parked', 'finished', 'saved Create'])(
  'discards the stale second Rclone job after another worker has %s',
  async (state) => {
    const secondTask = await app.db.getRepository(COLLECTIONS.tasks).create({ values: transfer });
    const steps = [
      { type: 'rclone-transfer', config: { taskId: secondTask.id } },
      { type: 'create', config: { collection: 'effects', params: { values: { tag: state } } } },
      ...(state !== 'finished'
        ? [{ type: 'delay', config: { duration: 120, unit: 1000, endStatus: JOB_STATUS.RESOLVED } }]
        : []),
    ];
    const fixture = await preparePath(steps);
    const instruction = workflow.instructions.get('rclone-transfer') as RcloneTransferInstruction;
    const run = instruction.run.bind(instruction);
    // A has released its execution lock. Drive B to its commit before allowing A to return from Rclone2.
    const hook = vi.spyOn(instruction, 'run').mockImplementationOnce(async (...args) => {
      if (state === 'saved Create') {
        // Model a worker that committed the prefix and stopped before recording Delay.
        await app.db.sequelize.transaction(async (transaction) => {
          await app.db.getRepository('effects').create({ values: { tag: state }, transaction });
          let upstreamId = fixture.job.id;
          for (const node of fixture.nodes.slice(1, 3)) {
            const row = await app.db.getRepository('jobs').create({
              transaction,
              values: {
                executionId: fixture.exec.id,
                id: workflow.snowflake.getUniqueID().toString(),
                upstreamId,
                nodeId: node.id,
                nodeKey: node.key,
                status: JOB_STATUS.RESOLVED,
              },
            });
            upstreamId = row.id;
          }
        });
      } else {
        await fixture.resume();
      }
      return run(...args);
    });
    try {
      await fixture.resume();
      expect(hook).toHaveBeenCalledTimes(state === 'saved Create' ? 1 : 2);
      expect(await app.db.getRepository('effects').count({ filter: { tag: state } })).toBe(1);
      const jobs = (await app.db
        .getRepository('jobs')
        .find({ filter: { executionId: fixture.exec.id } })) as JobModel[];
      for (const node of fixture.nodes)
        expect(jobs.filter((j) => String(j.nodeId) === String(node.id))).toHaveLength(1);
      expect((await fixture.exec.reload()).get('status')).toBe(
        state === 'finished' ? EXECUTION_STATUS.RESOLVED : EXECUTION_STATUS.STARTED,
      );
    } finally {
      hook.mockRestore();
    }
  },
);
