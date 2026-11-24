// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { SequelizeDataSource } from '@nocobase/data-source-manager';
import type { Model } from '@nocobase/database';
import {
  EXECUTION_STATUS,
  JOB_STATUS,
  type FlowNodeModel,
  type JobModel,
  type Processor,
} from '@nocobase/plugin-workflow';
import { createMockServer, sleep, type MockServer } from '@nocobase/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COLLECTIONS, PLUGIN_NAME } from '../../shared/constants';
import PluginRcloneManagerServer from '../plugin';
import { RcloneRcClient } from '../services/rclone-rc-client';
import { RcloneJobReconciler } from '../workflow/RcloneJobReconciler';
import { RcloneTransferInstruction } from '../workflow/RcloneTransferInstruction';

const activeServers: http.Server[] = [];

async function startMockRcd(
  handler: (req: http.IncomingMessage, body: Record<string, unknown>, res: http.ServerResponse) => void,
): Promise<string> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      let parsed: Record<string, unknown> = {};
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw) {
        try {
          parsed = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          parsed = {};
        }
      }
      handler(req, parsed, res);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  activeServers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  while (activeServers.length > 0) {
    const srv = activeServers.pop();
    if (srv) {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  }
});

describe('RcloneRcClient & Workflow Transfer Reconciler', () => {
  it('communicates with rclone rcd, redacts credentials on failure, and streams --rc-serve files', async () => {
    const baseUrl = await startMockRcd((req, body, res) => {
      if (req.headers.authorization !== `Basic ${Buffer.from('rcadmin:secret123').toString('base64')}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized for secret123' }));
        return;
      }
      if (req.url === '/rc/noopauth') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      if (req.url === '/core/version') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ version: 'v1.68.2', os: 'linux', arch: 'amd64' }));
        return;
      }
      if (req.url === '/job/status' && body.jobid === 99) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 99,
            executeId: 'exec-v1',
            group: 'nb-task-99',
            finished: true,
            success: false,
            error: 'source directory missing',
          }),
        );
        return;
      }
      if (req.method === 'GET' && req.url?.startsWith('/[s3%3Abucket]/hello.txt')) {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': '11' });
        res.end('hello world');
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const badClient = new RcloneRcClient({
      baseUrl,
      authType: 'basic',
      username: 'rcadmin',
      password: 'wrong-secret123',
    });
    await expect(badClient.testConnection()).rejects.not.toThrow(/wrong-secret123/);

    const client = new RcloneRcClient({
      baseUrl,
      authType: 'basic',
      username: 'rcadmin',
      password: 'secret123',
    });

    const ver = await client.testConnection();
    expect(ver.version).toBe('v1.68.2');

    await expect(client.getJobStatus(99)).rejects.toMatchObject({ status: 409 });
    const failedStatus = await client.getJobStatus(99, { executeId: 'exec-v1', group: 'nb-task-99' });
    expect(failedStatus).toMatchObject({ id: 99, finished: true, success: false, error: 'source directory missing' });

    const streamHandle = await client.openDownloadStream('s3:bucket', 'hello.txt', false);
    const chunks: Buffer[] = [];
    for await (const chunk of streamHandle.stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    expect(Buffer.concat(chunks).toString('utf8')).toBe('hello world');
    await streamHandle.cleanup();
  });

  it('blocks unauthorized local paths in Workflow and reconciles async jobs to workflow.resume()', async () => {
    let jobFinished = false;
    let lastDispatchedGroup = '';
    const dispatchedPayloads: Array<{ url: string; body: Record<string, unknown> }> = [];

    const baseUrl = await startMockRcd((req, body, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/config/listremotes') {
        res.end(JSON.stringify({ remotes: ['s3-src', 'gdrive-dst'] }));
        return;
      }
      if (req.url === '/config/dump') {
        res.end(JSON.stringify({ 's3-src': { type: 's3' }, 'gdrive-dst': { type: 'drive' } }));
        return;
      }
      if (req.url === '/sync/copy') {
        dispatchedPayloads.push({ url: req.url, body });
        lastDispatchedGroup = typeof body._group === 'string' ? body._group : '';
        res.end(JSON.stringify({ jobid: 77, executeId: 'exec-test-2' }));
        return;
      }
      if (req.url === '/core/stats') {
        res.end(JSON.stringify({ bytes: jobFinished ? 2048 : 1024, totalBytes: 2048, speed: 512, eta: 2 }));
        return;
      }
      if (req.url === '/job/status') {
        res.end(
          JSON.stringify({
            id: 77,
            executeId: 'exec-test-2',
            group: lastDispatchedGroup,
            finished: jobFinished,
            success: true,
            duration: 4.2,
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const client = new RcloneRcClient({ baseUrl, authType: 'none' });

    // In-memory mock task store + workflow job store
    const taskState: Record<string, unknown> = {
      id: 10,
      connectionId: 1,
      operation: 'sync/copy',
      srcFs: 's3-src:invoices',
      srcRemote: '2026',
      dstFs: 'gdrive-dst:backup',
      dstRemote: '2026',
      dryRun: true,
      localAuthorized: false,
      status: 'queued',
    };

    const taskModel = {
      get: (k: string) => taskState[k],
      update: vi.fn(async (patch: Record<string, unknown>) => {
        Object.assign(taskState, patch);
      }),
    };

    const wfJobState: Record<string, unknown> = {
      id: '9001',
      status: JOB_STATUS.PENDING,
      result: null,
      execution: { id: 501, workflowId: 301, status: EXECUTION_STATUS.STARTED },
    };
    const wfJobModel = {
      get id() {
        return wfJobState.id;
      },
      get status() {
        return wfJobState.status;
      },
      get result() {
        return wfJobState.result;
      },
      get execution() {
        return wfJobState.execution;
      },
      set: (patch: Record<string, unknown>) => Object.assign(wfJobState, patch),
      save: vi.fn().mockResolvedValue(undefined),
      getExecution: vi.fn(async () => wfJobState.execution),
    } as unknown as JobModel;

    const resumeSpy = vi.fn().mockResolvedValue(undefined);
    const kickSpy = vi.fn();

    const mockApp = {
      db: {
        getCollection: vi.fn((name: string) =>
          name === 'jobs' ? { model: { findAll: vi.fn().mockResolvedValue([wfJobModel]) } } : { model: {} },
        ),
        getRepository: vi.fn((name: string) => {
          if (name === 'rcloneTransferTasks') {
            return {
              findOne: vi.fn(async () => taskModel),
              find: vi.fn(async () => (taskState.status === 'running' ? [taskModel] : [])),
              create: vi.fn(),
            };
          }
          if (name === 'jobs') {
            return { findOne: vi.fn(async () => wfJobModel) };
          }
          return {};
        }),
      },
      pm: {
        get: vi.fn((name: string) => {
          if (name === 'workflow') return { app: mockApp, resume: resumeSpy };
          if (name === PLUGIN_NAME) {
            return {
              connectionManager: { getClient: vi.fn(async () => ({ model: {}, client })) },
              reconciler: { kick: kickSpy },
            };
          }
          return undefined;
        }),
      },
    };

    const workflowPlugin = { app: mockApp, resume: resumeSpy };
    const instruction = new RcloneTransferInstruction(workflowPlugin as never);

    // 1. Verify privilege escalation guard blocks unauthorized local path in standalone workflow node
    const blockedNode = {
      id: 1,
      key: 'node_local',
      config: {
        connectionId: 1,
        operation: 'sync/copy',
        srcFs: '/etc',
        dstFs: 'gdrive-dst:leak',
        allowLocalPaths: false,
        failOnError: true,
      },
    } as unknown as FlowNodeModel;

    const processor = {
      execution: { id: 501, workflowId: 301 },
      getParsedValue: (v: unknown) => v,
      saveJob: vi.fn((payload: Record<string, unknown>) => {
        Object.assign(wfJobState, payload);
        return wfJobModel;
      }),
    } as unknown as Processor;

    const blockedRes = await instruction.run(blockedNode, null as unknown as JobModel, processor);
    expect(blockedRes.status).toBe(JOB_STATUS.FAILED);
    expect(dispatchedPayloads).toHaveLength(0);

    // 2. Run authorized cloud-to-cloud Explorer task -> returns PENDING job immediately
    const explorerNode = {
      id: 2,
      key: 'node_transfer',
      config: { taskId: 10, failOnError: true },
    } as unknown as FlowNodeModel;

    const pendingJob = await instruction.run(explorerNode, null as unknown as JobModel, processor);
    expect(pendingJob.status).toBe(JOB_STATUS.PENDING);
    expect(taskState.status).toBe('running');
    expect(taskState.rcloneJobId).toBe(77);
    expect(dispatchedPayloads[0]?.body).toMatchObject({
      srcFs: 's3-src:invoices/2026',
      dstFs: 'gdrive-dst:backup/2026',
      _async: true,
      _config: { DryRun: true },
    });

    // 3. Reconciler tick #1 while still running -> updates progress to 50%, does NOT resume yet
    const reconciler = new RcloneJobReconciler(
      mockApp as never,
      { getClient: vi.fn(async () => ({ model: {}, client })) } as never,
    );
    reconciler.start();
    await reconciler.reconcileOnce();
    expect(taskState.progress).toBe(50);
    expect(resumeSpy).not.toHaveBeenCalled();

    // 4. Reconciler tick #2 after rclone finishes -> marks task completed & calls workflow.resume(job) with RESOLVED
    jobFinished = true;
    await reconciler.reconcileOnce();
    reconciler.stop();

    expect(taskState.status).toBe('completed');
    expect(taskState.progress).toBe(100);
    expect(wfJobState.status).toBe(JOB_STATUS.RESOLVED);
    expect(wfJobState.result).toMatchObject({
      taskId: 10,
      rcloneJobId: 77,
      success: true,
      bytes: 2048,
      totalBytes: 2048,
    });
    expect(resumeSpy).toHaveBeenCalledTimes(1);
  });

  it('skips stopped tasks in Instruction, deduplicates HA resume via atomic claim, and rejects >4 GiB ZIP downloads', async () => {
    const postSpy = vi.fn();
    const baseUrl = await startMockRcd((req, body, res) => {
      postSpy(req.url, body);
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/operations/list') {
        res.end(
          JSON.stringify({
            list: [{ Path: 'huge/backup.tar', Name: 'backup.tar', Size: 5 * 1024 * 1024 * 1024, IsDir: false }],
          }),
        );
        return;
      }
      res.end('{}');
    });

    const client = new RcloneRcClient({ baseUrl, authType: 'none' });
    await expect(client.openDownloadStream('s3:bucket', 'huge', true)).rejects.toMatchObject({ status: 413 });

    const stoppedTask = {
      get: (k: string) =>
        ({
          id: 22,
          status: 'stopped',
          errorText: 'Stopped by user',
        })[k],
    };

    const jobsClaimState = { status: JOB_STATUS.PENDING };
    const taskClaimState = { status: 'running' };
    const wfJob = {
      id: '999',
      get status() {
        return jobsClaimState.status;
      },
      result: { taskId: 22, failOnError: true },
      execution: { id: 700, workflowId: 400, status: EXECUTION_STATUS.STARTED },
      set: vi.fn((patch: Record<string, unknown>) => Object.assign(jobsClaimState, patch)),
      save: vi.fn(),
    } as unknown as JobModel;

    const resumeSpy = vi.fn().mockResolvedValue(undefined);
    const taskModelUpdate = vi.fn(async (_vals: Record<string, unknown>, opts: { where: { status: string[] } }) => {
      if (opts.where.status.includes(taskClaimState.status)) {
        taskClaimState.status = 'completed';
        return [1];
      }
      return [0];
    });
    const jobModelUpdate = vi.fn(async (vals: Record<string, unknown>, opts: { where: { status: number } }) => {
      if (jobsClaimState.status === opts.where.status) {
        jobsClaimState.status = vals.status as number;
        return [1];
      }
      return [0];
    });

    const mockApp = {
      db: {
        getCollection: vi.fn((name: string) => {
          if (name === 'rcloneTransferTasks') return { model: { update: taskModelUpdate } };
          if (name === 'jobs') return { model: { update: jobModelUpdate } };
          return { model: {} };
        }),
        getRepository: vi.fn((name: string) => {
          if (name === 'rcloneTransferTasks') return { findOne: vi.fn(async () => stoppedTask) };
          if (name === 'jobs') return { findOne: vi.fn(async () => wfJob) };
          return {};
        }),
      },
      pm: { get: vi.fn() },
    };

    postSpy.mockClear();
    const instruction = new RcloneTransferInstruction({ app: mockApp, resume: resumeSpy } as never);
    const stoppedOutcome = await instruction.run(
      { id: 3, key: 'n3', config: { taskId: 22, failOnError: true } } as unknown as FlowNodeModel,
      null as unknown as JobModel,
      {
        execution: { id: 700, workflowId: 400 },
        getParsedValue: (v: unknown) => v,
        saveJob: vi.fn(),
      } as unknown as Processor,
    );
    expect(stoppedOutcome.status).toBe(JOB_STATUS.FAILED);
    expect(postSpy).not.toHaveBeenCalled();

    const reconciler = new RcloneJobReconciler(mockApp as never, {} as never);
    const runningTask = {
      get: (k: string) => ({ id: 22, workflowJobId: '999', startedAt: new Date().toISOString() })[k],
      set: vi.fn(),
    } as never;

    await Promise.all([
      reconciler.finalizeTaskAndWorkflowJob(
        runningTask,
        new Map([['999', wfJob]]),
        { app: mockApp, resume: resumeSpy } as never,
        { status: 'completed', success: true, bytes: 100, totalBytes: 100, duration: 1 },
      ),
      reconciler.finalizeTaskAndWorkflowJob(
        runningTask,
        new Map([['999', wfJob]]),
        { app: mockApp, resume: resumeSpy } as never,
        { status: 'completed', success: true, bytes: 100, totalBytes: 100, duration: 1 },
      ),
    ]);
    expect(resumeSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps running tasks alive across transient /job/status 502 errors and recovers orphaned PENDING workflow jobs', async () => {
    let statusCalls = 0;
    const baseUrl = await startMockRcd((req, _body, res) => {
      if (req.url === '/job/status') {
        statusCalls += 1;
        if (statusCalls === 1) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Bad Gateway' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 88,
            executeId: 'exec-test-4',
            group: 'nb-task-30-g',
            finished: true,
            success: true,
            duration: 2.5,
          }),
        );
        return;
      }
      if (req.url === '/core/stats') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ bytes: 512, totalBytes: 512, speed: 256 }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const client = new RcloneRcClient({ baseUrl, authType: 'none' });
    const taskState: Record<string, unknown> = {
      id: 30,
      connectionId: 1,
      rcloneJobId: 88,
      rcloneExecuteId: 'exec-test-4',
      rcloneGroup: 'nb-task-30-g',
      workflowJobId: '7777',
      status: 'running',
      bytes: 0,
      totalBytes: 512,
      startedAt: new Date().toISOString(),
    };
    const taskModel = {
      get: (k: string) => taskState[k],
      update: vi.fn(async (patch: Record<string, unknown>) => {
        Object.assign(taskState, patch);
      }),
    };

    // Simulate Processor.exit() NOT having flushed job '7777' to the DB yet during tick #2, then appearing before tick #3
    let jobFlushedToDb = false;
    const wfJobState: Record<string, unknown> = {
      id: '7777',
      status: JOB_STATUS.PENDING,
      result: { taskId: 30, connectionId: 1, rcloneJobId: 88, failOnError: true },
      execution: { id: 801, workflowId: 401, status: EXECUTION_STATUS.STARTED },
    };
    const wfJobModel = {
      get id() {
        return wfJobState.id;
      },
      get status() {
        return wfJobState.status;
      },
      get result() {
        return wfJobState.result;
      },
      get execution() {
        return wfJobState.execution;
      },
      set: (patch: Record<string, unknown>) => Object.assign(wfJobState, patch),
      save: vi.fn().mockResolvedValue(undefined),
      getExecution: vi.fn(async () => wfJobState.execution),
    } as unknown as JobModel;

    const resumeSpy = vi.fn().mockResolvedValue(undefined);
    const mockApp: Record<string, unknown> = {
      logger: { warn: vi.fn() },
      db: {
        getCollection: vi.fn((name: string) =>
          name === 'jobs'
            ? { model: { findAll: vi.fn(async () => (jobFlushedToDb ? [wfJobModel] : [])) } }
            : { model: {} },
        ),
        getRepository: vi.fn((name: string) => {
          if (name === 'rcloneTransferTasks') {
            return {
              find: vi.fn(async () => (taskState.status === 'running' ? [taskModel] : [])),
              findOne: vi.fn(async () => taskModel),
            };
          }
          if (name === 'jobs') {
            return { findOne: vi.fn(async () => (jobFlushedToDb ? wfJobModel : null)) };
          }
          return {};
        }),
      },
      pm: {
        get: vi.fn((name: string) => (name === 'workflow' ? { app: mockApp, resume: resumeSpy } : undefined)),
      },
    };

    const reconciler = new RcloneJobReconciler(
      mockApp as never,
      { getClient: vi.fn(async () => ({ model: {}, client })) } as never,
    );
    reconciler.start();

    // Tick 1: transient 502 error on /job/status -> task must remain running, not failed
    await reconciler.reconcileOnce();
    expect(taskState.status).toBe('running');
    expect(resumeSpy).not.toHaveBeenCalled();

    // Tick 2: job finishes before Processor.exit() inserts wfJob -> task completes, wfJob not resumed yet
    await reconciler.reconcileOnce();
    expect(taskState.status).toBe('completed');
    expect(resumeSpy).not.toHaveBeenCalled();

    // Tick 3: Processor.exit() has now flushed wfJob '7777' as PENDING while runningTasks is empty -> orphan recovery resumes it
    jobFlushedToDb = true;
    await reconciler.reconcileOnce();
    reconciler.stop();

    expect(wfJobState.status).toBe(JOB_STATUS.RESOLVED);
    expect(wfJobState.result).toMatchObject({ taskId: 30, success: true, bytes: 512, totalBytes: 512 });
    expect(resumeSpy).toHaveBeenCalledTimes(1);
  });

  it('blocks parameter-override connection strings in RcloneTransferInstruction when allowLocalPaths is false', async () => {
    const postAsyncSpy = vi.fn();
    const mockApp = {
      db: { getRepository: vi.fn() },
      pm: {
        get: vi.fn((name: string) =>
          name === PLUGIN_NAME
            ? {
                connectionManager: {
                  getClient: vi.fn(async () => ({
                    model: {},
                    client: {
                      isFsLocal: vi.fn(async () => false),
                      postAsync: postAsyncSpy,
                    },
                  })),
                },
                reconciler: { kick: vi.fn() },
              }
            : undefined,
        ),
      },
    };

    const instruction = new RcloneTransferInstruction({ app: mockApp, resume: vi.fn() } as never);
    const outcome = await instruction.run(
      {
        id: 9,
        key: 'node_override',
        config: {
          connectionId: 1,
          operation: 'sync/copy',
          srcFs: 'corp-sftp,key_file=/etc/ssh/id_rsa,host=attacker.com:',
          dstFs: 'gdrive:exfil',
          allowLocalPaths: false,
          failOnError: true,
        },
      } as unknown as FlowNodeModel,
      null as unknown as JobModel,
      {
        execution: { id: 901, workflowId: 501 },
        getParsedValue: (v: unknown) => v,
        saveJob: vi.fn(),
      } as unknown as Processor,
    );

    expect(outcome.status).toBe(JOB_STATUS.FAILED);
    expect(String((outcome.result as { error?: string }).error)).toMatch(/connection strings and parameter overrides/i);
    expect(postAsyncSpy).not.toHaveBeenCalled();
  });

  it('reconciles connections concurrently, backfills missing rcloneJobId from orphan wfJob, and fails corrupted tasks', async () => {
    const healthyUrl = await startMockRcd((req, _body, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/job/status') {
        res.end(JSON.stringify({ id: 55, executeId: 'exec-healthy', finished: true, success: true, duration: 1.5 }));
        return;
      }
      if (req.url === '/core/stats') {
        res.end(JSON.stringify({ bytes: 100, totalBytes: 100, speed: 100 }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const healthyClient = new RcloneRcClient({ baseUrl: healthyUrl, authType: 'none' });

    // Task A: on healthy connection 1 -> finishes even while connection 2 fails getClient
    const taskAState: Record<string, unknown> = {
      id: 101,
      connectionId: 1,
      rcloneJobId: 55,
      rcloneExecuteId: 'exec-healthy',
      workflowJobId: 'wf-101',
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    // Task B: on failing connection 2 -> stays running without blocking connection 1
    const taskBState: Record<string, unknown> = {
      id: 102,
      connectionId: 2,
      rcloneJobId: 66,
      rcloneExecuteId: 'exec-healthy',
      workflowJobId: 'wf-102',
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    // Task C: missing rcloneJobId on task row, but orphan wfJob has rcloneJobId=55 -> backfilled
    const taskCState: Record<string, unknown> = {
      id: 103,
      connectionId: 1,
      rcloneJobId: null,
      workflowJobId: 'wf-103',
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    // Task D: missing rcloneJobId on BOTH task row and orphan wfJob -> finalized as failed (no infinite loop)
    const taskDState: Record<string, unknown> = {
      id: 104,
      connectionId: 1,
      rcloneJobId: null,
      workflowJobId: 'wf-104',
      status: 'running',
      startedAt: new Date().toISOString(),
    };

    const makeTaskModel = (state: Record<string, unknown>) => ({
      get: (k: string) => state[k],
      update: vi.fn(async (patch: Record<string, unknown>) => {
        Object.assign(state, patch);
      }),
    });
    const taskModels: Record<number, ReturnType<typeof makeTaskModel>> = {
      101: makeTaskModel(taskAState),
      102: makeTaskModel(taskBState),
      103: makeTaskModel(taskCState),
      104: makeTaskModel(taskDState),
    };

    const makeWfJob = (id: string, result: Record<string, unknown>) => {
      const state: Record<string, unknown> = {
        id,
        status: JOB_STATUS.PENDING,
        result,
        execution: { id: 900, workflowId: 500, status: EXECUTION_STATUS.STARTED },
      };
      return {
        state,
        model: {
          get id() {
            return state.id;
          },
          get status() {
            return state.status;
          },
          get result() {
            return state.result;
          },
          get execution() {
            return state.execution;
          },
          set: (patch: Record<string, unknown>) => Object.assign(state, patch),
          save: vi.fn().mockResolvedValue(undefined),
          getExecution: vi.fn(async () => state.execution),
        } as unknown as JobModel,
      };
    };

    const wfA = makeWfJob('wf-101', {
      taskId: 101,
      rcloneJobId: 55,
      rcloneExecuteId: 'exec-healthy',
      failOnError: true,
    });
    const wfB = makeWfJob('wf-102', {
      taskId: 102,
      rcloneJobId: 66,
      rcloneExecuteId: 'exec-healthy',
      failOnError: true,
    });
    const wfC = makeWfJob('wf-103', {
      taskId: 103,
      rcloneJobId: 55,
      rcloneExecuteId: 'exec-healthy',
      failOnError: true,
    });
    const wfD = makeWfJob('wf-104', { taskId: 104, failOnError: true });
    const allWfJobs = [wfA, wfB, wfC, wfD];

    const resumeSpy = vi.fn().mockResolvedValue(undefined);
    const mockApp: Record<string, unknown> = {
      logger: { warn: vi.fn() },
      db: {
        getCollection: vi.fn((name: string) =>
          name === 'jobs'
            ? {
                model: {
                  findAll: vi.fn(async () =>
                    allWfJobs.filter((j) => j.state.status === JOB_STATUS.PENDING).map((j) => j.model),
                  ),
                },
              }
            : { model: {} },
        ),
        getRepository: vi.fn((name: string) => {
          if (name === 'rcloneTransferTasks') {
            return {
              find: vi.fn(async () => Object.values(taskModels).filter((m) => m.get('status') === 'running')),
              findOne: vi.fn(async ({ filterByTk }: { filterByTk: number }) => taskModels[filterByTk] ?? null),
            };
          }
          if (name === 'jobs') {
            return {
              findOne: vi.fn(async ({ filterByTk }: { filterByTk: string }) => {
                const match = allWfJobs.find((j) => j.state.id === filterByTk);
                return match?.model ?? null;
              }),
            };
          }
          return {};
        }),
      },
      pm: {
        get: vi.fn((name: string) => (name === 'workflow' ? { app: mockApp, resume: resumeSpy } : undefined)),
      },
    };

    const reconciler = new RcloneJobReconciler(
      mockApp as never,
      {
        getClient: vi.fn(async (connId: number) => {
          if (connId === 2) {
            throw new Error('Connection 2 unreachable');
          }
          return { model: {}, client: healthyClient };
        }),
      } as never,
    );

    reconciler.start();
    await reconciler.reconcileOnce();
    reconciler.stop();

    // Task A completed concurrently despite connection 2 failure
    expect(taskAState.status).toBe('completed');
    expect(wfA.state.status).toBe(JOB_STATUS.RESOLVED);
    // Task B on failing connection 2 stayed running (transient failure)
    expect(taskBState.status).toBe('running');
    expect(wfB.state.status).toBe(JOB_STATUS.PENDING);
    // Task C backfilled rcloneJobId=55 from orphan wfJob so next tick can reconcile it
    expect(taskCState.rcloneJobId).toBe(55);
    expect(taskCState.status).toBe('running');
    // Task D had no rcloneJobId anywhere -> finalized as failed instead of spinning forever
    expect(taskDState.status).toBe('failed');
    expect(wfD.state.status).toBe(JOB_STATUS.FAILED);
    expect(resumeSpy).toHaveBeenCalledTimes(2);
  });

  it('detects local wrapper remotes (crypt/combine), rethrows non-404 readRawConfigFile errors, passes createEmptySrcDirs in moveDirSync, and handles task claim races', async () => {
    let configStatus = 404;
    let lastMoveBody: Record<string, unknown> | null = null;
    const baseUrl = await startMockRcd((req, body, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/config/listremotes') {
        res.end(JSON.stringify({ remotes: ['s3-cloud', 'vault-crypt', 'merged-combine'] }));
        return;
      }
      if (req.url === '/config/dump') {
        res.end(
          JSON.stringify({
            's3-cloud': { type: 's3' },
            'vault-crypt': { type: 'crypt', remote: '/var/backups' },
            'merged-combine': { type: 'combine', upstreams: 'cloud=s3-cloud:b local=/mnt/data' },
          }),
        );
        return;
      }
      if (req.url === '/operations/fsinfo') {
        // Rclone crypt/combine report IsLocal=false even when wrapping a host local path
        res.end(JSON.stringify({ Name: 'wrapper', Features: { IsLocal: false } }));
        return;
      }
      if (req.url === '/sync/move') {
        lastMoveBody = body;
        res.end('{}');
        return;
      }
      if (req.url === '/config/paths') {
        res.end(JSON.stringify({ config: '/config/rclone.conf' }));
        return;
      }
      if (req.method === 'GET') {
        res.writeHead(configStatus);
        res.end('fail');
        return;
      }
      if (req.url === '/operations/stat') {
        if (configStatus === 404) {
          res.end(JSON.stringify({ item: null }));
        } else {
          res.writeHead(502);
          res.end(JSON.stringify({ error: 'Upstream timeout' }));
        }
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const client = new RcloneRcClient({ baseUrl, authType: 'none' });

    // 1. crypt/combine remotes backed by local host paths are flagged isLocal=true
    const remotes = await client.inspectRemotes();
    expect(remotes.find((r) => r.name === 's3-cloud')?.isLocal).toBe(false);
    expect(remotes.find((r) => r.name === 'vault-crypt')?.isLocal).toBe(true);
    expect(remotes.find((r) => r.name === 'merged-combine')?.isLocal).toBe(true);
    expect(await client.isFsLocal('vault-crypt:')).toBe(true);
    expect(await client.isFsLocal('merged-combine:local')).toBe(true);
    expect(await client.isFsLocal('s3-cloud:bucket')).toBe(false);

    // 2. moveDirSync includes createEmptySrcDirs: true so empty directories are preserved
    await client.moveDirSync('s3-cloud:b/old', 's3-cloud:b/new');
    expect(lastMoveBody).toMatchObject({ createEmptySrcDirs: true, deleteEmptySrcDirs: true });

    // 3. readRawConfigFile returns empty string on 404, but rethrows non-404 errors (e.g. 502)
    configStatus = 404;
    await expect(client.readRawConfigFile()).resolves.toMatchObject({ content: '', configDisabled: false });
    configStatus = 502;
    await expect(client.readRawConfigFile()).rejects.toMatchObject({ status: 502 });

    // 4. RcloneTransferInstruction skips already-running task and stops rclone job if atomic claim loses race to stopJob
    const postAsyncSpy = vi.fn(async () => ({ jobid: 321 }));
    const stopJobSpy = vi.fn(async () => {});
    const runningTaskModel = {
      get: (k: string) => ({ id: 41, status: 'running' })[k],
    };
    const racedTaskState: Record<string, unknown> = {
      id: 42,
      connectionId: 1,
      operation: 'sync/copy',
      srcFs: 's3-cloud:a',
      srcRemote: '',
      dstFs: 's3-cloud:b',
      dstRemote: '',
      localAuthorized: false,
      status: 'queued',
    };
    const racedTaskModel = {
      get: (k: string) => racedTaskState[k],
      update: vi.fn(),
    };
    const savedJobState: Record<string, unknown> = { id: 'wf-42', status: JOB_STATUS.PENDING, result: {} };
    const savedJobMock = {
      get id() {
        return savedJobState.id;
      },
      get status() {
        return savedJobState.status;
      },
      get result() {
        return savedJobState.result;
      },
      set: (patch: Record<string, unknown>) => Object.assign(savedJobState, patch),
    } as unknown as JobModel;

    let findCount = 0;
    const mockApp = {
      db: {
        getCollection: vi.fn((name: string) =>
          name === 'rcloneTransferTasks'
            ? {
                model: {
                  // Simulate stopJob having changed status to 'stopped' before atomic claim runs
                  update: vi.fn(async () => {
                    racedTaskState.status = 'stopped';
                    racedTaskState.errorText = 'Stopped by user';
                    return [0];
                  }),
                },
              }
            : { model: {} },
        ),
        getRepository: vi.fn(() => ({
          findOne: vi.fn(async ({ filterByTk }: { filterByTk: number }) => {
            if (filterByTk === 41) return runningTaskModel;
            findCount += 1;
            return racedTaskModel;
          }),
        })),
      },
      pm: {
        get: vi.fn((name: string) =>
          name === PLUGIN_NAME
            ? {
                connectionManager: {
                  getClient: vi.fn(async () => ({
                    model: {},
                    client: {
                      isFsLocal: vi.fn(async () => false),
                      postAsync: postAsyncSpy,
                      stopJob: stopJobSpy,
                    },
                  })),
                },
                reconciler: { kick: vi.fn() },
              }
            : undefined,
        ),
      },
    };

    const instruction = new RcloneTransferInstruction({ app: mockApp, resume: vi.fn() } as never);
    const processor = {
      execution: { id: 910, workflowId: 510 },
      getParsedValue: (v: unknown) => v,
      saveJob: vi.fn((payload: Record<string, unknown>) => {
        Object.assign(savedJobState, payload);
        return savedJobMock;
      }),
    } as unknown as Processor;

    const alreadyRunningRes = await instruction.run(
      { id: 1, key: 'n1', config: { taskId: 41, failOnError: true } } as unknown as FlowNodeModel,
      null as unknown as JobModel,
      processor,
    );
    expect(alreadyRunningRes.status).toBe(JOB_STATUS.FAILED);
    expect(postAsyncSpy).not.toHaveBeenCalled();

    const racedRes = await instruction.run(
      { id: 2, key: 'n2', config: { taskId: 42, failOnError: true } } as unknown as FlowNodeModel,
      null as unknown as JobModel,
      processor,
    );
    expect(findCount).toBeGreaterThanOrEqual(2);
    // Claim happens BEFORE postAsync, so losing the claim race never launches a duplicate daemon transfer
    expect(postAsyncSpy).not.toHaveBeenCalled();
    expect(stopJobSpy).not.toHaveBeenCalled();
    expect(racedTaskState.status).toBe('stopped');
    expect(racedRes.status).toBe(JOB_STATUS.FAILED);
  });

  it('prevents concurrent workers from launching duplicate transfers, enforces executeId across daemon restarts, retries failed workflow.resume() queue publishes, and fails closed on metadata errors', async () => {
    let daemonExecuteId = 'exec-session-1';
    let stopEndpointHits = 0;
    let statsEndpointHits = 0;
    let metadataBroken = true;

    const baseUrl = await startMockRcd((req, body, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/config/listremotes') {
        if (metadataBroken) {
          res.writeHead(502);
          res.end(JSON.stringify({ error: 'daemon metadata unavailable' }));
          return;
        }
        res.end(JSON.stringify({ remotes: ['cloud-s3', 'env-mystery'] }));
        return;
      }
      if (req.url === '/config/dump') {
        if (metadataBroken) {
          res.writeHead(502);
          res.end(JSON.stringify({ error: 'daemon metadata unavailable' }));
          return;
        }
        // env-mystery has no dump entry (simulating RCLONE_CONFIG_ENV_MYSTERY_TYPE=local)
        res.end(JSON.stringify({ 'cloud-s3': { type: 's3' } }));
        return;
      }
      if (req.url === '/operations/fsinfo') {
        res.writeHead(502);
        res.end(JSON.stringify({ error: 'fsinfo timed out' }));
        return;
      }
      if (req.url === '/sync/move') {
        res.end(JSON.stringify({ jobid: 1, executeId: daemonExecuteId }));
        return;
      }
      if (req.url === '/job/list') {
        res.end(JSON.stringify({ executeId: daemonExecuteId, jobids: [1], runningIds: [], finishedIds: [1] }));
        return;
      }
      if (req.url === '/job/status' && body.jobid === 1) {
        // After restart, job #1 belongs to a completely different transfer that succeeded
        res.end(JSON.stringify({ id: 1, finished: true, success: true, duration: 1.0 }));
        return;
      }
      if (req.url === '/job/stop') {
        stopEndpointHits += 1;
        res.end('{}');
        return;
      }
      if (req.url === '/core/stats') {
        statsEndpointHits += 1;
        res.end(JSON.stringify({ bytes: 999_999, totalBytes: 999_999, speed: 50_000 }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const client = new RcloneRcClient({ baseUrl, authType: 'none' });

    // 1. Metadata failure -> classifyFsLocality returns 'unknown' and isFsLocal throws instead of returning false
    expect(await client.classifyFsLocality('host-local:data')).toBe('unknown');
    await expect(client.isFsLocal('host-local:data')).rejects.toMatchObject({ status: 502 });

    // Once config dump recovers, cloud-s3 is 'remote' while env-mystery with failing fsinfo stays 'unknown'
    metadataBroken = false;
    expect(await client.classifyFsLocality('cloud-s3:bucket')).toBe('remote');
    expect(await client.classifyFsLocality('env-mystery:secret')).toBe('unknown');
    await expect(client.isFsLocal('env-mystery:secret')).rejects.toMatchObject({ status: 502 });

    // 2. Concurrent Instruction.run workers racing on the same queued task only call postAsync ONCE
    const postAsyncSpy = vi.spyOn(client, 'postAsync');
    const sharedTaskState: Record<string, unknown> = {
      id: 500,
      connectionId: 1,
      operation: 'sync/move',
      srcFs: 'cloud-s3:src',
      srcRemote: '',
      dstFs: 'cloud-s3:dst',
      dstRemote: '',
      localAuthorized: false,
      status: 'queued',
      bytes: 128,
      totalBytes: 1024,
      resumePending: false,
    };
    const sharedTaskModel = {
      get: (k: string) => sharedTaskState[k],
      set: (patch: Record<string, unknown>) => Object.assign(sharedTaskState, patch),
      update: vi.fn(async (patch: Record<string, unknown>) => {
        Object.assign(sharedTaskState, patch);
      }),
    };

    const wfJobs = new Map<string, { state: Record<string, unknown>; model: JobModel }>();
    let jobSeq = 0;
    const makeProcessor = (execId: number) =>
      ({
        execution: { id: execId, workflowId: 700 },
        getParsedValue: (v: unknown) => v,
        saveJob: vi.fn((payload: Record<string, unknown>) => {
          const id = `wf-race-${++jobSeq}`;
          const state: Record<string, unknown> = {
            id,
            ...payload,
            execution: { id: execId, workflowId: 700, status: EXECUTION_STATUS.STARTED },
          };
          const model = {
            get id() {
              return state.id;
            },
            get status() {
              return state.status;
            },
            get result() {
              return state.result;
            },
            get execution() {
              return state.execution;
            },
            set: (patch: Record<string, unknown>) => Object.assign(state, patch),
            save: vi.fn().mockResolvedValue(undefined),
            getExecution: vi.fn(async () => state.execution),
          } as unknown as JobModel;
          wfJobs.set(id, { state, model });
          return model;
        }),
      }) as unknown as Processor;

    const taskModelUpdate = vi.fn(
      async (
        patch: Record<string, unknown>,
        opts: { where: { id: number; status: string | string[]; rcloneGroup?: string } },
      ) => {
        const expected = opts.where.status;
        const current = String(sharedTaskState.status ?? '');
        const matches = Array.isArray(expected) ? expected.includes(current) : current === expected;
        if (!matches) {
          return [0];
        }
        if (opts.where.rcloneGroup && sharedTaskState.rcloneGroup !== opts.where.rcloneGroup) {
          return [0];
        }
        Object.assign(sharedTaskState, patch);
        return [1];
      },
    );

    const jobModelUpdate = vi.fn(
      async (patch: Record<string, unknown>, opts: { where: { id: string; status: number } }) => {
        const entry = wfJobs.get(String(opts.where.id));
        if (!entry || entry.state.status !== opts.where.status) {
          return [0];
        }
        Object.assign(entry.state, patch);
        return [1];
      },
    );

    let failResumeOnce = true;
    const resumeSpy = vi.fn(async () => {
      if (failResumeOnce) {
        failResumeOnce = false;
        throw new Error('EventQueue publish connection refused');
      }
    });

    const mockApp: Record<string, unknown> = {
      logger: { warn: vi.fn() },
      db: {
        getCollection: vi.fn((name: string) => {
          if (name === 'rcloneTransferTasks') return { model: { update: taskModelUpdate } };
          if (name === 'jobs') {
            return {
              model: {
                update: jobModelUpdate,
                findAll: vi.fn(async () =>
                  [...wfJobs.values()].filter((j) => j.state.status === JOB_STATUS.PENDING).map((j) => j.model),
                ),
              },
            };
          }
          return { model: {} };
        }),
        getRepository: vi.fn((name: string) => {
          if (name === 'rcloneTransferTasks') {
            return {
              findOne: vi.fn(async () => sharedTaskModel),
              find: vi.fn(async ({ filter }: { filter?: Record<string, unknown> }) => {
                if (filter?.status) {
                  return sharedTaskState.status === filter.status ? [sharedTaskModel] : [];
                }
                if (filter?.resumePending) {
                  return sharedTaskState.resumePending ? [sharedTaskModel] : [];
                }
                return [];
              }),
            };
          }
          if (name === 'jobs') {
            return {
              findOne: vi.fn(async ({ filterByTk }: { filterByTk: string }) => wfJobs.get(filterByTk)?.model ?? null),
              count: vi.fn(async () => 0),
            };
          }
          return {};
        }),
      },
      pm: {
        get: vi.fn((name: string) => {
          if (name === 'workflow') return { app: mockApp, resume: resumeSpy };
          if (name === PLUGIN_NAME) {
            return {
              connectionManager: { getClient: vi.fn(async () => ({ model: {}, client })) },
              reconciler: { kick: vi.fn() },
            };
          }
          return undefined;
        }),
      },
    };

    const instruction = new RcloneTransferInstruction({ app: mockApp, resume: resumeSpy } as never);
    const node = { id: 11, key: 'node_move', config: { taskId: 500, failOnError: true } } as unknown as FlowNodeModel;

    const [out1, out2] = await Promise.all([
      instruction.run(node, null as unknown as JobModel, makeProcessor(1001)),
      instruction.run(node, null as unknown as JobModel, makeProcessor(1002)),
    ]);

    expect(postAsyncSpy).toHaveBeenCalledTimes(1);
    const statuses = [out1.status, out2.status].sort();
    expect(statuses).toEqual([JOB_STATUS.FAILED, JOB_STATUS.PENDING].sort());
    expect(sharedTaskState.status).toBe('running');
    expect(sharedTaskState.rcloneJobId).toBe(1);
    expect(sharedTaskState.rcloneExecuteId).toBe('exec-session-1');

    // 3. Simulate daemon restart -> new executeId with reused jobid=1
    daemonExecuteId = 'exec-session-2';
    await expect(client.stopJob(1, 'exec-session-1')).rejects.toMatchObject({ status: 409 });
    expect(stopEndpointHits).toBe(0);

    // 4. Reconciler tick #1: detects executeId mismatch -> marks task failed WITHOUT adopting new job #1's stats,
    //    settles wfJob to FAILED, and survives workflow.resume() queue failure by keeping resumePending=true!
    const reconciler = new RcloneJobReconciler(
      mockApp as never,
      { getClient: vi.fn(async () => ({ model: {}, client })) } as never,
    );
    reconciler.start();
    await reconciler.reconcileOnce();

    expect(statsEndpointHits).toBe(0);
    expect(sharedTaskState.status).toBe('unverified');
    expect(sharedTaskState.bytes).toBe(128);
    expect(sharedTaskState.resumePending).toBe(true);
    const winningWfJob = [...wfJobs.values()][0];
    expect(winningWfJob?.state.status).toBe(JOB_STATUS.FAILED);
    expect(resumeSpy).toHaveBeenCalledTimes(1);

    // 5. Reconciler tick #2: wfJob is already FAILED (no longer PENDING), but resumePending=true retries workflow.resume()
    await reconciler.reconcileOnce();
    reconciler.stop();

    expect(resumeSpy).toHaveBeenCalledTimes(2);
    expect(sharedTaskState.resumePending).toBe(false);
  });

  it('protects claimed transfers from pre-claim worker errors, recovers interrupted starting tasks via rcloneGroup, marks pre-upgrade tasks unverified, and stops via /job/stopgroup', async () => {
    let stopByIdHits = 0;
    let stopGroupHits = 0;
    let lastStoppedGroup = '';
    let statusPollsForLegacy = 0;
    let resolvePostAsyncGate!: () => void;
    const postAsyncGate = new Promise<void>((resolve) => {
      resolvePostAsyncGate = resolve;
    });
    let notifyPostAsyncEntered!: () => void;
    const postAsyncEntered = new Promise<void>((resolve) => {
      notifyPostAsyncEntered = resolve;
    });

    const baseUrl = await startMockRcd((req, body, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/config/listremotes') {
        res.end(JSON.stringify({ remotes: ['cloud-s3'] }));
        return;
      }
      if (req.url === '/config/dump') {
        res.end(JSON.stringify({ 'cloud-s3': { type: 's3' } }));
        return;
      }
      if (req.url === '/sync/copy') {
        notifyPostAsyncEntered();
        postAsyncGate
          .then(() => {
            res.end(JSON.stringify({ jobid: 801, executeId: 'exec-live' }));
            return undefined;
          })
          .catch(() => {});
        return;
      }
      if (req.url === '/job/stop') {
        stopByIdHits += 1;
        res.end('{}');
        return;
      }
      if (req.url === '/job/stopgroup') {
        stopGroupHits += 1;
        lastStoppedGroup = String(body.group ?? '');
        res.end('{}');
        return;
      }
      if (req.url === '/job/list') {
        res.end(JSON.stringify({ executeId: 'exec-live', jobids: [905], runningIds: [905], finishedIds: [] }));
        return;
      }
      if (req.url === '/job/status') {
        if (body.jobid === 777) {
          statusPollsForLegacy += 1;
        }
        if (body.jobid === 905) {
          res.end(
            JSON.stringify({
              id: 905,
              executeId: 'exec-live',
              group: 'nb-task-603-crash-recovery',
              finished: false,
              success: false,
            }),
          );
          return;
        }
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'job not found' }));
        return;
      }
      if (req.url === '/core/group-list') {
        res.end(JSON.stringify({ groups: ['nb-task-603-crash-recovery'] }));
        return;
      }
      if (req.url === '/core/stats') {
        res.end(JSON.stringify({ bytes: 2048, totalBytes: 8192, speed: 512, eta: 12 }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const client = new RcloneRcClient({ baseUrl, authType: 'none' });

    const tasksById: Record<number, Record<string, unknown>> = {
      601: {
        id: 601,
        connectionId: 1,
        operation: 'sync/copy',
        srcFs: 'cloud-s3:src',
        srcRemote: '',
        dstFs: 'cloud-s3:dst',
        dstRemote: '',
        localAuthorized: false,
        status: 'queued',
        resumePending: false,
      },
      602: {
        id: 602,
        connectionId: 1,
        operation: 'sync/copy',
        srcFs: 'cloud-s3:src',
        srcRemote: '',
        dstFs: 'cloud-s3:dst',
        dstRemote: '',
        localAuthorized: false,
        status: 'running',
        rcloneJobId: 777,
        rcloneExecuteId: null,
        rcloneGroup: null,
        workflowJobId: 'wf-602',
        startedAt: new Date().toISOString(),
        resumePending: false,
      },
      603: {
        id: 603,
        connectionId: 1,
        operation: 'sync/copy',
        srcFs: 'cloud-s3:src',
        srcRemote: '',
        dstFs: 'cloud-s3:dst',
        dstRemote: '',
        localAuthorized: false,
        status: 'starting',
        rcloneJobId: null,
        rcloneExecuteId: null,
        rcloneGroup: 'nb-task-603-crash-recovery',
        startedAt: new Date(Date.now() - 180_000).toISOString(),
        resumePending: false,
      },
      604: {
        id: 604,
        connectionId: 1,
        operation: 'sync/copy',
        srcFs: 'cloud-s3:src',
        srcRemote: '',
        dstFs: 'cloud-s3:dst',
        dstRemote: '',
        localAuthorized: false,
        status: 'starting',
        rcloneJobId: null,
        rcloneExecuteId: null,
        rcloneGroup: 'nb-task-604-never-dispatched',
        startedAt: new Date(Date.now() - 180_000).toISOString(),
        resumePending: false,
      },
    };

    const makeTaskModel = (id: number) => ({
      get: (k: string) => tasksById[id]?.[k],
      set: (patch: Record<string, unknown>) => Object.assign(tasksById[id], patch),
      update: vi.fn(async (patch: Record<string, unknown>) => {
        Object.assign(tasksById[id], patch);
      }),
    });

    const wfJobs = new Map<string, { state: Record<string, unknown>; model: JobModel }>();
    const registerWfJob = (id: string, execId: number, payload: Record<string, unknown>) => {
      const state: Record<string, unknown> = {
        id,
        ...payload,
        execution: { id: execId, workflowId: 710, status: EXECUTION_STATUS.STARTED },
      };
      const model = {
        get id() {
          return state.id;
        },
        get status() {
          return state.status;
        },
        get result() {
          return state.result;
        },
        get execution() {
          return state.execution;
        },
        set: (patch: Record<string, unknown>) => Object.assign(state, patch),
        save: vi.fn().mockResolvedValue(undefined),
        getExecution: vi.fn(async () => state.execution),
      } as unknown as JobModel;
      wfJobs.set(id, { state, model });
      return model;
    };
    registerWfJob('wf-602', 2002, {
      status: JOB_STATUS.PENDING,
      result: { taskId: 602, rcloneJobId: 777, failOnError: true },
    });

    let seq = 0;
    const makeProcessor = (execId: number) =>
      ({
        execution: { id: execId, workflowId: 710 },
        getParsedValue: (v: unknown) => v,
        saveJob: vi.fn((payload: Record<string, unknown>) => registerWfJob(`wf-dyn-${++seq}`, execId, payload)),
      }) as unknown as Processor;

    const taskModelUpdate = vi.fn(
      async (
        patch: Record<string, unknown>,
        opts: { where: { id: number; status: string | string[]; rcloneGroup?: string } },
      ) => {
        const target = tasksById[opts.where.id];
        if (!target) {
          return [0];
        }
        const current = String(target.status ?? '');
        const expected = opts.where.status;
        const statusMatches = Array.isArray(expected) ? expected.includes(current) : current === expected;
        if (!statusMatches) {
          return [0];
        }
        if (opts.where.rcloneGroup && target.rcloneGroup !== opts.where.rcloneGroup) {
          return [0];
        }
        Object.assign(target, patch);
        return [1];
      },
    );

    const jobModelUpdate = vi.fn(
      async (patch: Record<string, unknown>, opts: { where: { id: string; status: number } }) => {
        const entry = wfJobs.get(String(opts.where.id));
        if (!entry || entry.state.status !== opts.where.status) {
          return [0];
        }
        Object.assign(entry.state, patch);
        return [1];
      },
    );

    let getClientCallCount = 0;
    let rejectWorkerAGetClient!: (err: Error) => void;
    const workerAGetClientGate = new Promise<never>((_resolve, reject) => {
      rejectWorkerAGetClient = reject;
    });
    const getClientMock = vi.fn(async () => {
      getClientCallCount += 1;
      if (getClientCallCount === 1) {
        return workerAGetClientGate;
      }
      return { model: {}, client };
    });

    const resumeSpy = vi.fn().mockResolvedValue(undefined);
    const mockApp: Record<string, unknown> = {
      logger: { warn: vi.fn() },
      db: {
        getCollection: vi.fn((name: string) => {
          if (name === 'rcloneTransferTasks') return { model: { update: taskModelUpdate } };
          if (name === 'jobs') {
            return {
              model: {
                update: jobModelUpdate,
                findAll: vi.fn(async () =>
                  [...wfJobs.values()].filter((j) => j.state.status === JOB_STATUS.PENDING).map((j) => j.model),
                ),
              },
            };
          }
          return { model: {} };
        }),
        getRepository: vi.fn((name: string) => {
          if (name === 'rcloneTransferTasks') {
            return {
              findOne: vi.fn(async ({ filterByTk }: { filterByTk: number }) =>
                tasksById[filterByTk] ? makeTaskModel(filterByTk) : null,
              ),
              find: vi.fn(async ({ filter }: { filter?: Record<string, unknown> }) => {
                if (filter?.status) {
                  return Object.keys(tasksById)
                    .map(Number)
                    .filter((id) => tasksById[id].status === filter.status)
                    .map((id) => makeTaskModel(id));
                }
                if (filter?.resumePending) {
                  return Object.keys(tasksById)
                    .map(Number)
                    .filter((id) => Boolean(tasksById[id].resumePending))
                    .map((id) => makeTaskModel(id));
                }
                return [];
              }),
            };
          }
          if (name === 'jobs') {
            return {
              findOne: vi.fn(async ({ filterByTk }: { filterByTk: string }) => wfJobs.get(filterByTk)?.model ?? null),
              count: vi.fn(async () => 0),
            };
          }
          return {};
        }),
      },
      pm: {
        get: vi.fn((name: string) => {
          if (name === 'workflow') return { app: mockApp, resume: resumeSpy };
          if (name === PLUGIN_NAME) {
            return {
              connectionManager: { getClient: getClientMock },
              reconciler: { kick: vi.fn() },
            };
          }
          return undefined;
        }),
      },
    };

    // 1. Finding #1: Both Worker A and Worker B read task #601 while queued; Worker A stalls in getClient while
    //    Worker B claims queued -> starting and sends postAsync; then Worker A's getClient rejects into catch().
    //    Worker A must NOT overwrite task #601 from starting -> failed or cause Worker B to stop its own transfer!
    const instruction = new RcloneTransferInstruction({ app: mockApp, resume: resumeSpy } as never);
    const node601 = { id: 21, key: 'n601', config: { taskId: 601, failOnError: true } } as unknown as FlowNodeModel;

    const workerAPromise = instruction.run(node601, null as unknown as JobModel, makeProcessor(2000));
    const workerBPromise = instruction.run(node601, null as unknown as JobModel, makeProcessor(2001));
    await postAsyncEntered;
    expect(tasksById[601].status).toBe('starting');

    rejectWorkerAGetClient(new Error('Transient DB error reading rcloneConnection'));
    const outA = await workerAPromise;
    expect(outA.status).toBe(JOB_STATUS.FAILED);
    expect(tasksById[601].status).toBe('starting');

    resolvePostAsyncGate();
    const outB = await workerBPromise;
    expect(outB.status).toBe(JOB_STATUS.PENDING);
    expect(tasksById[601].status).toBe('running');
    expect(tasksById[601].rcloneJobId).toBe(801);
    expect(stopByIdHits).toBe(0);
    expect(stopGroupHits).toBe(0);

    // 2. Finding #4 (part A): Stopping a new task stops atomically by rcloneGroup via /job/stopgroup (never /job/stop)
    const assignedGroup = String(tasksById[601].rcloneGroup ?? '');
    expect(assignedGroup).toMatch(/^nb-task-601-/);
    await client.stopJob(801, { executeId: 'exec-live', group: assignedGroup });
    expect(stopGroupHits).toBe(1);
    expect(lastStoppedGroup).toBe(assignedGroup);
    expect(stopByIdHits).toBe(0);
    // Pause task #601 so reconciler test below focuses on #602, #603, #604
    tasksById[601].status = 'stopped';

    // 3. Findings #4 (part B) & #5:
    //    - Pre-upgrade task #602 (rcloneExecuteId=null, rcloneGroup=null) transitions to 'unverified' without polling /job/status
    //    - Interrupted starting task #603 (>120s old, active job #905 on daemon matching rcloneGroup) promotes to 'running'
    //    - Expired starting task #604 (>120s old, absent from daemon) transitions to 'failed'
    const reconciler = new RcloneJobReconciler(mockApp as never, { getClient: getClientMock } as never);
    reconciler.start();
    await reconciler.reconcileOnce();
    reconciler.stop();

    expect(statusPollsForLegacy).toBe(0);
    expect(tasksById[602].status).toBe('unverified');
    expect(wfJobs.get('wf-602')?.state.status).toBe(JOB_STATUS.FAILED);

    expect(tasksById[603].status).toBe('running');
    expect(tasksById[603].rcloneJobId).toBe(905);
    expect(tasksById[603].rcloneExecuteId).toBe('exec-live');

    expect(tasksById[604].status).toBe('unverified');
  });

  it('deduplicates concurrent reconcilers retrying resumePending=true and keeps composite combine remotes unknown without config/dump', async () => {
    // 1. Finding #6: Env-configured combine remote missing from /config/dump reports Features.IsLocal=false in fsinfo
    //    even when combining a cloud remote with a local host directory. Must stay 'unknown' (denied), never 'remote'!
    const baseUrl = await startMockRcd((req, body, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/config/listremotes') {
        res.end(JSON.stringify({ remotes: ['env-combine', 'env-s3'] }));
        return;
      }
      if (req.url === '/config/dump') {
        res.end(JSON.stringify({}));
        return;
      }
      if (req.url === '/operations/fsinfo') {
        const fsTarget = String(body.fs ?? '');
        if (fsTarget.startsWith('env-combine:')) {
          res.end(
            JSON.stringify({
              Name: 'env-combine',
              Root: '',
              String: "combine root ''",
              Features: { IsLocal: false },
            }),
          );
          return;
        }
        res.end(
          JSON.stringify({
            Name: 'env-s3',
            Root: 'bucket',
            String: 'S3 bucket bucket',
            Features: { IsLocal: false, BucketBased: true },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const client = new RcloneRcClient({ baseUrl, authType: 'none' });
    expect(await client.classifyFsLocality('env-combine:')).toBe('unknown');
    await expect(client.isFsLocal('env-combine:')).rejects.toMatchObject({ status: 502 });
    expect(await client.classifyFsLocality('env-s3:bucket')).toBe('remote');
    expect(await client.isFsLocal('env-s3:bucket')).toBe(false);

    // 2. Finding #2: Two concurrent reconcilers picking up the same completed task with resumePending=true
    //    must acquire per-workflowJob lock, re-check resumePending, and call workflow.resume() ONCE!
    const taskState: Record<string, unknown> = {
      id: 701,
      connectionId: 1,
      status: 'completed',
      workflowJobId: 'wf-701',
      resumePending: true,
    };
    const makeTaskModel = () => ({
      get: (k: string) => taskState[k],
      set: (patch: Record<string, unknown>) => Object.assign(taskState, patch),
      update: vi.fn(async (patch: Record<string, unknown>) => {
        Object.assign(taskState, patch);
      }),
    });

    const wfJobState: Record<string, unknown> = {
      id: 'wf-701',
      status: JOB_STATUS.RESOLVED,
      result: { taskId: 701, success: true },
      execution: { id: 3001, workflowId: 901, status: EXECUTION_STATUS.STARTED },
    };
    const wfJobModel = {
      get id() {
        return wfJobState.id;
      },
      get status() {
        return wfJobState.status;
      },
      get result() {
        return wfJobState.result;
      },
      get execution() {
        return wfJobState.execution;
      },
      set: (patch: Record<string, unknown>) => Object.assign(wfJobState, patch),
      save: vi.fn().mockResolvedValue(undefined),
      getExecution: vi.fn(async () => wfJobState.execution),
    } as unknown as JobModel;

    const resumeSpy = vi.fn(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 15));
    });

    const mockApp: Record<string, unknown> = {
      logger: { warn: vi.fn() },
      db: {
        getCollection: vi.fn((name: string) =>
          name === 'jobs' ? { model: { findAll: vi.fn(async () => []) } } : { model: {} },
        ),
        getRepository: vi.fn((name: string) => {
          if (name === 'rcloneTransferTasks') {
            return {
              findOne: vi.fn(async () => makeTaskModel()),
              find: vi.fn(async ({ filter }: { filter?: Record<string, unknown> }) => {
                if (filter?.resumePending) {
                  return taskState.resumePending ? [makeTaskModel()] : [];
                }
                return [];
              }),
            };
          }
          if (name === 'jobs') {
            return {
              findOne: vi.fn(async () => wfJobModel),
              count: vi.fn(async () => {
                await new Promise<void>((resolve) => setTimeout(resolve, 20));
                return 0;
              }),
            };
          }
          return {};
        }),
      },
      pm: {
        get: vi.fn((name: string) => (name === 'workflow' ? { app: mockApp, resume: resumeSpy } : undefined)),
      },
    };

    const r1 = new RcloneJobReconciler(mockApp as never, {} as never);
    const r2 = new RcloneJobReconciler(mockApp as never, {} as never);
    r1.start();
    r2.start();
    await Promise.all([r1.reconcileOnce(), r2.reconcileOnce()]);
    r1.stop();
    r2.stop();

    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(taskState.resumePending).toBe(false);
  });

  it('handles slow postAsync recovery without self-stop, survives lost RC responses and pre-Processor crashes, locks orphan PENDING resume, and deduplicates redelivered resume messages', async () => {
    let stopHits = 0;
    let mode: 'slow-post-async' | 'drop-rc-response' = 'slow-post-async';
    let resolveSlowPostAsync!: () => void;
    const slowPostAsyncGate = new Promise<void>((resolve) => {
      resolveSlowPostAsync = resolve;
    });
    let notifyDaemonAccepted!: () => void;
    const daemonAccepted = new Promise<void>((resolve) => {
      notifyDaemonAccepted = resolve;
    });

    const daemonJobs = new Map<
      number,
      { id: number; group: string; finished: boolean; success: boolean; duration: number }
    >();
    let nextDaemonJobId = 950;

    const baseUrl = await startMockRcd((req, body, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/config/listremotes') {
        res.end(JSON.stringify({ remotes: ['cloud-s3'] }));
        return;
      }
      if (req.url === '/config/dump') {
        res.end(JSON.stringify({ 'cloud-s3': { type: 's3' } }));
        return;
      }
      if (req.url === '/sync/copy') {
        const jid = nextDaemonJobId++;
        const grp = String(body._group ?? '');
        daemonJobs.set(jid, { id: jid, group: grp, finished: false, success: false, duration: 0 });
        if (mode === 'slow-post-async') {
          notifyDaemonAccepted();
          slowPostAsyncGate
            .then(() => {
              res.end(JSON.stringify({ jobid: jid, executeId: 'exec-r3' }));
              return undefined;
            })
            .catch(() => {});
          return;
        }
        // Drop socket AFTER daemon accepted and started the async transfer under _group!
        req.socket.destroy();
        return;
      }
      if (req.url === '/job/stop' || req.url === '/job/stopgroup') {
        stopHits += 1;
        res.end('{}');
        return;
      }
      if (req.url === '/job/list') {
        const ids = [...daemonJobs.keys()];
        res.end(
          JSON.stringify({
            executeId: 'exec-r3',
            jobids: ids,
            runningIds: ids.filter((id) => !daemonJobs.get(id)?.finished),
            finishedIds: ids.filter((id) => daemonJobs.get(id)?.finished),
          }),
        );
        return;
      }
      if (req.url === '/job/status') {
        const entry = daemonJobs.get(Number(body.jobid));
        if (!entry) {
          res.end(JSON.stringify({ error: 'job not found' }));
          return;
        }
        res.end(
          JSON.stringify({
            id: entry.id,
            executeId: 'exec-r3',
            group: entry.group,
            finished: entry.finished,
            success: entry.success,
            duration: entry.duration,
          }),
        );
        return;
      }
      if (req.url === '/core/group-list') {
        res.end(JSON.stringify({ groups: [...daemonJobs.values()].map((j) => j.group) }));
        return;
      }
      if (req.url === '/core/stats') {
        res.end(JSON.stringify({ bytes: 4096, totalBytes: 4096, speed: 1024 }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const client = new RcloneRcClient({ baseUrl, authType: 'none' });
    const tasksById: Record<number, Record<string, unknown>> = {
      801: {
        id: 801,
        connectionId: 1,
        operation: 'sync/copy',
        srcFs: 'cloud-s3:src',
        srcRemote: '',
        dstFs: 'cloud-s3:dst',
        dstRemote: '',
        localAuthorized: false,
        status: 'queued',
        resumePending: false,
        resumeToken: null,
        resumeConsumedToken: null,
      },
      802: {
        id: 802,
        connectionId: 1,
        operation: 'sync/copy',
        srcFs: 'cloud-s3:src',
        srcRemote: '',
        dstFs: 'cloud-s3:dst',
        dstRemote: '',
        localAuthorized: false,
        status: 'queued',
        resumePending: false,
        resumeToken: null,
        resumeConsumedToken: null,
      },
      803: {
        id: 803,
        connectionId: 1,
        operation: 'sync/copy',
        srcFs: 'cloud-s3:src',
        srcRemote: '',
        dstFs: 'cloud-s3:dst',
        dstRemote: '',
        localAuthorized: false,
        status: 'completed',
        bytes: 2048,
        totalBytes: 2048,
        workflowJobId: null,
        resumePending: false,
        resumeToken: null,
        resumeConsumedToken: null,
      },
    };

    const makeTaskModel = (id: number) => ({
      get: (k: string) => tasksById[id]?.[k],
      set: (patch: Record<string, unknown>) => Object.assign(tasksById[id], patch),
      update: vi.fn(async (patch: Record<string, unknown>) => {
        Object.assign(tasksById[id], patch);
      }),
    });

    // Persisted DB jobs table (separate from in-memory Processor.saveJob staging to simulate crash before Processor.exit()!)
    const persistedJobs = new Map<string, { state: Record<string, unknown>; model: JobModel }>();
    const wrapJobModel = (state: Record<string, unknown>): JobModel =>
      ({
        get id() {
          return state.id;
        },
        get executionId() {
          return state.executionId;
        },
        get status() {
          return state.status;
        },
        get result() {
          return state.result;
        },
        get meta() {
          return state.meta;
        },
        get execution() {
          return state.execution;
        },
        set execution(val: unknown) {
          state.execution = val;
        },
        set: (patch: Record<string, unknown>) => Object.assign(state, patch),
        save: vi.fn().mockResolvedValue(undefined),
        getExecution: vi.fn(async () => state.execution),
      }) as unknown as JobModel;

    let jobSeq = 0;
    // Note: flushJobsToDb controls whether Processor.exit() persisted savedJob to the jobs table!
    let flushJobsToDb = true;
    const makeProcessor = (execId: number) =>
      ({
        execution: { id: execId, workflowId: 950 },
        getParsedValue: (v: unknown) => v,
        saveJob: vi.fn((payload: Record<string, unknown>) => {
          const id = `wf-r3-${++jobSeq}`;
          const state: Record<string, unknown> = {
            id,
            executionId: execId,
            ...payload,
            execution: { id: execId, workflowId: 950, status: EXECUTION_STATUS.STARTED },
          };
          const model = wrapJobModel(state);
          if (flushJobsToDb) {
            persistedJobs.set(id, { state, model });
          }
          return model;
        }),
      }) as unknown as Processor;

    const taskModelUpdate = vi.fn(
      async (
        patch: Record<string, unknown>,
        opts: {
          where: {
            id: number;
            status?: string | string[];
            rcloneGroup?: string;
            resumeConsumedToken?: string | null;
          };
        },
      ) => {
        const target = tasksById[opts.where.id];
        if (!target) return [0];
        if (opts.where.status !== undefined) {
          const current = String(target.status ?? '');
          const expected = opts.where.status;
          const matches = Array.isArray(expected) ? expected.includes(current) : current === expected;
          if (!matches) return [0];
        }
        if (opts.where.rcloneGroup !== undefined && target.rcloneGroup !== opts.where.rcloneGroup) {
          return [0];
        }
        if (
          Object.prototype.hasOwnProperty.call(opts.where, 'resumeConsumedToken') &&
          (target.resumeConsumedToken ?? null) !== opts.where.resumeConsumedToken
        ) {
          return [0];
        }
        Object.assign(target, patch);
        return [1];
      },
    );

    const jobModelUpdate = vi.fn(
      async (patch: Record<string, unknown>, opts: { where: { id: string; status?: number } }) => {
        const entry = persistedJobs.get(String(opts.where.id));
        if (!entry) return [0];
        if (opts.where.status !== undefined && entry.state.status !== opts.where.status) {
          return [0];
        }
        Object.assign(entry.state, patch);
        return [1];
      },
    );

    let crashAfterPublishOnce = false;
    const publishedJobIds: string[] = [];
    const resumeSpy = vi.fn(async (job: JobModel) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      publishedJobIds.push(String(job.id));
      if (crashAfterPublishOnce) {
        crashAfterPublishOnce = false;
        throw Object.assign(new Error('Process killed right after queue publish'), { simulatedCrash: true });
      }
    });

    const mockApp: Record<string, unknown> = {
      logger: { warn: vi.fn() },
      db: {
        getCollection: vi.fn((name: string) => {
          if (name === 'rcloneTransferTasks') return { model: { update: taskModelUpdate } };
          if (name === 'jobs') {
            return {
              model: {
                update: jobModelUpdate,
                findAll: vi.fn(async (opts?: { where?: { status?: number | number[] } }) => {
                  const expected = opts?.where?.status ?? JOB_STATUS.PENDING;
                  return [...persistedJobs.values()]
                    .filter((j) => {
                      const exec = j.state.execution as { status?: number } | undefined;
                      if (exec && exec.status !== EXECUTION_STATUS.STARTED) return false;
                      const s = Number(j.state.status);
                      return Array.isArray(expected) ? expected.includes(s) : s === expected;
                    })
                    .map((j) => j.model);
                }),
              },
            };
          }
          return undefined;
        }),
        getRepository: vi.fn((name: string) => {
          if (name === 'rcloneTransferTasks') {
            return {
              findOne: vi.fn(async ({ filterByTk }: { filterByTk: number }) =>
                tasksById[filterByTk] ? makeTaskModel(filterByTk) : null,
              ),
              find: vi.fn(async ({ filter }: { filter?: Record<string, unknown> }) => {
                if (filter?.status) {
                  return Object.keys(tasksById)
                    .map(Number)
                    .filter((id) => tasksById[id].status === filter.status)
                    .map((id) => makeTaskModel(id));
                }
                if (filter?.resumePending) {
                  return Object.keys(tasksById)
                    .map(Number)
                    .filter((id) => Boolean(tasksById[id].resumePending))
                    .map((id) => makeTaskModel(id));
                }
                return [];
              }),
            };
          }
          if (name === 'jobs') {
            return {
              findOne: vi.fn(
                async ({ filterByTk }: { filterByTk: string }) => persistedJobs.get(String(filterByTk))?.model ?? null,
              ),
              create: vi.fn(async ({ values }: { values: Record<string, unknown> }) => {
                const id = String(values.id);
                const state: Record<string, unknown> = {
                  ...values,
                  execution: { id: values.executionId, workflowId: 950, status: EXECUTION_STATUS.STARTED },
                };
                const model = wrapJobModel(state);
                persistedJobs.set(id, { state, model });
                return model;
              }),
              count: vi.fn(async ({ filter }: { filter?: Record<string, unknown> }) => {
                await new Promise<void>((resolve) => setTimeout(resolve, 10));
                return [...persistedJobs.values()].filter(
                  (j) =>
                    String(j.state.executionId ?? '') === String(filter?.executionId ?? '') &&
                    String(j.state.upstreamId ?? '') === String(filter?.upstreamId ?? ''),
                ).length;
              }),
            };
          }
          return {};
        }),
      },
      pm: {
        get: vi.fn((name: string) => {
          if (name === 'workflow') return { app: mockApp, resume: resumeSpy };
          if (name === PLUGIN_NAME) {
            return {
              connectionManager: { getClient: vi.fn(async () => ({ model: {}, client })) },
              reconciler: { kick: vi.fn() },
            };
          }
          return undefined;
        }),
      },
    };

    const instruction = new RcloneTransferInstruction({ app: mockApp, resume: resumeSpy } as never);
    const reconciler = new RcloneJobReconciler(
      mockApp as never,
      { getClient: vi.fn(async () => ({ model: {}, client })) } as never,
    );
    reconciler.start();

    // 1. Finding #1: Slow postAsync (>5s) where peer reconciler promotes 'starting' -> 'running' BEFORE postAsync returns.
    //    Worker 1 must NOT call stopJob/stopJobGroup, and workflowJobId must already be bound!
    const node801 = { id: 31, key: 'n801', config: { taskId: 801, failOnError: true } } as unknown as FlowNodeModel;
    const slowRunPromise = instruction.run(node801, null as unknown as JobModel, makeProcessor(4001));
    await daemonAccepted;
    expect(tasksById[801].status).toBe('starting');
    expect(tasksById[801].workflowJobId).toBeTruthy();
    expect(tasksById[801].workflowJobMeta).toBeTruthy();

    // Age startedAt past 5s so peer reconciler probes daemon and promotes #801 to 'running' while postAsync is still open
    tasksById[801].startedAt = new Date(Date.now() - 6_000).toISOString();
    await reconciler.reconcileOnce();
    expect(tasksById[801].status).toBe('running');
    expect(tasksById[801].rcloneJobId).toBe(950);

    resolveSlowPostAsync();
    const out801 = await slowRunPromise;
    const out801Id = String((out801 as { id?: string | number }).id ?? '');
    expect(out801.status).toBe(JOB_STATUS.PENDING);
    expect(stopHits).toBe(0);
    expect(tasksById[801].status).toBe('running');
    expect(tasksById[801].workflowJobId).toBe(out801Id);
    tasksById[801].status = 'stopped'; // Park #801 and its workflow job before sub-case 2
    const parked801Job = persistedJobs.get(out801Id);
    if (parked801Job) {
      parked801Job.state.status = JOB_STATUS.FAILED;
    }

    // 2. Findings #2 & #3:
    //    - Daemon accepts /sync/copy (job #951 running), then socket drops BEFORE HTTP response AND Processor crashes BEFORE flushing jobs table!
    //    - Task #802 must stay 'starting' (NEVER 'failed' while job #951 has finished=false, and 0 stop calls).
    //    - Once job #951 finishes on daemon, 2 reconciler ticks reconstruct the missing jobs row from workflowJobMeta and resume ONCE!
    mode = 'drop-rc-response';
    flushJobsToDb = false;
    const node802 = { id: 32, key: 'n802', config: { taskId: 802, failOnError: true } } as unknown as FlowNodeModel;
    const out802 = await instruction.run(node802, null as unknown as JobModel, makeProcessor(4002));
    const out802Id = String((out802 as { id?: string | number }).id ?? '');
    expect(out802.status).toBe(JOB_STATUS.PENDING);
    expect(tasksById[802].status).toBe('starting');
    expect(stopHits).toBe(0);
    expect(persistedJobs.has(out802Id)).toBe(false);

    // Daemon finishes job #951; Worker 2 scans two ticks with empty jobs table -> materializes job & calls resume once!
    const job951 = daemonJobs.get(951);
    if (job951) {
      job951.finished = true;
      job951.success = true;
      job951.duration = 1.2;
    }
    tasksById[802].startedAt = new Date(Date.now() - 6_000).toISOString();
    resumeSpy.mockClear();
    publishedJobIds.length = 0;

    await reconciler.reconcileOnce();
    await reconciler.reconcileOnce();

    expect(tasksById[802].status).toBe('completed');
    expect(tasksById[802].resumePending).toBe(false);
    expect(persistedJobs.get(out802Id)?.state.status).toBe(JOB_STATUS.RESOLVED);
    expect(publishedJobIds).toEqual([out802Id]);
    expect(resumeSpy).toHaveBeenCalledTimes(1);

    // 3. Finding #4: Two concurrent reconcilers scanning the same orphan PENDING job (#803 already completed, workflowJobId=null)
    //    must decide resumePending inside the lock and publish workflow.resume() ONCE!
    const orphanState: Record<string, unknown> = {
      id: 'wf-orphan-803',
      executionId: 4003,
      nodeId: 33,
      nodeKey: 'n803',
      status: JOB_STATUS.PENDING,
      result: { taskId: 803, failOnError: true },
      execution: { id: 4003, workflowId: 950, status: EXECUTION_STATUS.STARTED },
    };
    persistedJobs.set('wf-orphan-803', { state: orphanState, model: wrapJobModel(orphanState) });
    resumeSpy.mockClear();

    const peerReconciler = new RcloneJobReconciler(
      mockApp as never,
      { getClient: vi.fn(async () => ({ model: {}, client })) } as never,
    );
    peerReconciler.start();
    await Promise.all([reconciler.reconcileOnce(), peerReconciler.reconcileOnce()]);
    peerReconciler.stop();

    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(tasksById[803].resumePending).toBe(false);

    // 4. Finding #5: Worker crashes AFTER queue accepted publish #1 but BEFORE clearTaskResumePending; Worker 2 re-publishes #2.
    //    RcloneTransferInstruction.resume() consumes the durable resumeToken atomically so delivery #2 is ignored!
    tasksById[804] = {
      id: 804,
      connectionId: 1,
      status: 'completed',
      workflowJobId: 'wf-dup-804',
      resumePending: true,
      resumeToken: null,
      resumeConsumedToken: null,
    };
    const dupJobState: Record<string, unknown> = {
      id: 'wf-dup-804',
      executionId: 4004,
      nodeId: 34,
      nodeKey: 'n804',
      status: JOB_STATUS.RESOLVED,
      result: { taskId: 804, success: true, failOnError: true },
      meta: {},
      execution: { id: 4004, workflowId: 950, status: EXECUTION_STATUS.STARTED },
    };
    const dupJobModel = wrapJobModel(dupJobState);
    persistedJobs.set('wf-dup-804', { state: dupJobState, model: dupJobModel });

    publishedJobIds.length = 0;
    crashAfterPublishOnce = true;
    await reconciler.reconcileOnce(); // Publish #1 reaches queue, then simulated crash keeps resumePending=true!
    expect(tasksById[804].resumePending).toBe(true);
    expect(tasksById[804].resumeToken).toBeTruthy();

    await reconciler.reconcileOnce(); // Worker 2 retries and clears resumePending=false (2 messages now in queue)
    reconciler.stop();
    expect(publishedJobIds).toEqual(['wf-dup-804', 'wf-dup-804']);
    expect(tasksById[804].resumePending).toBe(false);

    const node804 = {
      id: 34,
      key: 'n804',
      downstream: { id: 35, key: 'n805' },
      config: { taskId: 804, failOnError: true },
    } as unknown as FlowNodeModel;

    // Simulate delivery #1 crashing right after instruction.resume() returns BEFORE Processor runs downstream / exit():
    const abortedFirstDelivery = await instruction.resume(node804, dupJobModel, makeProcessor(4004));
    expect(abortedFirstDelivery).toBe(dupJobModel);

    // Redelivery after pre-downstream crash MUST still return dupJobModel so downstream runs once!
    const recoveredDelivery = await instruction.resume(node804, dupJobModel, makeProcessor(4004));
    expect(recoveredDelivery).toBe(dupJobModel);

    // Once Processor.exit() durably persists the downstream job row, any subsequent duplicate delivery is ignored!
    const downState: Record<string, unknown> = {
      id: 'wf-down-805',
      executionId: 4004,
      upstreamId: 'wf-dup-804',
      nodeId: 35,
      nodeKey: 'n805',
      status: JOB_STATUS.RESOLVED,
      result: { notified: true },
    };
    persistedJobs.set('wf-down-805', { state: downState, model: wrapJobModel(downState) });

    const duplicateAfterPersisted = await instruction.resume(node804, dupJobModel, makeProcessor(4004));
    expect(duplicateAfterPersisted).toBeUndefined();
  });

  it('retains resumePending across volatile MemoryEventQueueAdapter crash, flushes prior sync jobs upfront, recovers post-claim crashes, preserves real rcloneJobId, marks expired running tasks unverified, and closes execution when task row is missing', async () => {
    const baseUrl = await startMockRcd((req, body, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/config/listremotes') {
        res.end(JSON.stringify({ remotes: ['cloud-s3'] }));
        return;
      }
      if (req.url === '/config/dump') {
        res.end(JSON.stringify({ 'cloud-s3': { type: 's3' } }));
        return;
      }
      if (req.url === '/sync/copy') {
        res.end(JSON.stringify({ jobid: 42, executeId: 'exec-r4' }));
        return;
      }
      if (req.url === '/job/list') {
        res.end(JSON.stringify({ executeId: 'exec-r4', jobids: [], runningIds: [], finishedIds: [] }));
        return;
      }
      if (req.url === '/job/status') {
        if (Number(body.jobid) === 42) {
          res.end(
            JSON.stringify({
              id: 42,
              executeId: 'exec-r4',
              finished: true,
              success: true,
              duration: 0.9,
            }),
          );
          return;
        }
        // Job #77 expired from daemon history (--rc-job-expire-duration)
        res.end(JSON.stringify({ error: 'job not found' }));
        return;
      }
      if (req.url === '/core/group-list') {
        res.end(JSON.stringify({ groups: [] }));
        return;
      }
      if (req.url === '/core/stats') {
        res.end(JSON.stringify({ bytes: 1024, totalBytes: 1024, speed: 1024 }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const client = new RcloneRcClient({ baseUrl, authType: 'none' });
    const tasksById: Record<number, Record<string, unknown>> = {
      901: {
        id: 901,
        connectionId: 1,
        operation: 'sync/copy',
        srcFs: 'cloud-s3:src',
        srcRemote: '',
        dstFs: 'cloud-s3:dst',
        dstRemote: '',
        localAuthorized: false,
        status: 'queued',
        resumePending: false,
      },
      902: {
        id: 902,
        connectionId: 1,
        operation: 'sync/copy',
        srcFs: 'cloud-s3:src',
        srcRemote: '',
        dstFs: 'cloud-s3:dst',
        dstRemote: '',
        localAuthorized: false,
        status: 'queued',
        resumePending: false,
      },
      903: {
        id: 903,
        connectionId: 1,
        operation: 'sync/copy',
        srcFs: 'cloud-s3:src',
        srcRemote: '',
        dstFs: 'cloud-s3:dst',
        dstRemote: '',
        localAuthorized: false,
        status: 'running',
        rcloneJobId: 77,
        rcloneExecuteId: 'exec-r4',
        rcloneGroup: 'nb-task-903-expired',
        workflowJobId: 'wf-903',
        startedAt: new Date(Date.now() - 90_000).toISOString(),
        resumePending: false,
      },
    };

    const makeTaskModel = (id: number) => ({
      get: (k: string) => tasksById[id]?.[k],
      set: (patch: Record<string, unknown>) => Object.assign(tasksById[id], patch),
      update: vi.fn(async (patch: Record<string, unknown>) => {
        Object.assign(tasksById[id], patch);
      }),
    });

    const persistedJobs = new Map<string, { state: Record<string, unknown>; model: JobModel }>();
    const executionsById: Record<number, { id: number; workflowId: number; status: number }> = {
      5001: { id: 5001, workflowId: 990, status: EXECUTION_STATUS.STARTED },
      5002: { id: 5002, workflowId: 990, status: EXECUTION_STATUS.STARTED },
      5003: { id: 5003, workflowId: 990, status: EXECUTION_STATUS.STARTED },
      5004: { id: 5004, workflowId: 990, status: EXECUTION_STATUS.STARTED },
    };

    const wrapSequelizeLikeJob = (state: Record<string, unknown>, initiallyNew = false): JobModel => {
      let isNew = initiallyNew;
      const dirty = new Set<string>();
      const model = {
        get id() {
          return state.id;
        },
        get executionId() {
          return state.executionId;
        },
        get upstreamId() {
          return state.upstreamId;
        },
        get nodeId() {
          return state.nodeId;
        },
        get status() {
          return state.status;
        },
        get result() {
          return state.result;
        },
        get meta() {
          return state.meta;
        },
        get execution() {
          return executionsById[Number(state.executionId)];
        },
        set execution(_val: unknown) {},
        get isNewRecord() {
          return isNew;
        },
        set isNewRecord(v: boolean) {
          isNew = v;
        },
        set: (patch: Record<string, unknown>) => {
          for (const k of Object.keys(patch)) dirty.add(k);
          Object.assign(state, patch);
        },
        changed: (field?: string, val?: boolean) => {
          if (!field) return dirty.size > 0;
          if (val === false) dirty.delete(field);
          return dirty.has(field);
        },
        save: vi.fn(async () => {
          isNew = false;
          dirty.clear();
          persistedJobs.set(String(state.id), { state, model: model as unknown as JobModel });
        }),
        getExecution: vi.fn(async () => executionsById[Number(state.executionId)]),
      };
      return model as unknown as JobModel;
    };

    // Seed #903's PENDING workflow job and #5004's orphaned PENDING workflow job (whose task #9999 was deleted)
    const state903: Record<string, unknown> = {
      id: 'wf-903',
      executionId: 5003,
      nodeId: 43,
      nodeKey: 'n903',
      status: JOB_STATUS.PENDING,
      result: { taskId: 903, rcloneJobId: 77, failOnError: true },
    };
    persistedJobs.set('wf-903', { state: state903, model: wrapSequelizeLikeJob(state903, false) });

    const stateMissingTask: Record<string, unknown> = {
      id: 'wf-missing-task',
      executionId: 5004,
      nodeId: 44,
      nodeKey: 'n_missing',
      status: JOB_STATUS.PENDING,
      result: { taskId: 9999, failOnError: true },
      meta: {},
    };
    persistedJobs.set('wf-missing-task', {
      state: stateMissingTask,
      model: wrapSequelizeLikeJob(stateMissingTask, false),
    });

    let abortRightAfterClaim = false;
    const taskModelUpdate = vi.fn(
      async (
        patch: Record<string, unknown>,
        opts: { where: { id?: number; executionId?: number; status?: string | string[]; rcloneGroup?: string } },
      ) => {
        if (opts.where.executionId !== undefined) {
          let count = 0;
          for (const row of Object.values(tasksById)) {
            if (Number(row.executionId) === Number(opts.where.executionId) && row.resumePending) {
              Object.assign(row, patch);
              count += 1;
            }
          }
          return [count];
        }
        const target = opts.where.id !== undefined ? tasksById[opts.where.id] : undefined;
        if (!target) return [0];
        if (opts.where.status !== undefined) {
          const current = String(target.status ?? '');
          const expected = opts.where.status;
          const matches = Array.isArray(expected) ? expected.includes(current) : current === expected;
          if (!matches) return [0];
        }
        if (opts.where.rcloneGroup !== undefined && target.rcloneGroup !== opts.where.rcloneGroup) {
          return [0];
        }
        Object.assign(target, patch);
        if (abortRightAfterClaim && patch.status === 'starting') {
          abortRightAfterClaim = false;
          throw new Error('SIMULATED_SIGKILL_AFTER_CLAIM');
        }
        return [1];
      },
    );

    const jobModelUpdate = vi.fn(
      async (patch: Record<string, unknown>, opts: { where: { id: string; status?: number } }) => {
        const entry = persistedJobs.get(String(opts.where.id));
        if (!entry) return [0];
        if (opts.where.status !== undefined && entry.state.status !== opts.where.status) {
          return [0];
        }
        Object.assign(entry.state, patch);
        return [1];
      },
    );

    // Volatile in-RAM queue simulating NocoBase's default MemoryEventQueueAdapter (`queues: new Map()`)
    let ramQueue: string[] = [];
    const volatileQueueAdapter = { queues: new Map<string, unknown[]>() };
    const resumeSpy = vi.fn(async (job: JobModel) => {
      ramQueue.push(String(job.id));
    });

    let snowflakeSeq = 7000;
    const workflowPluginMock = {
      app: null as unknown,
      resume: resumeSpy,
      snowflake: { getUniqueID: () => ({ toString: () => `sf-${++snowflakeSeq}` }) },
    };

    const mockApp: Record<string, unknown> = {
      logger: { warn: vi.fn() },
      eventQueue: { adapter: volatileQueueAdapter },
      db: {
        on: vi.fn(),
        off: vi.fn(),
        getCollection: vi.fn((name: string) => {
          if (name === 'rcloneTransferTasks') return { model: { update: taskModelUpdate } };
          if (name === 'jobs') {
            return {
              model: {
                update: jobModelUpdate,
                findAll: vi.fn(async (opts?: { where?: { status?: number | number[] } }) => {
                  const expected = opts?.where?.status ?? JOB_STATUS.PENDING;
                  return [...persistedJobs.values()]
                    .filter((j) => {
                      const exec = executionsById[Number(j.state.executionId)];
                      if (!exec || exec.status !== EXECUTION_STATUS.STARTED) return false;
                      const s = Number(j.state.status);
                      return Array.isArray(expected) ? expected.includes(s) : s === expected;
                    })
                    .map((j) => j.model);
                }),
              },
            };
          }
          return undefined;
        }),
        getRepository: vi.fn((name: string) => {
          if (name === 'rcloneTransferTasks') {
            return {
              findOne: vi.fn(async ({ filterByTk }: { filterByTk: number }) =>
                tasksById[filterByTk] ? makeTaskModel(filterByTk) : null,
              ),
              find: vi.fn(async ({ filter }: { filter?: Record<string, unknown> }) => {
                if (filter?.status) {
                  return Object.keys(tasksById)
                    .map(Number)
                    .filter((id) => tasksById[id].status === filter.status)
                    .map((id) => makeTaskModel(id));
                }
                if (filter?.resumePending) {
                  return Object.keys(tasksById)
                    .map(Number)
                    .filter((id) => Boolean(tasksById[id].resumePending))
                    .map((id) => makeTaskModel(id));
                }
                return [];
              }),
            };
          }
          if (name === 'jobs') {
            return {
              findOne: vi.fn(
                async ({ filterByTk }: { filterByTk: string }) => persistedJobs.get(String(filterByTk))?.model ?? null,
              ),
              create: vi.fn(async ({ values }: { values: Record<string, unknown> }) => {
                const id = String(values.id);
                const state: Record<string, unknown> = { ...values };
                const model = wrapSequelizeLikeJob(state, false);
                persistedJobs.set(id, { state, model });
                return model;
              }),
              count: vi.fn(async ({ filter }: { filter?: Record<string, unknown> }) => {
                return [...persistedJobs.values()].filter(
                  (j) =>
                    String(j.state.executionId ?? '') === String(filter?.executionId ?? '') &&
                    String(j.state.upstreamId ?? '') === String(filter?.upstreamId ?? ''),
                ).length;
              }),
            };
          }
          return {};
        }),
      },
      pm: {
        get: vi.fn((name: string) => {
          if (name === 'workflow') return workflowPluginMock;
          if (name === PLUGIN_NAME) {
            return {
              connectionManager: { getClient: vi.fn(async () => ({ model: {}, client })) },
              reconciler: { kick: vi.fn() },
            };
          }
          return undefined;
        }),
      },
    };
    workflowPluginMock.app = mockApp;

    const instruction = new RcloneTransferInstruction(workflowPluginMock as never);

    // 1. Findings #3 & #5: Prior synchronous job in processor.jobsToSave (isNewRecord=true) is flushed to DB BEFORE
    //    postAsync, AND wfJob.result gets the real rcloneJobId=42 (never stuck at 0)!
    const priorJobState: Record<string, unknown> = {
      id: 'wf-prior-1',
      executionId: 5001,
      nodeId: 40,
      nodeKey: 'n_prior',
      status: JOB_STATUS.RESOLVED,
      result: { bucketPrefix: '2026-archive' },
    };
    const priorJobModel = wrapSequelizeLikeJob(priorJobState, true);
    const jobsToSave5001 = new Map<string, JobModel>([['wf-prior-1', priorJobModel]]);
    let seq = 0;
    const processor5001 = {
      execution: executionsById[5001],
      jobsToSave: jobsToSave5001,
      getParsedValue: (v: unknown) => v,
      saveJob: vi.fn((payload: Record<string, unknown>) => {
        const id = `wf-copy-${++seq}`;
        const state: Record<string, unknown> = { id, executionId: 5001, ...payload };
        const model = wrapSequelizeLikeJob(state, true);
        jobsToSave5001.set(id, model);
        return model;
      }),
    } as unknown as Processor;

    const node901 = { id: 41, key: 'n901', config: { taskId: 901, failOnError: true } } as unknown as FlowNodeModel;
    const copyJob901 = await instruction.run(node901, priorJobModel, processor5001);
    const copyJob901Id = String((copyJob901 as { id?: string }).id ?? '');

    // Even before Processor.exit() runs, BOTH priorJob AND copyJob are persisted in DB, and rcloneJobId is 42 (not 0)!
    expect(persistedJobs.has('wf-prior-1')).toBe(true);
    expect(persistedJobs.get('wf-prior-1')?.state.result).toEqual({ bucketPrefix: '2026-archive' });
    expect(persistedJobs.has(copyJob901Id)).toBe(true);
    expect((persistedJobs.get(copyJob901Id)?.state.result as { rcloneJobId?: number }).rcloneJobId).toBe(42);

    // 2. Finding #4: Simulate process killed IMMEDIATELY after queued -> starting claim (before processor.saveJob / postAsync)!
    //    Because workflowJobMeta was written atomically in claimPatch, a restarted worker recovers after expiry and resumes!
    abortRightAfterClaim = true;
    const processor5002 = {
      execution: executionsById[5002],
      jobsToSave: new Map<string, JobModel>(),
      getParsedValue: (v: unknown) => v,
      saveJob: vi.fn(),
    } as unknown as Processor;
    const node902 = { id: 42, key: 'n902', config: { taskId: 902, failOnError: true } } as unknown as FlowNodeModel;
    // Catch simulated kill before instruction.run's own catch can mark failed (emulating hard process death!)
    const rawRunPromise = instruction.run(node902, null as unknown as JobModel, processor5002);
    await rawRunPromise;
    // Restore exact state left by SIGKILL right after claimPatch committed:
    tasksById[902].status = 'starting';
    tasksById[902].workflowJobId = null;
    tasksById[902].startedAt = new Date(Date.now() - 180_000).toISOString();
    expect(tasksById[902].workflowJobMeta).toBeTruthy();

    // 3. Run Worker 1 reconciler:
    //    - #901 completes with rcloneJobId=42 in wfJob.result, publishes to volatile MemoryEventQueueAdapter, and
    //      KEEPS resumePending=true in DB while execution #5001 is still STARTED in RAM queue (Finding #2)!
    //    - #902 (post-claim crash, empty jobs table) allocates Snowflake wfJobId, materializes job, and publishes resume!
    //    - #903 (running task whose daemon job #77 expired) transitions to 'unverified' (NOT 'failed' — Finding #6)!
    //    - 'wf-missing-task' (deleted task #9999) settles to FAILED and publishes resume (Finding #7)!
    const reconcilerW1 = new RcloneJobReconciler(
      mockApp as never,
      { getClient: vi.fn(async () => ({ model: {}, client })) } as never,
    );
    reconcilerW1.start();
    await reconcilerW1.reconcileOnce();
    reconcilerW1.stop();

    expect(tasksById[901].status).toBe('completed');
    expect((persistedJobs.get(copyJob901Id)?.state.result as { rcloneJobId?: number }).rcloneJobId).toBe(42);
    // Volatile MemoryEventQueueAdapter has NOT processed ramQueue yet -> resumePending MUST remain true in DB!
    expect(tasksById[901].resumePending).toBe(true);
    expect(ramQueue).toContain(copyJob901Id);

    expect(tasksById[902].status).toBe('unverified');
    const generated902JobId = String(tasksById[902].workflowJobId ?? '');
    expect(generated902JobId).toMatch(/^sf-/);
    expect(persistedJobs.has(generated902JobId)).toBe(true);
    expect(ramQueue).toContain(generated902JobId);

    expect(tasksById[903].status).toBe('unverified');
    expect(persistedJobs.get('wf-903')?.state.status).toBe(JOB_STATUS.FAILED);

    expect(persistedJobs.get('wf-missing-task')?.state.status).toBe(JOB_STATUS.FAILED);
    expect(ramQueue).toContain('wf-missing-task');

    // 4. Finding #7: Missing-task FAILED job delivered to instruction.resume() returns the FAILED job (not undefined!)
    //    so Processor.exit() can close execution #5004!
    const missingTaskNode = { id: 44, key: 'n_missing', config: { taskId: 9999 } } as unknown as FlowNodeModel;
    const missingTaskEntry = persistedJobs.get('wf-missing-task');
    expect(missingTaskEntry).toBeDefined();
    if (!missingTaskEntry) throw new Error('wf-missing-task not found');
    const missingTaskModel = missingTaskEntry.model;
    const resumedMissing = await instruction.resume(missingTaskNode, missingTaskModel, {
      execution: executionsById[5004],
    } as unknown as Processor);
    expect(resumedMissing).toBe(missingTaskModel);

    // 5. Finding #2: Simulate abrupt process crash wiping volatile MemoryEventQueueAdapter (`ramQueue = []`)!
    //    New Worker 2 reconciler starts with empty memoryDispatchTimestamps, sees resumePending=true, and RE-PUBLISHES!
    ramQueue = [];
    const reconcilerW2 = new RcloneJobReconciler(
      mockApp as never,
      { getClient: vi.fn(async () => ({ model: {}, client })) } as never,
    );
    reconcilerW2.start();
    await reconcilerW2.reconcileOnce();
    expect(ramQueue).toContain(copyJob901Id);
    expect(ramQueue).toContain(generated902JobId);
    // P2 #7: Orphan settled workflow job ('wf-missing-task') ALSO re-publishes after RAM queue crash while #5004 is STARTED!
    expect(ramQueue).toContain('wf-missing-task');

    // Once executions leave STARTED (processed by Worker 2), next tick clears resumePending=false!
    executionsById[5001].status = EXECUTION_STATUS.RESOLVED;
    executionsById[5002].status = EXECUTION_STATUS.FAILED;
    executionsById[5003].status = EXECUTION_STATUS.FAILED;
    executionsById[5004].status = EXECUTION_STATUS.FAILED;
    await reconcilerW2.reconcileOnce();
    reconcilerW2.stop();

    expect(tasksById[901].resumePending).toBe(false);
    expect(tasksById[902].resumePending).toBe(false);
    expect(tasksById[903].resumePending).toBe(false);
  });

  it('prevents standard Create re-execution across 2 workers, closes crashed tail/End executions, pre-allocates atomic workflowJobId, flushes dirty prevJob, and preserves recovered rcloneJobId', async () => {
    const postAsyncSpy = vi.fn().mockResolvedValue({ jobid: 88, executeId: 'exec-r5-88' });
    const findJobByGroupSpy = vi.fn(async (group: string) => {
      if (group === 'nb-task-956-finished') {
        return {
          job: { id: 15, finished: true, success: true, duration: 0.4, error: '' },
          executeId: 'exec-r5-15',
        };
      }
      return null;
    });
    const client = {
      isFsLocal: vi.fn().mockResolvedValue(false),
      isUnrootedBucketFs: vi.fn().mockResolvedValue(false),
      postAsync: postAsyncSpy,
      stopJob: vi.fn().mockResolvedValue(undefined),
      stopJobGroup: vi.fn().mockResolvedValue(undefined),
      getJobStatus: vi.fn().mockResolvedValue({ id: 88, finished: true, success: true, duration: 0.2 }),
      getJobTransferStats: vi.fn().mockResolvedValue({ bytes: 512, totalBytes: 512 }),
      getStats: vi.fn().mockResolvedValue({ bytes: 512, totalBytes: 512 }),
      getTransferred: vi.fn().mockResolvedValue({ transferred: [] }),
      getStatsGroups: vi.fn().mockResolvedValue([]),
      findJobByGroup: findJobByGroupSpy,
    } as unknown as RcloneRcClient;

    const tasksById: Record<number, Record<string, unknown>> = {
      // Case 1 (P1 #1): Rclone -> Create (upstreamId=null) -> Delay (PENDING) on 2 workers
      951: {
        id: 951,
        connectionId: 1,
        operation: 'sync/copy',
        srcFs: 's3:raw',
        srcRemote: '',
        dstFs: 's3:curated',
        dstRemote: '',
        status: 'completed',
        rcloneJobId: 81,
        rcloneGroup: 'nb-task-951-g',
        workflowId: 995,
        executionId: 6001,
        workflowJobId: '8001',
        resumePending: true,
        resumeToken: 'rtok-8001',
        resumeConsumedToken: null,
        startedAt: new Date(Date.now() - 5_000).toISOString(),
      },
      // Case 2 (P1 #2): Tail Rclone node crashed after job.meta.consumedResumeToken saved & before ExecutionModel.update
      952: {
        id: 952,
        connectionId: 1,
        operation: 'sync/copy',
        srcFs: 's3:raw',
        srcRemote: '',
        dstFs: 's3:tail',
        dstRemote: '',
        status: 'completed',
        rcloneJobId: 82,
        rcloneGroup: 'nb-task-952-g',
        workflowId: 995,
        executionId: 6002,
        workflowJobId: '8101',
        resumePending: true,
        resumeToken: 'rtok-tail-8101',
        resumeConsumedToken: null,
        startedAt: new Date(Date.now() - 5_000).toISOString(),
      },
      // Case 3 (P1 #3): Rclone -> End crashed after endJob persisted in jobs & before ExecutionModel.update
      953: {
        id: 953,
        connectionId: 1,
        operation: 'sync/copy',
        srcFs: 's3:raw',
        srcRemote: '',
        dstFs: 's3:end',
        dstRemote: '',
        status: 'completed',
        rcloneJobId: 83,
        rcloneGroup: 'nb-task-953-g',
        workflowId: 995,
        executionId: 6003,
        workflowJobId: '8201',
        resumePending: true,
        resumeToken: 'rtok-end-8201',
        resumeConsumedToken: null,
        startedAt: new Date(Date.now() - 5_000).toISOString(),
      },
      // Case 4 & 5 (P1 #4 & P1 #5): Queued task with failOnError=false + dirty existing prevJob, crashing right after savedJob.save()
      954: {
        id: 954,
        connectionId: 1,
        operation: 'sync/copy',
        srcFs: 's3:raw',
        srcRemote: '',
        dstFs: 's3:atomic',
        dstRemote: '',
        status: 'queued',
        localAuthorized: false,
      },
      // Case 6 (P2 #6): Interrupted starting task whose daemon job #15 already finished before recovery
      956: {
        id: 956,
        connectionId: 1,
        operation: 'sync/copy',
        srcFs: 's3:raw',
        srcRemote: '',
        dstFs: 's3:fast',
        dstRemote: '',
        status: 'starting',
        rcloneJobId: null,
        rcloneGroup: 'nb-task-956-finished',
        workflowId: 995,
        executionId: 6006,
        workflowJobId: '8601',
        resumePending: false,
        startedAt: new Date(Date.now() - 10_000).toISOString(),
      },
    };

    const makeTaskModel = (id: number) =>
      ({
        get: (k: string) => tasksById[id]?.[k],
        set: (patch: Record<string, unknown>) => {
          if (tasksById[id]) Object.assign(tasksById[id], patch);
        },
        update: vi.fn(async (patch: Record<string, unknown>) => {
          if (tasksById[id]) Object.assign(tasksById[id], patch);
        }),
      }) as unknown as Model;

    const executionsById: Record<number, { id: number; workflowId: number; status: number }> = {
      6001: { id: 6001, workflowId: 995, status: EXECUTION_STATUS.STARTED },
      6002: { id: 6002, workflowId: 995, status: EXECUTION_STATUS.STARTED },
      6003: { id: 6003, workflowId: 995, status: EXECUTION_STATUS.STARTED },
      6004: { id: 6004, workflowId: 995, status: EXECUTION_STATUS.STARTED },
      6006: { id: 6006, workflowId: 995, status: EXECUTION_STATUS.STARTED },
    };

    const persistedJobs = new Map<string, { state: Record<string, unknown>; model: JobModel }>();
    let crashRightAfterJobSave = false;

    const wrapJob = (state: Record<string, unknown>, initiallyNew = false): JobModel => {
      let isNew = initiallyNew;
      const dirty = new Set<string>();
      const model = {
        get id() {
          return state.id;
        },
        get executionId() {
          return state.executionId;
        },
        get upstreamId() {
          return state.upstreamId;
        },
        get nodeId() {
          return state.nodeId;
        },
        get nodeKey() {
          return state.nodeKey;
        },
        get status() {
          return state.status;
        },
        get result() {
          return state.result;
        },
        get meta() {
          return state.meta;
        },
        get execution() {
          return executionsById[Number(state.executionId)];
        },
        set execution(_v: unknown) {},
        get isNewRecord() {
          return isNew;
        },
        set isNewRecord(v: boolean) {
          isNew = v;
        },
        set: (patch: Record<string, unknown>) => {
          for (const k of Object.keys(patch)) dirty.add(k);
          Object.assign(state, patch);
        },
        changed: (field?: string, val?: boolean) => {
          if (!field) return dirty.size > 0;
          if (val === false) dirty.delete(field);
          return dirty.has(field);
        },
        save: vi.fn(async () => {
          isNew = false;
          dirty.clear();
          persistedJobs.set(String(state.id), { state, model: model as unknown as JobModel });
          if (crashRightAfterJobSave && Number(state.nodeId) === 74) {
            crashRightAfterJobSave = false;
            throw new Error('SIMULATED_SIGKILL_RIGHT_AFTER_SAVED_JOB_SAVE');
          }
        }),
        getExecution: vi.fn(async () => executionsById[Number(state.executionId)]),
      };
      return model as unknown as JobModel;
    };

    // Seed Case 1 (P1 #1): Execution #6001 already ran Rclone ('8001'), standard Create ('8002', upstreamId=null), and parked at Delay ('8003', PENDING, upstreamId=null)
    for (const row of [
      {
        id: '8001',
        executionId: 6001,
        nodeId: 51,
        nodeKey: 'n_rclone_1',
        upstreamId: null,
        status: JOB_STATUS.RESOLVED,
        result: { taskId: 951, rcloneJobId: 81, resumeToken: 'rtok-8001', success: true },
        meta: { consumedResumeToken: 'rtok-8001' },
      },
      {
        id: '8002',
        executionId: 6001,
        nodeId: 52,
        nodeKey: 'n_create',
        upstreamId: null,
        status: JOB_STATUS.RESOLVED,
        result: { createdRecordId: 1 },
        meta: {},
      },
      {
        id: '8003',
        executionId: 6001,
        nodeId: 53,
        nodeKey: 'n_delay',
        upstreamId: null,
        status: JOB_STATUS.PENDING,
        result: null,
        meta: {},
      },
      // Case 2 (P1 #2): Tail Rclone node ('8101') with consumedResumeToken already saved, execution #6002 still STARTED
      {
        id: '8101',
        executionId: 6002,
        nodeId: 61,
        nodeKey: 'n_rclone_tail',
        upstreamId: null,
        status: JOB_STATUS.RESOLVED,
        result: { taskId: 952, rcloneJobId: 82, resumeToken: 'rtok-tail-8101', success: true },
        meta: { consumedResumeToken: 'rtok-tail-8101' },
      },
      // Case 3 (P1 #3): Rclone ('8201') -> End ('8202', upstreamId=null, RESOLVED), execution #6003 still STARTED
      {
        id: '8201',
        executionId: 6003,
        nodeId: 71,
        nodeKey: 'n_rclone_before_end',
        upstreamId: null,
        status: JOB_STATUS.RESOLVED,
        result: { taskId: 953, rcloneJobId: 83, resumeToken: 'rtok-end-8201', success: true },
        meta: { consumedResumeToken: 'rtok-end-8201' },
      },
      {
        id: '8202',
        executionId: 6003,
        nodeId: 72,
        nodeKey: 'n_end',
        upstreamId: null,
        status: JOB_STATUS.RESOLVED,
        result: 1,
        meta: {},
      },
      // Case 6 (P2 #6): PENDING workflow job '8601' for interrupted starting task #956
      {
        id: '8601',
        executionId: 6006,
        nodeId: 86,
        nodeKey: 'n_fast_start',
        upstreamId: null,
        status: JOB_STATUS.PENDING,
        result: { taskId: 956, rcloneJobId: 0, failOnError: true },
        meta: {},
      },
    ]) {
      const state = { ...row };
      persistedJobs.set(row.id, { state, model: wrapJob(state, false) });
    }

    const dbListeners = new Map<string, (instance: Model) => void>();
    const taskModelUpdate = vi.fn(
      async (
        patch: Record<string, unknown>,
        opts: { where: { id?: number; executionId?: number; status?: string | string[]; rcloneGroup?: string } },
      ) => {
        if (opts.where.executionId !== undefined) {
          let count = 0;
          for (const row of Object.values(tasksById)) {
            if (Number(row.executionId) === Number(opts.where.executionId) && row.resumePending) {
              Object.assign(row, patch);
              count += 1;
            }
          }
          return [count];
        }
        const target = opts.where.id !== undefined ? tasksById[opts.where.id] : undefined;
        if (!target) return [0];
        if (opts.where.status !== undefined) {
          const current = String(target.status ?? '');
          const expected = opts.where.status;
          const matches = Array.isArray(expected) ? expected.includes(current) : current === expected;
          if (!matches) return [0];
        }
        if (opts.where.rcloneGroup !== undefined && target.rcloneGroup !== opts.where.rcloneGroup) {
          return [0];
        }
        Object.assign(target, patch);
        return [1];
      },
    );

    const jobModelUpdate = vi.fn(
      async (patch: Record<string, unknown>, opts: { where: { id: string; status?: number } }) => {
        const entry = persistedJobs.get(String(opts.where.id));
        if (!entry) return [0];
        if (opts.where.status !== undefined && entry.state.status !== opts.where.status) {
          return [0];
        }
        Object.assign(entry.state, patch);
        return [1];
      },
    );

    const resumedByReconciler: string[] = [];
    const volatileQueueAdapter = { queues: new Map<string, unknown[]>() };
    let sfCounter = 9000;
    const workflowPluginMock = {
      app: null as unknown,
      resume: vi.fn(async (job: JobModel) => {
        resumedByReconciler.push(String(job.id));
      }),
      snowflake: { getUniqueID: () => ({ toString: () => String(++sfCounter) }) },
    };

    const mockApp: Record<string, unknown> = {
      logger: { warn: vi.fn() },
      eventQueue: { adapter: volatileQueueAdapter },
      db: {
        on: vi.fn((event: string, listener: (instance: Model) => void) => {
          dbListeners.set(event, listener);
        }),
        off: vi.fn((event: string) => {
          dbListeners.delete(event);
        }),
        getModel: vi.fn((name: string) => {
          if (name === 'jobs') {
            return {
              build: (values: Record<string, unknown>, options?: { isNewRecord?: boolean }) =>
                wrapJob({ ...values }, Boolean(options?.isNewRecord)),
            };
          }
          return undefined;
        }),
        getCollection: vi.fn((name: string) => {
          if (name === 'rcloneTransferTasks') return { model: { update: taskModelUpdate } };
          if (name === 'jobs') {
            return {
              model: {
                update: jobModelUpdate,
                findAll: vi.fn(async (opts?: { where?: { status?: number | number[] } }) => {
                  const expected = opts?.where?.status ?? JOB_STATUS.PENDING;
                  return [...persistedJobs.values()]
                    .filter((j) => {
                      const exec = executionsById[Number(j.state.executionId)];
                      if (!exec || exec.status !== EXECUTION_STATUS.STARTED) return false;
                      const s = Number(j.state.status);
                      return Array.isArray(expected) ? expected.includes(s) : s === expected;
                    })
                    .map((j) => j.model);
                }),
              },
            };
          }
          return undefined;
        }),
        getRepository: vi.fn((name: string) => {
          if (name === 'rcloneTransferTasks') {
            return {
              findOne: vi.fn(async ({ filterByTk }: { filterByTk: number }) =>
                tasksById[filterByTk] ? makeTaskModel(filterByTk) : null,
              ),
              find: vi.fn(async ({ filter }: { filter?: Record<string, unknown> }) => {
                if (filter?.status) {
                  return Object.keys(tasksById)
                    .map(Number)
                    .filter((id) => tasksById[id].status === filter.status)
                    .map((id) => makeTaskModel(id));
                }
                if (filter?.resumePending) {
                  return Object.keys(tasksById)
                    .map(Number)
                    .filter((id) => Boolean(tasksById[id].resumePending))
                    .map((id) => makeTaskModel(id));
                }
                return [];
              }),
            };
          }
          if (name === 'jobs') {
            return {
              findOne: vi.fn(
                async ({ filterByTk }: { filterByTk: string }) => persistedJobs.get(String(filterByTk))?.model ?? null,
              ),
              find: vi.fn(async ({ filter }: { filter?: Record<string, unknown> }) =>
                [...persistedJobs.values()]
                  .filter((j) => String(j.state.executionId) === String(filter?.executionId ?? ''))
                  .map((j) => j.model),
              ),
              create: vi.fn(async ({ values }: { values: Record<string, unknown> }) => {
                const id = String(values.id);
                const state: Record<string, unknown> = { ...values };
                const model = wrapJob(state, false);
                persistedJobs.set(id, { state, model });
                return model;
              }),
            };
          }
          return {};
        }),
      },
      pm: {
        get: vi.fn((name: string) => {
          if (name === 'workflow') return workflowPluginMock;
          if (name === PLUGIN_NAME) {
            return {
              connectionManager: { getClient: vi.fn(async () => ({ model: {}, client })) },
              reconciler: { kick: vi.fn() },
            };
          }
          return undefined;
        }),
      },
    };
    workflowPluginMock.app = mockApp;

    const instruction = new RcloneTransferInstruction(workflowPluginMock as never);

    // --- Verify P1 #4 & P1 #5: Dirty existing prevJob (isNewRecord=false, changed()=true) is flushed upfront,
    //     AND workflowJobId is pre-allocated atomically at claimPatch before savedJob.save()! ---
    const existingPrevState: Record<string, unknown> = {
      id: '8400',
      executionId: 6004,
      nodeId: 73,
      nodeKey: 'n_prev_delay',
      status: JOB_STATUS.PENDING,
      result: null,
    };
    const existingPrevModel = wrapJob(existingPrevState, false);
    persistedJobs.set('8400', { state: { ...existingPrevState }, model: existingPrevModel });
    // Simulate upstream Processor resuming prevJob in memory (PENDING -> RESOLVED) without flushing yet:
    existingPrevModel.set({ status: JOB_STATUS.RESOLVED, result: { approvedBy: 'ops' } });
    expect(existingPrevModel.isNewRecord).toBe(false);
    expect(existingPrevModel.changed()).toBe(true);

    const jobsToSave6004 = new Map<string, JobModel>([['8400', existingPrevModel]]);
    const processor6004 = {
      execution: executionsById[6004],
      jobsToSave: jobsToSave6004,
      getParsedValue: (v: unknown) => v,
      saveJob: vi.fn((payload: JobModel) => {
        jobsToSave6004.set(String(payload.id), payload);
        return payload;
      }),
    } as unknown as Processor;

    crashRightAfterJobSave = true;
    const node954 = {
      id: 74,
      key: 'n_atomic',
      config: { taskId: 954, failOnError: false },
    } as unknown as FlowNodeModel;
    await instruction.run(node954, existingPrevModel, processor6004);

    // Emulate exact DB state if SIGKILL struck inside savedJob.save() right after writing the jobs row (before catch):
    tasksById[954].status = 'starting';
    tasksById[954].startedAt = new Date(Date.now() - 180_000).toISOString();

    // P1 #5: Existing dirty prevJob ('8400') WAS saved to DB before claiming/dispatching!
    expect(persistedJobs.get('8400')?.state.status).toBe(JOB_STATUS.RESOLVED);
    expect(persistedJobs.get('8400')?.state.result).toEqual({ approvedBy: 'ops' });

    // P1 #4: Task #954 ALREADY carries the exact pre-allocated Snowflake workflowJobId ('9001') matching persistedJobs!
    const preAllocId = String(tasksById[954].workflowJobId ?? '');
    expect(preAllocId).toBe('9001');
    expect(persistedJobs.has('9001')).toBe(true);

    // --- Run Worker 2 Reconciler across all 5 executions ---
    const reconciler = new RcloneJobReconciler(
      mockApp as never,
      { getClient: vi.fn(async () => ({ model: {}, client })) } as never,
    );
    reconciler.start();
    await reconciler.reconcileOnce();

    // P1 #1: Execution #6001 (Rclone -> Create [upstreamId=null] -> Delay [PENDING]) MUST NOT re-publish resume!
    expect(resumedByReconciler).not.toContain('8001');
    expect(tasksById[951].resumePending).toBe(false);

    // P1 #1 (Instruction defense-in-depth): Even if a stale queued message delivers '8001' to instruction.resume(),
    // Create node (#52) MUST NOT run a second time!
    let createRunCount = 1;
    const delayNode53 = { id: 53, key: 'n_delay', type: 'delay', downstream: undefined } as unknown as FlowNodeModel;
    const createNode52 = {
      id: 52,
      key: 'n_create',
      type: 'create',
      downstreamId: 53,
      downstream: delayNode53,
    } as unknown as FlowNodeModel;
    const rcloneNode51 = {
      id: 51,
      key: 'n_rclone_1',
      type: 'rclone-transfer',
      downstreamId: 52,
      downstream: createNode52,
      config: { taskId: 951 },
    } as unknown as FlowNodeModel;
    const processor6001 = {
      execution: {
        ...executionsById[6001],
        jobs: ['8001', '8002', '8003'].map((id) => persistedJobs.get(id)?.model).filter(Boolean),
      },
      nodesMap: new Map<number, FlowNodeModel>([
        [51, rcloneNode51],
        [52, createNode52],
        [53, delayNode53],
      ]),
      run: vi.fn(async () => {
        createRunCount += 1;
      }),
      exit: vi.fn(),
      end: vi.fn(),
    } as unknown as Processor;
    const rcloneJob8001 = persistedJobs.get('8001')?.model;
    if (!rcloneJob8001) throw new Error('Missing 8001');
    const duplicateResumeResult = await instruction.resume(rcloneNode51, rcloneJob8001, processor6001);
    expect(duplicateResumeResult).toBeUndefined();
    expect(createRunCount).toBe(1);

    // P1 #2: Tail Rclone node ('8101') re-published and instruction.resume() completes missing processor.exit(RESOLVED)!
    expect(resumedByReconciler).toContain('8101');
    const tailNode61 = {
      id: 61,
      key: 'n_rclone_tail',
      type: 'rclone-transfer',
      downstream: undefined,
      config: { taskId: 952 },
    } as unknown as FlowNodeModel;
    const exitSpy6002 = vi.fn(async (s?: number) => {
      if (typeof s === 'number') executionsById[6002].status = EXECUTION_STATUS.RESOLVED;
    });
    const rcloneJob8101 = persistedJobs.get('8101')?.model;
    if (!rcloneJob8101) throw new Error('Missing 8101');
    const tailResumeResult = await instruction.resume(tailNode61, rcloneJob8101, {
      execution: executionsById[6002],
      exit: exitSpy6002,
    } as unknown as Processor);
    expect(tailResumeResult).toBeUndefined();
    expect(exitSpy6002).toHaveBeenCalledWith(JOB_STATUS.RESOLVED);
    expect(executionsById[6002].status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(tasksById[952].resumePending).toBe(false);

    // P1 #3: Rclone -> End ('8201' -> '8202') was NOT prematurely cleared by reconciler; resume closes execution #6003!
    expect(resumedByReconciler).toContain('8201');
    const endNode72 = { id: 72, key: 'n_end', type: 'end', downstream: undefined } as unknown as FlowNodeModel;
    const rcloneNode71 = {
      id: 71,
      key: 'n_rclone_before_end',
      type: 'rclone-transfer',
      downstreamId: 72,
      downstream: endNode72,
      config: { taskId: 953 },
    } as unknown as FlowNodeModel;
    const exitSpy6003 = vi.fn(async (s?: number) => {
      if (typeof s === 'number') executionsById[6003].status = EXECUTION_STATUS.RESOLVED;
    });
    const rcloneJob8201 = persistedJobs.get('8201')?.model;
    if (!rcloneJob8201) throw new Error('Missing 8201');
    const endResumeResult = await instruction.resume(rcloneNode71, rcloneJob8201, {
      execution: {
        ...executionsById[6003],
        jobs: ['8201', '8202'].map((id) => persistedJobs.get(id)?.model).filter(Boolean),
      },
      nodesMap: new Map<number, FlowNodeModel>([
        [71, rcloneNode71],
        [72, endNode72],
      ]),
      exit: exitSpy6003,
    } as unknown as Processor);
    expect(endResumeResult).toBeUndefined();
    expect(exitSpy6003).toHaveBeenCalledWith(JOB_STATUS.RESOLVED);
    expect(executionsById[6003].status).toBe(EXECUTION_STATUS.RESOLVED);
    expect(tasksById[953].resumePending).toBe(false);

    // P1 #4: Recovery of #954 (failOnError=false) reused pre-allocated '9001' — ONLY 1 job row for node #74 and 1 resume!
    const exec6004Jobs = [...persistedJobs.values()].filter(
      (j) => Number(j.state.executionId) === 6004 && Number(j.state.nodeId) === 74,
    );
    expect(exec6004Jobs).toHaveLength(1);
    expect(exec6004Jobs[0].state.id).toBe('9001');
    expect(exec6004Jobs[0].state.status).toBe(JOB_STATUS.RESOLVED);
    expect(resumedByReconciler.filter((id) => id === '9001')).toHaveLength(1);

    // P2 #6: Interrupted starting task #956 whose daemon job #15 already finished preserves rcloneJobId=15 (not 0)!
    expect(tasksById[956].status).toBe('completed');
    expect(tasksById[956].rcloneJobId).toBe(15);
    expect((persistedJobs.get('8601')?.state.result as { rcloneJobId?: number }).rcloneJobId).toBe(15);
    expect((persistedJobs.get('8601')?.state.result as { rcloneExecuteId?: string }).rcloneExecuteId).toBe(
      'exec-r5-15',
    );

    // P2 #8: Firing executions.afterUpdate for finished executions evicts their entries from memoryDispatchRecords!
    const internalRecords = (
      reconciler as unknown as { memoryDispatchRecords: Map<string, { executionId: string; timestamp: number }> }
    ).memoryDispatchRecords;
    expect(internalRecords.size).toBeGreaterThan(0);
    const afterUpdateHook = dbListeners.get('executions.afterUpdate');
    expect(afterUpdateHook).toBeTypeOf('function');
    for (const finishedExecId of [6002, 6003, 6004, 6006]) {
      executionsById[finishedExecId].status = EXECUTION_STATUS.RESOLVED;
      afterUpdateHook?.({
        get: (k: string) => (k === 'id' ? finishedExecId : EXECUTION_STATUS.RESOLVED),
      } as unknown as Model);
    }
    expect(internalRecords.size).toBe(0);

    reconciler.stop();
  });

  it('prevents duplicate Create across crash and 2 local-lock SQLite workers, resumes Rclone alongside Parallel Delay, and retries orphan job after Redis error', async () => {
    let nextRcdJobId = 500;
    const finishedJobs = new Set<number>();
    const baseUrl = await startMockRcd((req, _body, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/config/listremotes') {
        res.end(JSON.stringify({ remotes: ['s3'] }));
        return;
      }
      if (req.url === '/config/dump') {
        res.end(JSON.stringify({ s3: { type: 's3' } }));
        return;
      }
      if (req.url === '/sync/copy') {
        const jid = ++nextRcdJobId;
        res.end(JSON.stringify({ jobid: jid, executeId: 'exec-r6-live' }));
        return;
      }
      if (req.url === '/job/status') {
        const jid = Number(_body.jobid);
        const done = finishedJobs.has(jid);
        res.end(
          JSON.stringify({
            id: jid,
            executeId: 'exec-r6-live',
            finished: done,
            success: done,
            duration: done ? 0.25 : 0,
            error: '',
          }),
        );
        return;
      }
      if (req.url === '/core/stats' || req.url === '/core/transferred') {
        res.end(JSON.stringify({ bytes: 256, totalBytes: 256, transferred: [] }));
        return;
      }
      if (req.url === '/job/list') {
        res.end(JSON.stringify({ executeId: 'exec-r6-live', jobids: [], runningIds: [], finishedIds: [] }));
        return;
      }
      res.end(JSON.stringify({}));
    });

    const sqlitePath = path.join(os.tmpdir(), `rclone-r6-shared-${crypto.randomUUID()}.sqlite`);
    const sharedPlugins: NonNullable<Parameters<typeof createMockServer>[0]>['plugins'] = [
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
      'workflow-parallel',
      [
        PluginRcloneManagerServer,
        {
          name: PLUGIN_NAME,
          packageName: PLUGIN_NAME,
          enabled: true,
          isPreset: true,
        },
      ],
    ];

    const defineAuditCollection = (app: MockServer) => {
      app.db.collection({
        name: 'rcloneAuditItems',
        autoGenId: true,
        fields: [
          { name: 'tag', type: 'string' },
          { name: 'note', type: 'string' },
        ],
      });
    };

    let workerA: MockServer | undefined;
    let workerB: MockServer | undefined;

    try {
      workerA = await createMockServer({
        skipSupervisor: true,
        name: 'r6_shared_app',
        instanceId: 1,
        acl: false,
        database: { dialect: 'sqlite', storage: sqlitePath, logging: false },
        plugins: sharedPlugins,
        beforeInstall: async (app) => {
          defineAuditCollection(app as MockServer);
        },
      });

      workerB = await createMockServer({
        skipSupervisor: true,
        skipInstall: true,
        skipStart: true,
        name: 'r6_shared_app',
        instanceId: 2,
        acl: false,
        database: { dialect: 'sqlite', storage: sqlitePath, logging: false },
        plugins: sharedPlugins,
      });
      defineAuditCollection(workerB);
      await workerB.runCommandThrowError('start');
      const appA = workerA;
      const appB = workerB;

      const pluginA = appA.pm.get(PLUGIN_NAME) as PluginRcloneManagerServer;
      const pluginB = appB.pm.get(PLUGIN_NAME) as PluginRcloneManagerServer;
      // Pause background auto-polling so test controls exact interleaving and crash points deterministically
      pluginA.reconciler.stop();
      pluginB.reconciler.stop();

      const conn = await workerA.db.getRepository(COLLECTIONS.connections).create({
        values: {
          name: 'r6-s3',
          baseUrl,
          authType: 'none',
          enabled: true,
        },
      });
      const connectionId = Number(conn.get('id'));

      const wfPluginA = appA.pm.get('workflow') as unknown as {
        trigger: (wf: Model, ctx: Record<string, unknown>) => void | Promise<unknown>;
        enabledCache: Map<number, Model>;
      };

      const createLinearRcloneCreateDelayWorkflow = async (tagValue: string) => {
        const wf = await appA.db.getRepository('workflows').create({
          values: {
            title: `R6 Linear ${tagValue}`,
            type: 'collection',
            enabled: true,
            config: { collection: 'users', mode: 1 },
          },
        });
        const wfId = Number(wf.get('id'));
        const nRclone = await appA.db.getRepository('flow_nodes').create({
          values: {
            workflowId: wfId,
            key: `rc_${tagValue}`,
            type: 'rclone-transfer',
            title: 'Rclone Copy',
            config: {
              connectionId,
              operation: 'sync/copy',
              srcFs: 's3:bucket-a',
              dstFs: 's3:bucket-b',
              failOnError: true,
            },
          },
        });
        const nCreate = await appA.db.getRepository('flow_nodes').create({
          values: {
            workflowId: wfId,
            upstreamId: nRclone.get('id'),
            key: `cr_${tagValue}`,
            type: 'create',
            title: 'Create Audit Item',
            config: {
              collection: 'rcloneAuditItems',
              params: { values: { tag: tagValue, note: 'from-rclone' } },
            },
          },
        });
        await nRclone.update({ downstreamId: nCreate.get('id') });
        const nDelay = await appA.db.getRepository('flow_nodes').create({
          values: {
            workflowId: wfId,
            upstreamId: nCreate.get('id'),
            key: `dl_${tagValue}`,
            type: 'delay',
            title: 'Wait 60s',
            config: { duration: 60, unit: 1_000, endStatus: JOB_STATUS.RESOLVED },
          },
        });
        await nCreate.update({ downstreamId: nDelay.get('id') });
        const reloadedWf = (await appA.db.getRepository('workflows').findOne({
          filterByTk: wfId,
          appends: ['nodes'],
        })) as Model;
        return {
          wf: reloadedWf,
          nRcloneId: Number(nRclone.get('id')),
          nCreateId: Number(nCreate.get('id')),
          nDelayId: Number(nDelay.get('id')),
        };
      };

      const waitForCondition = async (predicate: () => Promise<boolean>, timeoutMs = 6_000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (await predicate()) return;
          await sleep(40);
        }
        throw new Error('Timed out waiting for workflow condition');
      };

      // =========================================================================
      // Sub-case 1A (P1 #1 — Restart crash right after Create inserts business row
      // and BEFORE JobsModel.bulkCreate saves Create/Delay jobs):
      // =========================================================================
      const wfCrash = await createLinearRcloneCreateDelayWorkflow('crash_case');
      wfPluginA.trigger(wfCrash.wf, { data: { id: 1 } });

      await waitForCondition(async () => {
        const tasks = await appA.db.getRepository(COLLECTIONS.tasks).find({
          filter: { status: 'running' },
        });
        return tasks.length === 1;
      });
      const crashTask = (await workerA.db.getRepository(COLLECTIONS.tasks).findOne({
        filter: { status: 'running' },
      })) as Model;
      const crashExecId = Number(crashTask.get('executionId'));
      finishedJobs.add(Number(crashTask.get('rcloneJobId')));

      // Fault injection: abort inside JobsModel.bulkCreate right AFTER CreateInstruction inserted into rcloneAuditItems!
      const JobsModelA = workerA.db.getModel('jobs') as unknown as {
        bulkCreate: (...args: unknown[]) => Promise<unknown>;
      };
      const origBulkCreate = JobsModelA.bulkCreate.bind(JobsModelA);
      let failBulkCreateOnce = true;
      JobsModelA.bulkCreate = async (...args: unknown[]) => {
        const rows = args[0] as Array<{ nodeId?: number }>;
        if (failBulkCreateOnce && Array.isArray(rows) && rows.some((r) => Number(r.nodeId) === wfCrash.nCreateId)) {
          failBulkCreateOnce = false;
          throw new Error('SIMULATED_CRASH_AFTER_CREATE_BEFORE_JOB_SAVE');
        }
        return origBulkCreate(...args);
      };

      await pluginA.reconciler.reconcileOnce();
      await sleep(250);
      JobsModelA.bulkCreate = origBulkCreate;

      // Because Create + job persistence share one atomic DB transaction, the aborted attempt rolled back BOTH!
      const auditCountAfterCrash = await workerA.db
        .getRepository('rcloneAuditItems')
        .count({ filter: { tag: 'crash_case' } });
      const createJobsAfterCrash = await workerA.db
        .getRepository('jobs')
        .count({ filter: { executionId: crashExecId, nodeId: wfCrash.nCreateId } });
      expect(auditCountAfterCrash).toBe(0);
      expect(createJobsAfterCrash).toBe(0);

      // Simulate restart: Worker B reconciles the pending resume and runs Create -> Delay cleanly once!
      await pluginB.reconciler.reconcileOnce();
      await waitForCondition(async () => {
        const delayCount = await appB.db
          .getRepository('jobs')
          .count({ filter: { executionId: crashExecId, nodeId: wfCrash.nDelayId } });
        return delayCount >= 1;
      });

      expect(await workerB.db.getRepository('rcloneAuditItems').count({ filter: { tag: 'crash_case' } })).toBe(1);
      expect(
        await workerB.db
          .getRepository('jobs')
          .count({ filter: { executionId: crashExecId, nodeId: wfCrash.nCreateId } }),
      ).toBe(1);
      expect(
        await workerB.db
          .getRepository('jobs')
          .count({ filter: { executionId: crashExecId, nodeId: wfCrash.nDelayId } }),
      ).toBe(1);

      // =========================================================================
      // Sub-case 1B (P1 #1 — Two workers sharing SQLite with LocalLockManager
      // and MemoryEventQueueAdapter, with Worker A paused 120ms inside afterCreate):
      // =========================================================================
      const wfDual = await createLinearRcloneCreateDelayWorkflow('dual_worker');
      let slowOnce = true;
      const slowCreateHook = async (instance: Model) => {
        if (slowOnce && instance.get('tag') === 'dual_worker') {
          slowOnce = false;
          await sleep(120);
        }
      };
      workerA.db.on('rcloneAuditItems.afterCreate', slowCreateHook);

      wfPluginA.trigger(wfDual.wf, { data: { id: 2 } });
      await waitForCondition(async () => {
        const tasks = await appA.db.getRepository(COLLECTIONS.tasks).find({
          filter: { status: 'running' },
        });
        return tasks.length === 1;
      });
      const dualTask = (await workerA.db.getRepository(COLLECTIONS.tasks).findOne({
        filter: { status: 'running' },
      })) as Model;
      const dualExecId = Number(dualTask.get('executionId'));
      finishedJobs.add(Number(dualTask.get('rcloneJobId')));

      // Both Worker A and Worker B reconcile AND dispatch resume concurrently with only LocalLockManager!
      await Promise.all([pluginA.reconciler.reconcileOnce(), pluginB.reconciler.reconcileOnce()]);
      // Also trigger a second wave while Worker A / Worker B process the queue (simulating volatile-queue re-poll)
      await sleep(40);
      await Promise.all([pluginA.reconciler.reconcileOnce(), pluginB.reconciler.reconcileOnce()]);

      await waitForCondition(async () => {
        const delayCount = await appA.db
          .getRepository('jobs')
          .count({ filter: { executionId: dualExecId, nodeId: wfDual.nDelayId } });
        return delayCount >= 1;
      });
      await sleep(250);
      workerA.db.off('rcloneAuditItems.afterCreate', slowCreateHook);

      // Exact 1 / 1 / 1 on shared SQLite with LocalLockManager!
      expect(await workerA.db.getRepository('rcloneAuditItems').count({ filter: { tag: 'dual_worker' } })).toBe(1);
      expect(
        await workerA.db.getRepository('jobs').count({ filter: { executionId: dualExecId, nodeId: wfDual.nCreateId } }),
      ).toBe(1);
      expect(
        await workerA.db.getRepository('jobs').count({ filter: { executionId: dualExecId, nodeId: wfDual.nDelayId } }),
      ).toBe(1);

      // =========================================================================
      // Sub-case 2 (P1 #2 — Parallel (All) with Branch 0 = Rclone -> Create and
      // Branch 1 = Delay: sibling Delay PENDING must NOT suppress Rclone resume!):
      // =========================================================================
      const wfParallel = await workerA.db.getRepository('workflows').create({
        values: {
          title: 'R6 Parallel All',
          type: 'collection',
          enabled: true,
          config: { collection: 'users', mode: 1 },
        },
      });
      const parWfId = Number(wfParallel.get('id'));
      const nParallel = await workerA.db.getRepository('flow_nodes').create({
        values: {
          workflowId: parWfId,
          key: 'par_root',
          type: 'parallel',
          title: 'Parallel All',
          config: { mode: 'all' },
        },
      });
      const nParRclone = await workerA.db.getRepository('flow_nodes').create({
        values: {
          workflowId: parWfId,
          upstreamId: nParallel.get('id'),
          branchIndex: 0,
          key: 'par_b0_rclone',
          type: 'rclone-transfer',
          title: 'Branch 0 Rclone',
          config: {
            connectionId,
            operation: 'sync/copy',
            srcFs: 's3:par-src',
            dstFs: 's3:par-dst',
            failOnError: true,
          },
        },
      });
      const nParCreate = await workerA.db.getRepository('flow_nodes').create({
        values: {
          workflowId: parWfId,
          upstreamId: nParRclone.get('id'),
          key: 'par_b0_create',
          type: 'create',
          title: 'Branch 0 Create',
          config: {
            collection: 'rcloneAuditItems',
            params: { values: { tag: 'parallel_all', note: 'branch-0' } },
          },
        },
      });
      await nParRclone.update({ downstreamId: nParCreate.get('id') });
      await workerA.db.getRepository('flow_nodes').create({
        values: {
          workflowId: parWfId,
          upstreamId: nParallel.get('id'),
          branchIndex: 1,
          key: 'par_b1_delay',
          type: 'delay',
          title: 'Branch 1 Delay 1s',
          config: { duration: 1, unit: 1_000, endStatus: JOB_STATUS.RESOLVED },
        },
      });
      const reloadedParWf = (await workerA.db.getRepository('workflows').findOne({
        filterByTk: parWfId,
        appends: ['nodes'],
      })) as Model;

      wfPluginA.trigger(reloadedParWf, { data: { id: 3 } });
      await waitForCondition(async () => {
        const tasks = await appA.db.getRepository(COLLECTIONS.tasks).find({
          filter: { status: 'running' },
        });
        return tasks.length === 1;
      });
      const parTask = (await workerA.db.getRepository(COLLECTIONS.tasks).findOne({
        filter: { status: 'running' },
      })) as Model;
      const parExecId = Number(parTask.get('executionId'));

      // Complete Rclone immediately WHILE Branch 1 Delay (1000ms, higher Snowflake ID) is still PENDING!
      finishedJobs.add(Number(parTask.get('rcloneJobId')));
      await pluginA.reconciler.reconcileOnce();

      // Wait for both Branch 0 (Rclone -> Create) AND Branch 1 (Delay 1s) to join Parallel (All) -> RESOLVED!
      await waitForCondition(async () => {
        const exec = await appA.db.getRepository('executions').findOne({ filterByTk: parExecId });
        return Number(exec?.get('status')) === EXECUTION_STATUS.RESOLVED;
      }, 6_000);

      expect(await workerA.db.getRepository('rcloneAuditItems').count({ filter: { tag: 'parallel_all' } })).toBe(1);
      const finalParTask = await workerA.db.getRepository(COLLECTIONS.tasks).findOne({
        filterByTk: Number(parTask.get('id')),
      });
      expect(Boolean(finalParTask?.get('resumePending'))).toBe(false);

      // =========================================================================
      // Sub-case 3 (P2 #3 — Orphan workflow job with deleted task row retries
      // across RedisEventQueueAdapter publish failures until Redis confirms):
      // =========================================================================
      class RedisEventQueueAdapterStub {}
      const origEventQueue = workerA.eventQueue;
      const realPublish = origEventQueue.publish.bind(origEventQueue);
      let redisOffline = false;
      let redisPublishAttempts = 0;
      let redisAcceptedDeliveries = 0;

      (workerA as unknown as { eventQueue: unknown }).eventQueue = {
        adapter: new RedisEventQueueAdapterStub(),
        publish: async (channel: string, message: unknown, pubOpts?: unknown) => {
          const isResumeTask = Boolean(
            message && typeof message === 'object' && 'jobId' in message && message.jobId != null,
          );
          if (isResumeTask) {
            redisPublishAttempts += 1;
          }
          if (redisOffline) {
            throw new Error('ECONNREFUSED 127.0.0.1:6379');
          }
          if (isResumeTask) {
            redisAcceptedDeliveries += 1;
          }
          return realPublish(channel, message, pubOpts as never);
        },
        subscribe: origEventQueue.subscribe.bind(origEventQueue),
      };

      try {
        wfPluginA.trigger(wfCrash.wf, { data: { id: 4 } });
        await waitForCondition(async () => {
          const tasks = await appA.db.getRepository(COLLECTIONS.tasks).find({
            filter: { status: 'running' },
          });
          return tasks.length === 1;
        });
        const orphanTask = (await workerA.db.getRepository(COLLECTIONS.tasks).findOne({
          filter: { status: 'running' },
        })) as Model;
        const orphanTaskId = Number(orphanTask.get('id'));
        const orphanWfJobId = String(orphanTask.get('workflowJobId'));
        const orphanExecId = Number(orphanTask.get('executionId'));

        // Delete the linked rcloneTransferTasks row and take Redis offline right before reconciler runs
        await workerA.db.getRepository(COLLECTIONS.tasks).destroy({ filterByTk: orphanTaskId });
        redisOffline = true;

        // Tick 1 (Redis offline): job transitions PENDING -> FAILED with orphanResumePending=true; publish throws
        await pluginA.reconciler.reconcileOnce();
        const jobAfterTick1 = await workerA.db.getRepository('jobs').findOne({ filterByTk: orphanWfJobId });
        expect(Number(jobAfterTick1?.get('status'))).toBe(JOB_STATUS.FAILED);
        expect((jobAfterTick1?.get('meta') as Record<string, unknown>)?.orphanResumePending).toBe(true);
        expect(redisPublishAttempts).toBe(1);

        // Tick 2 (Redis still offline): settledStartedJobs STILL finds orphanWfJob and retries!
        await pluginA.reconciler.reconcileOnce();
        expect(redisPublishAttempts).toBe(2);

        // Tick 3 (Redis back online!): publish succeeds, execution transitions STARTED -> FAILED, flag clears!
        redisOffline = false;
        await pluginA.reconciler.reconcileOnce();
        await waitForCondition(async () => {
          const exec = await appA.db.getRepository('executions').findOne({ filterByTk: orphanExecId });
          return Number(exec?.get('status')) === EXECUTION_STATUS.FAILED;
        });

        expect(redisPublishAttempts).toBe(3);
        expect(redisAcceptedDeliveries).toBe(1);
        const jobAfterTick3 = await workerA.db.getRepository('jobs').findOne({ filterByTk: orphanWfJobId });
        expect((jobAfterTick3?.get('meta') as Record<string, unknown>)?.orphanResumePending).toBe(false);

        // Tick 4: No duplicate Redis publish now that execution is FAILED and orphanResumePending=false!
        await pluginA.reconciler.reconcileOnce();
        expect(redisAcceptedDeliveries).toBe(1);
      } finally {
        (workerA as unknown as { eventQueue: unknown }).eventQueue = origEventQueue;
      }
    } finally {
      if (workerB) {
        await workerB.stop().catch(() => {});
      }
      if (workerA) {
        await workerA.stop().catch(() => {});
      }
      await fs.rm(sqlitePath, { force: true }).catch(() => {});
    }
  }, 30_000);

  it('handles Rclone -> Output without self-lock, Parallel branch ending at Rclone, restart before chained Rclone2, secondary data source Create rollback, Redis rollback re-arm, and isolated Delay timer cleanup', async () => {
    let nextRcdJobId = 900;
    const finishedJobs = new Set<number>();
    let abortNextSecondRcloneDispatch = false;

    const baseUrl = await startMockRcd((req, body, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/config/listremotes') {
        res.end(JSON.stringify({ remotes: ['s3'] }));
        return;
      }
      if (req.url === '/config/dump') {
        res.end(JSON.stringify({ s3: { type: 's3' } }));
        return;
      }
      if (req.url === '/sync/copy') {
        const jid = ++nextRcdJobId;
        res.end(JSON.stringify({ jobid: jid, executeId: 'exec-r7-live' }));
        return;
      }
      if (req.url === '/job/status') {
        const jid = Number(body.jobid);
        const done = finishedJobs.has(jid);
        res.end(
          JSON.stringify({
            id: jid,
            executeId: 'exec-r7-live',
            finished: done,
            success: done,
            duration: done ? 0.2 : 0,
            error: '',
          }),
        );
        return;
      }
      if (req.url === '/core/stats' || req.url === '/core/transferred') {
        res.end(JSON.stringify({ bytes: 128, totalBytes: 128, transferred: [] }));
        return;
      }
      if (req.url === '/job/list') {
        res.end(JSON.stringify({ executeId: 'exec-r7-live', jobids: [], runningIds: [], finishedIds: [] }));
        return;
      }
      res.end(JSON.stringify({}));
    });

    const mainSqlitePath = path.join(os.tmpdir(), `rclone-r7-main-${crypto.randomUUID()}.sqlite`);
    const ds2SqlitePath = path.join(os.tmpdir(), `rclone-r7-ds2-${crypto.randomUUID()}.sqlite`);

    let app: MockServer | undefined;
    let ds2: SequelizeDataSource | undefined;

    try {
      app = await createMockServer({
        skipSupervisor: true,
        name: 'r7_app',
        acl: false,
        database: { dialect: 'sqlite', storage: mainSqlitePath, logging: false },
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
          'workflow-parallel',
          [
            PluginRcloneManagerServer,
            {
              name: PLUGIN_NAME,
              packageName: PLUGIN_NAME,
              enabled: true,
              isPreset: true,
            },
          ],
        ],
        beforeInstall: async (srv) => {
          srv.db.collection({
            name: 'r7MainItems',
            autoGenId: true,
            fields: [{ name: 'tag', type: 'string' }],
          });
        },
      });
      const srv = app;

      // Register real secondary SQLite SequelizeDataSource ('ds2')
      ds2 = new SequelizeDataSource({
        name: 'ds2',
        displayName: 'Secondary SQLite DS2',
        collectionManager: {
          dialect: 'sqlite',
          storage: ds2SqlitePath,
          logging: false,
        },
      });
      ds2.collectionManager.db.collection({
        name: 'ds2Items',
        autoGenId: true,
        fields: [{ name: 'tag', type: 'string' }],
      });
      await ds2.collectionManager.sync();
      await srv.dataSourceManager.add(ds2);
      const ds2Instance = ds2;

      const plugin = srv.pm.get(PLUGIN_NAME) as PluginRcloneManagerServer;
      plugin.reconciler.stop();

      const conn = await srv.db.getRepository(COLLECTIONS.connections).create({
        values: {
          name: 'r7-s3',
          baseUrl,
          authType: 'none',
          enabled: true,
        },
      });
      const connectionId = Number(conn.get('id'));

      const wfPlugin = srv.pm.get('workflow') as unknown as {
        trigger: (wf: Model, ctx: Record<string, unknown>) => void | Promise<unknown>;
        instructions: { get: (name: string) => unknown };
      };

      const waitForCondition = async (predicate: () => Promise<boolean>, timeoutMs = 6_000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (await predicate()) return;
          await sleep(35);
        }
        throw new Error('Timed out waiting for R7 workflow condition');
      };

      // =========================================================================
      // 1. P1 #1: Rclone -> Output completes cleanly without self-blocking on executions!
      // =========================================================================
      const wfOutput = await srv.db.getRepository('workflows').create({
        values: {
          title: 'R7 Rclone Output',
          type: 'collection',
          enabled: true,
          config: { collection: 'users', mode: 1 },
        },
      });
      const outWfId = Number(wfOutput.get('id'));
      const nOutRclone = await srv.db.getRepository('flow_nodes').create({
        values: {
          workflowId: outWfId,
          key: 'r7_out_rc',
          type: 'rclone-transfer',
          title: 'Copy',
          config: {
            connectionId,
            operation: 'sync/copy',
            srcFs: 's3:in',
            dstFs: 's3:out',
            failOnError: true,
          },
        },
      });
      const nOutput = await srv.db.getRepository('flow_nodes').create({
        values: {
          workflowId: outWfId,
          upstreamId: nOutRclone.get('id'),
          key: 'r7_output_node',
          type: 'output',
          title: 'Output Result',
          config: { value: { status: 'archived', bucket: 's3:out' } },
        },
      });
      await nOutRclone.update({ downstreamId: nOutput.get('id') });
      const reloadedOutWf = (await srv.db.getRepository('workflows').findOne({
        filterByTk: outWfId,
        appends: ['nodes'],
      })) as Model;

      wfPlugin.trigger(reloadedOutWf, { data: { id: 10 } });
      await waitForCondition(async () => {
        const rows = await srv.db.getRepository(COLLECTIONS.tasks).find({ filter: { status: 'running' } });
        return rows.length === 1;
      });
      const outTask = (await srv.db.getRepository(COLLECTIONS.tasks).findOne({
        filter: { status: 'running' },
      })) as Model;
      const outExecId = Number(outTask.get('executionId'));
      finishedJobs.add(Number(outTask.get('rcloneJobId')));

      await plugin.reconciler.reconcileOnce();
      await waitForCondition(async () => {
        const exec = await srv.db.getRepository('executions').findOne({ filterByTk: outExecId });
        return Number(exec?.get('status')) === EXECUTION_STATUS.RESOLVED;
      });
      const finishedOutExec = await srv.db.getRepository('executions').findOne({ filterByTk: outExecId });
      expect(finishedOutExec?.get('output')).toEqual({ status: 'archived', bucket: 's3:out' });

      // =========================================================================
      // 2. P1 #2: Parallel (All) where Branch 0 ENDS directly at Rclone (no child node!)
      //    alongside Branch 1 Delay: parallelJob.result[0] starts at 0 (PENDING) and MUST
      //    NOT trick continuation-tracker into skipping Rclone resume!
      // =========================================================================
      const wfParTail = await srv.db.getRepository('workflows').create({
        values: {
          title: 'R7 Parallel Rclone Leaf',
          type: 'collection',
          enabled: true,
          config: { collection: 'users', mode: 1 },
        },
      });
      const parTailWfId = Number(wfParTail.get('id'));
      const nParRoot = await srv.db.getRepository('flow_nodes').create({
        values: {
          workflowId: parTailWfId,
          key: 'r7_par',
          type: 'parallel',
          title: 'Parallel All',
          config: { mode: 'all' },
        },
      });
      await srv.db.getRepository('flow_nodes').create({
        values: {
          workflowId: parTailWfId,
          upstreamId: nParRoot.get('id'),
          branchIndex: 0,
          key: 'r7_par_b0_leaf_rclone',
          type: 'rclone-transfer',
          title: 'Leaf Rclone',
          config: {
            connectionId,
            operation: 'sync/copy',
            srcFs: 's3:leaf-a',
            dstFs: 's3:leaf-b',
            failOnError: true,
          },
        },
      });
      await srv.db.getRepository('flow_nodes').create({
        values: {
          workflowId: parTailWfId,
          upstreamId: nParRoot.get('id'),
          branchIndex: 1,
          key: 'r7_par_b1_delay',
          type: 'delay',
          title: 'Branch 1 Delay 1s',
          config: { duration: 1, unit: 1_000, endStatus: JOB_STATUS.RESOLVED },
        },
      });
      const reloadedParTailWf = (await srv.db.getRepository('workflows').findOne({
        filterByTk: parTailWfId,
        appends: ['nodes'],
      })) as Model;

      wfPlugin.trigger(reloadedParTailWf, { data: { id: 20 } });
      await waitForCondition(async () => {
        const rows = await srv.db.getRepository(COLLECTIONS.tasks).find({ filter: { status: 'running' } });
        return rows.length === 1;
      });
      const parLeafTask = (await srv.db.getRepository(COLLECTIONS.tasks).findOne({
        filter: { status: 'running' },
      })) as Model;
      const parLeafExecId = Number(parLeafTask.get('executionId'));

      // Verify Parallel.run() indeed initialized parallelJob.result[0] = 0 (JOB_STATUS.PENDING, not null)!
      const parRootJobBefore = await srv.db.getRepository('jobs').findOne({
        filter: { executionId: parLeafExecId, nodeId: nParRoot.get('id') },
      });
      expect((parRootJobBefore?.get('result') as unknown[])?.[0]).toBe(JOB_STATUS.PENDING);

      finishedJobs.add(Number(parLeafTask.get('rcloneJobId')));
      await plugin.reconciler.reconcileOnce();

      await waitForCondition(async () => {
        const exec = await srv.db.getRepository('executions').findOne({ filterByTk: parLeafExecId });
        return Number(exec?.get('status')) === EXECUTION_STATUS.RESOLVED;
      }, 6_000);

      // =========================================================================
      // 3. P1 #4 & P2 #6: Secondary data source ('ds2:ds2Items') Create rolls back
      //    together with main jobs on crash BEFORE job save, AND rollback of Execution A
      //    does NOT cancel Execution B's active Delay timer!
      // =========================================================================
      // Start Execution B: Delay(1s) -> Create('r7MainItems', tag='other_exec_timer')
      const wfOtherDelay = await srv.db.getRepository('workflows').create({
        values: {
          title: 'R7 Unrelated Delay Exec',
          type: 'collection',
          enabled: true,
          config: { collection: 'users', mode: 1 },
        },
      });
      const otherWfId = Number(wfOtherDelay.get('id'));
      const nOtherDelay = await srv.db.getRepository('flow_nodes').create({
        values: {
          workflowId: otherWfId,
          key: 'r7_other_dl',
          type: 'delay',
          title: 'Delay 1s',
          config: { duration: 1, unit: 1_000, endStatus: JOB_STATUS.RESOLVED },
        },
      });
      const nOtherCreate = await srv.db.getRepository('flow_nodes').create({
        values: {
          workflowId: otherWfId,
          upstreamId: nOtherDelay.get('id'),
          key: 'r7_other_cr',
          type: 'create',
          title: 'Create After Delay',
          config: {
            collection: 'r7MainItems',
            params: { values: { tag: 'other_exec_timer' } },
          },
        },
      });
      await nOtherDelay.update({ downstreamId: nOtherCreate.get('id') });
      const reloadedOtherWf = (await srv.db.getRepository('workflows').findOne({
        filterByTk: otherWfId,
        appends: ['nodes'],
      })) as Model;

      // Build Execution A: Rclone -> Create('ds2:ds2Items') -> Delay(60s)
      const wfDs2 = await srv.db.getRepository('workflows').create({
        values: {
          title: 'R7 DS2 Create',
          type: 'collection',
          enabled: true,
          config: { collection: 'users', mode: 1 },
        },
      });
      const ds2WfId = Number(wfDs2.get('id'));
      const nDs2Rclone = await srv.db.getRepository('flow_nodes').create({
        values: {
          workflowId: ds2WfId,
          key: 'r7_ds2_rc',
          type: 'rclone-transfer',
          title: 'Copy DS2',
          config: {
            connectionId,
            operation: 'sync/copy',
            srcFs: 's3:ds2-src',
            dstFs: 's3:ds2-dst',
            failOnError: true,
          },
        },
      });
      const nDs2Create = await srv.db.getRepository('flow_nodes').create({
        values: {
          workflowId: ds2WfId,
          upstreamId: nDs2Rclone.get('id'),
          key: 'r7_ds2_cr',
          type: 'create',
          title: 'Create in DS2',
          config: {
            collection: 'ds2:ds2Items',
            params: { values: { tag: 'ds2_once' } },
          },
        },
      });
      await nDs2Rclone.update({ downstreamId: nDs2Create.get('id') });
      const nDs2Delay = await srv.db.getRepository('flow_nodes').create({
        values: {
          workflowId: ds2WfId,
          upstreamId: nDs2Create.get('id'),
          key: 'r7_ds2_dl',
          type: 'delay',
          title: 'Delay 60s',
          config: { duration: 60, unit: 1_000, endStatus: JOB_STATUS.RESOLVED },
        },
      });
      await nDs2Create.update({ downstreamId: nDs2Delay.get('id') });
      const reloadedDs2Wf = (await srv.db.getRepository('workflows').findOne({
        filterByTk: ds2WfId,
        appends: ['nodes'],
      })) as Model;

      wfPlugin.trigger(reloadedDs2Wf, { data: { id: 30 } });
      await waitForCondition(async () => {
        const rows = await srv.db.getRepository(COLLECTIONS.tasks).find({ filter: { status: 'running' } });
        return rows.length === 1;
      });
      const ds2Task = (await srv.db.getRepository(COLLECTIONS.tasks).findOne({
        filter: { status: 'running' },
      })) as Model;
      const ds2ExecId = Number(ds2Task.get('executionId'));
      finishedJobs.add(Number(ds2Task.get('rcloneJobId')));

      const JobsModel = srv.db.getModel('jobs') as unknown as {
        bulkCreate: (...args: unknown[]) => Promise<unknown>;
      };
      const origBulkCreate = JobsModel.bulkCreate.bind(JobsModel);
      let failDs2BulkOnce = true;
      JobsModel.bulkCreate = async (...args: unknown[]) => {
        const rows = args[0] as Array<{ nodeId?: number }>;
        if (
          failDs2BulkOnce &&
          Array.isArray(rows) &&
          rows.some((r) => Number(r.nodeId) === Number(nDs2Create.get('id')))
        ) {
          failDs2BulkOnce = false;
          throw new Error('SIMULATED_CRASH_BEFORE_MAIN_JOB_BULK_CREATE');
        }
        return origBulkCreate(...args);
      };

      // Trigger Execution B right as Execution A resumes & rolls back so Execution B's Delay(1s) timer is live!
      wfPlugin.trigger(reloadedOtherWf, { data: { id: 31 } });
      await waitForCondition(async () => {
        const cnt = await srv.db.getRepository('jobs').count({ filter: { nodeId: nOtherDelay.get('id') } });
        return cnt >= 1;
      });

      await plugin.reconciler.reconcileOnce();
      await sleep(250);
      JobsModel.bulkCreate = origBulkCreate;

      // Secondary SQLite DS2 MUST have 0 rows after the rolled-back crash!
      const ds2Repo = ds2Instance.collectionManager.getRepository('ds2Items');
      expect(await ds2Repo.count({ filter: { tag: 'ds2_once' } })).toBe(0);

      // P2 #6: Execution B's 1s Delay timer MUST NOT have been cancelled by Execution A's rollback!
      await waitForCondition(async () => {
        const cnt = await srv.db.getRepository('r7MainItems').count({ filter: { tag: 'other_exec_timer' } });
        return cnt === 1;
      }, 4_000);

      // Recover Execution A -> DS2 gets exactly 1 row (never 2)!
      plugin.reconciler.clearDispatchThrottle(String(ds2Task.get('workflowJobId')));
      await plugin.reconciler.reconcileOnce();
      await waitForCondition(async () => {
        const cnt = await srv.db
          .getRepository('jobs')
          .count({ filter: { executionId: ds2ExecId, nodeId: nDs2Delay.get('id') } });
        return cnt >= 1;
      });
      expect(await ds2Repo.count({ filter: { tag: 'ds2_once' } })).toBe(1);

      // =========================================================================
      // 4. P1 #5 & P1 #3 (with RedisEventQueueAdapter!):
      //    - P1 #5: Redis already accepted resume (reconciler cleared resumePending=false),
      //      then resume() rolls back -> catch re-arms resumePending=true and retries!
      //    - P1 #3: Rclone1 -> Create -> Rclone2 crashes right after handoff commit BEFORE
      //      Rclone2 creates its task/job row -> resumePending stays true on Redis, restart
      //      skips Create (1 row!) and launches Rclone2 to completion!
      // =========================================================================
      class RedisAdapterStub {}
      const origEventQueue = srv.eventQueue;
      const realPublish = origEventQueue.publish.bind(origEventQueue);
      (srv as unknown as { eventQueue: unknown }).eventQueue = {
        adapter: new RedisAdapterStub(),
        publish: (ch: string, msg: unknown, opts?: unknown) => realPublish(ch, msg, opts as never),
        subscribe: origEventQueue.subscribe.bind(origEventQueue),
      };

      try {
        const wfChain = await srv.db.getRepository('workflows').create({
          values: {
            title: 'R7 Chain Rclone1 Create Rclone2',
            type: 'collection',
            enabled: true,
            config: { collection: 'users', mode: 1 },
          },
        });
        const chainWfId = Number(wfChain.get('id'));
        const nChainRc1 = await srv.db.getRepository('flow_nodes').create({
          values: {
            workflowId: chainWfId,
            key: 'r7_chain_rc1',
            type: 'rclone-transfer',
            title: 'Rclone 1',
            config: {
              connectionId,
              operation: 'sync/copy',
              srcFs: 's3:step1-a',
              dstFs: 's3:step1-b',
              failOnError: true,
            },
          },
        });
        const nChainCreate = await srv.db.getRepository('flow_nodes').create({
          values: {
            workflowId: chainWfId,
            upstreamId: nChainRc1.get('id'),
            key: 'r7_chain_cr',
            type: 'create',
            title: 'Create Between Rclones',
            config: {
              collection: 'r7MainItems',
              params: { values: { tag: 'chain_once' } },
            },
          },
        });
        await nChainRc1.update({ downstreamId: nChainCreate.get('id') });
        const nChainRc2 = await srv.db.getRepository('flow_nodes').create({
          values: {
            workflowId: chainWfId,
            upstreamId: nChainCreate.get('id'),
            key: 'r7_chain_rc2',
            type: 'rclone-transfer',
            title: 'Rclone 2',
            config: {
              connectionId,
              operation: 'sync/copy',
              srcFs: 's3:step2-a',
              dstFs: 's3:step2-b',
              failOnError: true,
            },
          },
        });
        await nChainCreate.update({ downstreamId: nChainRc2.get('id') });
        const reloadedChainWf = (await srv.db.getRepository('workflows').findOne({
          filterByTk: chainWfId,
          appends: ['nodes'],
        })) as Model;

        wfPlugin.trigger(reloadedChainWf, { data: { id: 40 } });
        await waitForCondition(async () => {
          const rows = await srv.db.getRepository(COLLECTIONS.tasks).find({ filter: { status: 'running' } });
          return rows.length === 1;
        });
        const rc1Task = (await srv.db.getRepository(COLLECTIONS.tasks).findOne({
          filter: { status: 'running' },
        })) as Model;
        const rc1TaskId = Number(rc1Task.get('id'));
        const chainExecId = Number(rc1Task.get('executionId'));
        finishedJobs.add(Number(rc1Task.get('rcloneJobId')));

        // Step A (P1 #5): Redis accepts resume (reconciler sets resumePending=false), then JobsModel.bulkCreate fails!
        let failRedisRollbackOnce = true;
        JobsModel.bulkCreate = async (...args: unknown[]) => {
          const rows = args[0] as Array<{ nodeId?: number }>;
          if (
            failRedisRollbackOnce &&
            Array.isArray(rows) &&
            rows.some((r) => Number(r.nodeId) === Number(nChainCreate.get('id')))
          ) {
            failRedisRollbackOnce = false;
            throw new Error('SIMULATED_REDIS_DELIVERY_DB_ROLLBACK');
          }
          return origBulkCreate(...args);
        };

        await plugin.reconciler.reconcileOnce();
        await sleep(250);
        JobsModel.bulkCreate = origBulkCreate;

        // Rollback MUST have re-armed resumePending=true in DB even though RedisEventQueueAdapter was used!
        const rc1AfterRollback = await srv.db.getRepository(COLLECTIONS.tasks).findOne({ filterByTk: rc1TaskId });
        expect(Boolean(rc1AfterRollback?.get('resumePending'))).toBe(true);
        expect(await srv.db.getRepository('r7MainItems').count({ filter: { tag: 'chain_once' } })).toBe(0);

        // Step B (P1 #3): Next attempt commits Create + createJob at handoff, then SIGKILL strikes BEFORE Rclone2.run()!
        const rcloneInstr = wfPlugin.instructions.get('rclone-transfer') as RcloneTransferInstruction;
        const origRcloneRun = rcloneInstr.run.bind(rcloneInstr);
        abortNextSecondRcloneDispatch = true;
        // Simulate process killed immediately upon entering Rclone2 (before Rclone2 creates task/job row):
        rcloneInstr.run = (async (nodeArg: FlowNodeModel, prevJobArg: JobModel, procArg: Processor) => {
          if (abortNextSecondRcloneDispatch && Number(nodeArg.id) === Number(nChainRc2.get('id'))) {
            abortNextSecondRcloneDispatch = false;
            // Emulate sudden process death before Processor.exec can write an ERROR job for Rclone2
            procArg.exit = (async () => null) as typeof procArg.exit;
            throw new Error('SIMULATED_SIGKILL_BEFORE_RCLONE2_CREATED');
          }
          return origRcloneRun(nodeArg, prevJobArg, procArg);
        }) as typeof rcloneInstr.run;

        await plugin.reconciler.reconcileOnce();
        await sleep(250);
        rcloneInstr.run = origRcloneRun;

        // Create committed 1 row, Rclone2 has 0 jobs yet, AND rc1Task.resumePending MUST still be true!
        expect(await srv.db.getRepository('r7MainItems').count({ filter: { tag: 'chain_once' } })).toBe(1);
        expect(
          await srv.db
            .getRepository('jobs')
            .count({ filter: { executionId: chainExecId, nodeId: nChainRc2.get('id') } }),
        ).toBe(0);
        const rc1AfterHandoffKill = await srv.db.getRepository(COLLECTIONS.tasks).findOne({ filterByTk: rc1TaskId });
        expect(Boolean(rc1AfterHandoffKill?.get('resumePending'))).toBe(true);

        // Restarted reconciler re-publishes rc1Task, SKIPS Create (still 1 row!), and launches Rclone2!
        await plugin.reconciler.reconcileOnce();
        await waitForCondition(async () => {
          const running = await srv.db.getRepository(COLLECTIONS.tasks).find({ filter: { status: 'running' } });
          return running.length === 1;
        });
        const rc2Task = (await srv.db.getRepository(COLLECTIONS.tasks).findOne({
          filter: { status: 'running' },
        })) as Model;
        finishedJobs.add(Number(rc2Task.get('rcloneJobId')));

        await plugin.reconciler.reconcileOnce();
        await waitForCondition(async () => {
          const exec = await srv.db.getRepository('executions').findOne({ filterByTk: chainExecId });
          return Number(exec?.get('status')) === EXECUTION_STATUS.RESOLVED;
        });

        // Create ran ONCE total across both crashes, and the full Rclone1 -> Create -> Rclone2 chain RESOLVED!
        expect(await srv.db.getRepository('r7MainItems').count({ filter: { tag: 'chain_once' } })).toBe(1);
      } finally {
        (srv as unknown as { eventQueue: unknown }).eventQueue = origEventQueue;
      }
    } finally {
      if (ds2) {
        await ds2.collectionManager.db.close().catch(() => {});
      }
      if (app) {
        await app.stop().catch(() => {});
      }
      await fs.rm(mainSqlitePath, { force: true }).catch(() => {});
      await fs.rm(ds2SqlitePath, { force: true }).catch(() => {});
    }
  }, 35_000);

  it('prevents ds2 duplicate on stop between ds2 commit and main commit, keeps Output -> Create -> Delay once across crash and 2 local-lock workers, preserves Redis retry flag across consumer rollback race, and protects settled Rclone job under SQLite write locks', async () => {
    let nextRcdJobId = 1200;
    const finishedJobs = new Set<number>();

    const baseUrl = await startMockRcd((req, body, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/config/listremotes') {
        res.end(JSON.stringify({ remotes: ['s3'] }));
        return;
      }
      if (req.url === '/config/dump') {
        res.end(JSON.stringify({ s3: { type: 's3' } }));
        return;
      }
      if (req.url === '/sync/copy') {
        const jid = ++nextRcdJobId;
        res.end(JSON.stringify({ jobid: jid, executeId: 'exec-r8-live' }));
        return;
      }
      if (req.url === '/job/status') {
        const jid = Number(body.jobid);
        const done = finishedJobs.has(jid);
        res.end(
          JSON.stringify({
            id: jid,
            executeId: 'exec-r8-live',
            finished: done,
            success: done,
            duration: done ? 0.2 : 0,
            error: '',
          }),
        );
        return;
      }
      if (req.url === '/core/stats' || req.url === '/core/transferred') {
        res.end(JSON.stringify({ bytes: 256, totalBytes: 256, transferred: [] }));
        return;
      }
      if (req.url === '/job/list') {
        res.end(JSON.stringify({ executeId: 'exec-r8-live', jobids: [], runningIds: [], finishedIds: [] }));
        return;
      }
      res.end(JSON.stringify({}));
    });

    const mainSqlitePath = path.join(os.tmpdir(), `rclone-r8-main-${crypto.randomUUID()}.sqlite`);
    const ds2SqlitePath = path.join(os.tmpdir(), `rclone-r8-ds2-${crypto.randomUUID()}.sqlite`);

    let app: MockServer | undefined;
    let ds2: SequelizeDataSource | undefined;
    let externalLockDs: SequelizeDataSource | undefined;

    try {
      app = await createMockServer({
        skipSupervisor: true,
        name: 'r8_app',
        acl: false,
        database: { dialect: 'sqlite', storage: mainSqlitePath, logging: false },
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
          'workflow-parallel',
          [
            PluginRcloneManagerServer,
            {
              name: PLUGIN_NAME,
              packageName: PLUGIN_NAME,
              enabled: true,
              isPreset: true,
            },
          ],
        ],
        beforeInstall: async (srv) => {
          srv.db.collection({
            name: 'r8MainItems',
            autoGenId: true,
            fields: [{ name: 'tag', type: 'string' }],
          });
        },
      });
      const srv = app;

      ds2 = new SequelizeDataSource({
        name: 'ds2',
        displayName: 'Secondary SQLite DS2 R8',
        collectionManager: {
          dialect: 'sqlite',
          storage: ds2SqlitePath,
          logging: false,
        },
      });
      ds2.collectionManager.db.collection({
        name: 'ds2Items',
        autoGenId: true,
        fields: [{ name: 'tag', type: 'string' }],
      });
      await ds2.collectionManager.sync();
      await srv.dataSourceManager.add(ds2);
      const ds2Repo = ds2.collectionManager.getRepository('ds2Items');

      const plugin = srv.pm.get(PLUGIN_NAME) as PluginRcloneManagerServer;
      plugin.reconciler.stop();

      const conn = await srv.db.getRepository(COLLECTIONS.connections).create({
        values: {
          name: 'r8-s3',
          baseUrl,
          authType: 'none',
          enabled: true,
        },
      });
      const connectionId = Number(conn.get('id'));

      const wfPlugin = srv.pm.get('workflow') as unknown as {
        trigger: (wf: Model, ctx: Record<string, unknown>) => void | Promise<unknown>;
        createProcessor: (exec: Model) => Processor;
        instructions: { get: (name: string) => unknown };
      };

      const waitForCondition = async (predicate: () => Promise<boolean>, timeoutMs = 8_000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (await predicate()) return;
          await sleep(35);
        }
        throw new Error('Timed out waiting for R8 workflow condition');
      };

      // =========================================================================
      // Finding 1: Worker stops AFTER ds2 commits and BEFORE main DB commits!
      //            After restart, ds2 MUST have 1 row (never 2) for 1 Create job.
      // =========================================================================
      const wfDs2Split = await srv.db.getRepository('workflows').create({
        values: {
          title: 'R8 DS2 Post-Commit Crash',
          type: 'collection',
          enabled: true,
          config: { collection: 'users', mode: 1 },
        },
      });
      const ds2WfId = Number(wfDs2Split.get('id'));
      const nDs2Rc = await srv.db.getRepository('flow_nodes').create({
        values: {
          workflowId: ds2WfId,
          key: 'r8_ds2_rc',
          type: 'rclone-transfer',
          title: 'Copy',
          config: {
            connectionId,
            operation: 'sync/copy',
            srcFs: 's3:a',
            dstFs: 's3:b',
            failOnError: true,
          },
        },
      });
      const nDs2Cr = await srv.db.getRepository('flow_nodes').create({
        values: {
          workflowId: ds2WfId,
          upstreamId: nDs2Rc.get('id'),
          key: 'r8_ds2_cr',
          type: 'create',
          title: 'Create DS2',
          config: {
            collection: 'ds2:ds2Items',
            params: { values: { tag: 'ds2_split_once' } },
          },
        },
      });
      await nDs2Rc.update({ downstreamId: nDs2Cr.get('id') });
      const reloadedDs2Wf = (await srv.db.getRepository('workflows').findOne({
        filterByTk: ds2WfId,
        appends: ['nodes'],
      })) as Model;

      wfPlugin.trigger(reloadedDs2Wf, { data: { id: 1 } });
      await waitForCondition(async () => {
        const running = await srv.db.getRepository(COLLECTIONS.tasks).find({ filter: { status: 'running' } });
        return running.length === 1;
      });
      const ds2Task = (await srv.db.getRepository(COLLECTIONS.tasks).findOne({
        filter: { status: 'running' },
      })) as Model;
      const ds2ExecId = Number(ds2Task.get('executionId'));
      finishedJobs.add(Number(ds2Task.get('rcloneJobId')));

      // Intercept main DB transaction commit ONLY AFTER ds2 has already durably committed 1 row!
      const mainSeq = srv.db.sequelize as unknown as {
        transaction: (opts?: Record<string, unknown>) => Promise<{
          commit: () => Promise<void>;
          rollback: () => Promise<void>;
        }>;
      };
      const origMainTx = mainSeq.transaction.bind(mainSeq);
      let abortMainCommitAfterDs2Once = true;
      mainSeq.transaction = async (opts?: Record<string, unknown>) => {
        const tx = await origMainTx(opts);
        if (abortMainCommitAfterDs2Once && opts?.type === 'IMMEDIATE') {
          const realCommit = tx.commit.bind(tx);
          tx.commit = async () => {
            if (abortMainCommitAfterDs2Once && (await ds2Repo.count({ filter: { tag: 'ds2_split_once' } })) === 1) {
              abortMainCommitAfterDs2Once = false;
              await tx.rollback();
              throw new Error('SIMULATED_WORKER_STOP_AFTER_DS2_COMMIT_BEFORE_MAIN_COMMIT');
            }
            return realCommit();
          };
        }
        return tx;
      };

      await plugin.reconciler.reconcileOnce();
      await sleep(250);
      mainSeq.transaction = origMainTx;

      // Confirm exact split-commit state: ds2 ALREADY committed 1 row, while main DB rolled back Create job!
      expect(await ds2Repo.count({ filter: { tag: 'ds2_split_once' } })).toBe(1);
      expect(
        await srv.db.getRepository('jobs').count({ filter: { executionId: ds2ExecId, nodeId: nDs2Cr.get('id') } }),
      ).toBe(0);

      // Restart reconciler: replays Create job into main DB from ds2 ledger WITHOUT inserting a 2nd ds2 row!
      plugin.reconciler.clearDispatchThrottle(String(ds2Task.get('workflowJobId')));
      await plugin.reconciler.reconcileOnce();
      await waitForCondition(async () => {
        const exec = await srv.db.getRepository('executions').findOne({ filterByTk: ds2ExecId });
        return Number(exec?.get('status')) === EXECUTION_STATUS.RESOLVED;
      });

      expect(await ds2Repo.count({ filter: { tag: 'ds2_split_once' } })).toBe(1);
      expect(
        await srv.db.getRepository('jobs').count({ filter: { executionId: ds2ExecId, nodeId: nDs2Cr.get('id') } }),
      ).toBe(1);
      const [ledgerLeftover] = (await ds2.collectionManager.db.sequelize.query(
        'SELECT COUNT(*) AS cnt FROM _rclone_wf_tx_ledger',
      )) as [Array<{ cnt?: number; CNT?: number }>, unknown];
      expect(Number(ledgerLeftover[0]?.cnt ?? ledgerLeftover[0]?.CNT ?? 0)).toBe(0);

      // =========================================================================
      // Finding 2: Rclone -> Output -> Create -> Delay
      //   2A: Restart between Create data write and job save -> 1 row & 1 Delay job
      //   2B: Two workers concurrently resuming with local locks -> 1 row & 1 Delay job
      // =========================================================================
      const wfOutChain = await srv.db.getRepository('workflows').create({
        values: {
          title: 'R8 Output Create Delay',
          type: 'collection',
          enabled: true,
          config: { collection: 'users', mode: 1 },
        },
      });
      const outWfId = Number(wfOutChain.get('id'));
      const nOutRc = await srv.db.getRepository('flow_nodes').create({
        values: {
          workflowId: outWfId,
          key: 'r8_out_rc',
          type: 'rclone-transfer',
          title: 'Copy',
          config: {
            connectionId,
            operation: 'sync/copy',
            srcFs: 's3:o-src',
            dstFs: 's3:o-dst',
            failOnError: true,
          },
        },
      });
      const nOutNode = await srv.db.getRepository('flow_nodes').create({
        values: {
          workflowId: outWfId,
          upstreamId: nOutRc.get('id'),
          key: 'r8_out_node',
          type: 'output',
          title: 'Set Output',
          config: { value: { stage: 'output-ok' } },
        },
      });
      await nOutRc.update({ downstreamId: nOutNode.get('id') });
      const nOutCreate = await srv.db.getRepository('flow_nodes').create({
        values: {
          workflowId: outWfId,
          upstreamId: nOutNode.get('id'),
          key: 'r8_out_cr',
          type: 'create',
          title: 'Create After Output',
          config: {
            collection: 'r8MainItems',
            params: { values: { tag: 'after_output_once' } },
          },
        },
      });
      await nOutNode.update({ downstreamId: nOutCreate.get('id') });
      const nOutDelay = await srv.db.getRepository('flow_nodes').create({
        values: {
          workflowId: outWfId,
          upstreamId: nOutCreate.get('id'),
          key: 'r8_out_dl',
          type: 'delay',
          title: 'Delay 60s',
          config: { duration: 60, unit: 1_000, endStatus: JOB_STATUS.RESOLVED },
        },
      });
      await nOutCreate.update({ downstreamId: nOutDelay.get('id') });
      const reloadedOutChainWf = (await srv.db.getRepository('workflows').findOne({
        filterByTk: outWfId,
        appends: ['nodes'],
      })) as Model;

      // 2A: Crash between Create data write and JobsModel.bulkCreate
      wfPlugin.trigger(reloadedOutChainWf, { data: { id: 2 } });
      await waitForCondition(async () => {
        const running = await srv.db.getRepository(COLLECTIONS.tasks).find({ filter: { status: 'running' } });
        return running.length === 1;
      });
      const outCrashTask = (await srv.db.getRepository(COLLECTIONS.tasks).findOne({
        filter: { status: 'running' },
      })) as Model;
      const outCrashExecId = Number(outCrashTask.get('executionId'));
      finishedJobs.add(Number(outCrashTask.get('rcloneJobId')));

      const JobsModel = srv.db.getModel('jobs') as unknown as {
        bulkCreate: (...args: unknown[]) => Promise<unknown>;
      };
      const origBulkCreate = JobsModel.bulkCreate.bind(JobsModel);
      let failAfterOutputCreateOnce = true;
      JobsModel.bulkCreate = async (...args: unknown[]) => {
        const rows = args[0] as Array<{ nodeId?: number }>;
        if (
          failAfterOutputCreateOnce &&
          Array.isArray(rows) &&
          rows.some((r) => Number(r.nodeId) === Number(nOutCreate.get('id')))
        ) {
          failAfterOutputCreateOnce = false;
          throw new Error('SIMULATED_CRASH_BETWEEN_CREATE_AFTER_OUTPUT_AND_JOB_SAVE');
        }
        return origBulkCreate(...args);
      };

      await plugin.reconciler.reconcileOnce();
      await sleep(250);
      JobsModel.bulkCreate = origBulkCreate;

      // Create after Output ran inside activeTx -> rolled back cleanly to 0 rows!
      expect(await srv.db.getRepository('r8MainItems').count({ filter: { tag: 'after_output_once' } })).toBe(0);

      plugin.reconciler.clearDispatchThrottle(String(outCrashTask.get('workflowJobId')));
      await plugin.reconciler.reconcileOnce();
      await waitForCondition(async () => {
        const dlCnt = await srv.db
          .getRepository('jobs')
          .count({ filter: { executionId: outCrashExecId, nodeId: nOutDelay.get('id') } });
        return dlCnt >= 1;
      });
      expect(await srv.db.getRepository('r8MainItems').count({ filter: { tag: 'after_output_once' } })).toBe(1);
      expect(
        await srv.db
          .getRepository('jobs')
          .count({ filter: { executionId: outCrashExecId, nodeId: nOutDelay.get('id') } }),
      ).toBe(1);
      const outCrashExec = await srv.db.getRepository('executions').findOne({ filterByTk: outCrashExecId });
      expect(outCrashExec?.get('output')).toEqual({ stage: 'output-ok' });

      // 2B: Two workers concurrently resuming with independent local locks (no shared Redis lock!)
      wfPlugin.trigger(reloadedOutChainWf, { data: { id: 3 } });
      await waitForCondition(async () => {
        const running = await srv.db.getRepository(COLLECTIONS.tasks).find({ filter: { status: 'running' } });
        return running.length === 1;
      });
      const dualTask = (await srv.db.getRepository(COLLECTIONS.tasks).findOne({
        filter: { status: 'running' },
      })) as Model;
      const dualExecId = Number(dualTask.get('executionId'));
      const dualWfJobId = String(dualTask.get('workflowJobId'));

      // Settle task & job to RESOLVED, then launch two concurrent Processor.resume() calls directly (bypassing single-process execution lock!)
      await srv.db.getCollection(COLLECTIONS.tasks).model.update(
        {
          status: 'completed',
          resumePending: true,
          resumeToken: `rtok-dual-${dualWfJobId}`,
          completedAt: new Date(),
        },
        { where: { id: Number(dualTask.get('id')) } },
      );
      await srv.db.getCollection('jobs').model.update(
        {
          status: JOB_STATUS.RESOLVED,
          result: {
            taskId: Number(dualTask.get('id')),
            rcloneJobId: Number(dualTask.get('rcloneJobId')),
            resumeToken: `rtok-dual-${dualWfJobId}`,
            success: true,
            failOnError: true,
          },
        },
        { where: { id: dualWfJobId } },
      );

      const loadExecAndJob = async () => {
        const execModel = (await srv.db.getRepository('executions').findOne({
          filterByTk: dualExecId,
          appends: ['workflow', 'workflow.nodes', 'jobs'],
        })) as Model;
        const jobModel = (await srv.db.getRepository('jobs').findOne({
          filterByTk: dualWfJobId,
        })) as JobModel;
        (jobModel as unknown as { execution: Model }).execution = execModel;
        return { proc: wfPlugin.createProcessor(execModel), jobModel };
      };
      const worker1 = await loadExecAndJob();
      const worker2 = await loadExecAndJob();

      await Promise.all([worker1.proc.resume(worker1.jobModel), worker2.proc.resume(worker2.jobModel)]);

      // Total across 2A + 2B must be 1 + 1 = 2 rows (i.e. 1 row for dualExecId!) and 1 Delay job for dualExecId!
      expect(await srv.db.getRepository('r8MainItems').count({ filter: { tag: 'after_output_once' } })).toBe(2);
      expect(
        await srv.db.getRepository('jobs').count({ filter: { executionId: dualExecId, nodeId: nOutDelay.get('id') } }),
      ).toBe(1);
      const dualExecAfter = await srv.db.getRepository('executions').findOne({ filterByTk: dualExecId });
      expect(dualExecAfter?.get('output')).toEqual({ stage: 'output-ok' });

      // =========================================================================
      // Finding 3: Redis retry race — Consumer rolls back & writes resumePending=true
      //            BEFORE Producer calls clearTaskResumePending!
      //            Producer MUST NOT overwrite resumePending to false; scans recover it.
      // =========================================================================
      class RedisEventQueueStub {}
      const origEventQueue = srv.eventQueue;
      const wfRedisRace = await srv.db.getRepository('workflows').create({
        values: {
          title: 'R8 Redis Producer Consumer Race',
          type: 'collection',
          enabled: true,
          config: { collection: 'users', mode: 1 },
        },
      });
      const redisWfId = Number(wfRedisRace.get('id'));
      const nRedisRc = await srv.db.getRepository('flow_nodes').create({
        values: {
          workflowId: redisWfId,
          key: 'r8_redis_rc',
          type: 'rclone-transfer',
          title: 'Copy Redis',
          config: {
            connectionId,
            operation: 'sync/copy',
            srcFs: 's3:r-src',
            dstFs: 's3:r-dst',
            failOnError: true,
          },
        },
      });
      const nRedisCr = await srv.db.getRepository('flow_nodes').create({
        values: {
          workflowId: redisWfId,
          upstreamId: nRedisRc.get('id'),
          key: 'r8_redis_cr',
          type: 'create',
          title: 'Create After Redis Resume',
          config: {
            collection: 'r8MainItems',
            params: { values: { tag: 'redis_race_once' } },
          },
        },
      });
      await nRedisRc.update({ downstreamId: nRedisCr.get('id') });
      const reloadedRedisWf = (await srv.db.getRepository('workflows').findOne({
        filterByTk: redisWfId,
        appends: ['nodes'],
      })) as Model;

      wfPlugin.trigger(reloadedRedisWf, { data: { id: 4 } });
      await waitForCondition(async () => {
        const running = await srv.db.getRepository(COLLECTIONS.tasks).find({ filter: { status: 'running' } });
        return running.length === 1;
      });
      const redisTask = (await srv.db.getRepository(COLLECTIONS.tasks).findOne({
        filter: { status: 'running' },
      })) as Model;
      const redisTaskId = Number(redisTask.get('id'));
      const redisExecId = Number(redisTask.get('executionId'));
      const redisWfJobId = String(redisTask.get('workflowJobId'));
      finishedJobs.add(Number(redisTask.get('rcloneJobId')));

      let failRedisConsumerOnce = true;
      let consumerProcessCount = 0;
      JobsModel.bulkCreate = async (...args: unknown[]) => {
        const rows = args[0] as Array<{ nodeId?: number }>;
        if (Array.isArray(rows) && rows.some((r) => Number(r.nodeId) === Number(nRedisCr.get('id')))) {
          consumerProcessCount += 1;
          if (failRedisConsumerOnce) {
            failRedisConsumerOnce = false;
            throw new Error('SIMULATED_CONSUMER_DB_ROLLBACK_BEFORE_PRODUCER_CLEAR');
          }
        }
        return origBulkCreate(...args);
      };

      try {
        (srv as unknown as { eventQueue: unknown }).eventQueue = {
          adapter: new RedisEventQueueStub(),
          subscribe: origEventQueue.subscribe.bind(origEventQueue),
          publish: async (
            ch: string,
            msg: { executionId?: number | string; jobId?: number | string },
            opts?: unknown,
          ) => {
            if (msg?.jobId && String(msg.jobId) === redisWfJobId) {
              // Deterministically run Consumer synchronously INSIDE publish() so Consumer rolls back and writes
              // resumePending=true BEFORE Producer returns from workflowPlugin.resume() and calls clearTaskResumePending!
              const execModel = (await srv.db.getRepository('executions').findOne({
                filterByTk: redisExecId,
                appends: ['workflow', 'workflow.nodes', 'jobs'],
              })) as Model;
              const jobModel = (await srv.db.getRepository('jobs').findOne({
                filterByTk: redisWfJobId,
              })) as JobModel;
              (jobModel as unknown as { execution: Model }).execution = execModel;
              const proc = wfPlugin.createProcessor(execModel);
              await proc.resume(jobModel);
              return;
            }
            return origEventQueue.publish(ch, msg, opts as never);
          },
        };

        // Scan 1: Consumer fails & rolls back (writing resumePending=true), then Producer runs clearTaskResumePending!
        await plugin.reconciler.reconcileOnce();
        expect(consumerProcessCount).toBe(1);
        expect(await srv.db.getRepository('r8MainItems').count({ filter: { tag: 'redis_race_once' } })).toBe(0);

        const taskAfterScan1 = await srv.db.getRepository(COLLECTIONS.tasks).findOne({ filterByTk: redisTaskId });
        expect(Boolean(taskAfterScan1?.get('resumePending'))).toBe(true);

        // Scans 2..4: Producer retries because resumePending remained true -> execution resolves with 1 Create row!
        for (let scan = 2; scan <= 4; scan += 1) {
          await plugin.reconciler.reconcileOnce();
        }

        const execAfterScans = await srv.db.getRepository('executions').findOne({ filterByTk: redisExecId });
        expect(Number(execAfterScans?.get('status'))).toBe(EXECUTION_STATUS.RESOLVED);
        expect(consumerProcessCount).toBe(2);
        expect(await srv.db.getRepository('r8MainItems').count({ filter: { tag: 'redis_race_once' } })).toBe(1);
        const taskAfterScans = await srv.db.getRepository(COLLECTIONS.tasks).findOne({ filterByTk: redisTaskId });
        expect(Boolean(taskAfterScans?.get('resumePending'))).toBe(false);
      } finally {
        JobsModel.bulkCreate = origBulkCreate;
        (srv as unknown as { eventQueue: unknown }).eventQueue = origEventQueue;
      }

      // =========================================================================
      // Finding 4: SQLite write lock held by another connection causing repeated
      //            SQLITE_BUSY MUST NOT mark completed Rclone job or execution ERROR!
      // =========================================================================
      const wfSqliteBusy = await srv.db.getRepository('workflows').create({
        values: {
          title: 'R8 SQLite Busy Lock Resilience',
          type: 'collection',
          enabled: true,
          config: { collection: 'users', mode: 1 },
        },
      });
      const busyWfId = Number(wfSqliteBusy.get('id'));
      const nBusyRc = await srv.db.getRepository('flow_nodes').create({
        values: {
          workflowId: busyWfId,
          key: 'r8_busy_rc',
          type: 'rclone-transfer',
          title: 'Copy Under Lock',
          config: {
            connectionId,
            operation: 'sync/copy',
            srcFs: 's3:b-src',
            dstFs: 's3:b-dst',
            failOnError: true,
          },
        },
      });
      const nBusyCr = await srv.db.getRepository('flow_nodes').create({
        values: {
          workflowId: busyWfId,
          upstreamId: nBusyRc.get('id'),
          key: 'r8_busy_cr',
          type: 'create',
          title: 'Create After Lock Releases',
          config: {
            collection: 'r8MainItems',
            params: { values: { tag: 'sqlite_busy_once' } },
          },
        },
      });
      await nBusyRc.update({ downstreamId: nBusyCr.get('id') });
      const reloadedBusyWf = (await srv.db.getRepository('workflows').findOne({
        filterByTk: busyWfId,
        appends: ['nodes'],
      })) as Model;

      wfPlugin.trigger(reloadedBusyWf, { data: { id: 5 } });
      await waitForCondition(async () => {
        const running = await srv.db.getRepository(COLLECTIONS.tasks).find({ filter: { status: 'running' } });
        return running.length === 1;
      });
      const busyTask = (await srv.db.getRepository(COLLECTIONS.tasks).findOne({
        filter: { status: 'running' },
      })) as Model;
      const busyExecId = Number(busyTask.get('executionId'));
      const busyWfJobId = String(busyTask.get('workflowJobId'));
      finishedJobs.add(Number(busyTask.get('rcloneJobId')));

      // Part 4A: Even if openSerializedTransaction exhausts all retries and throws SQLITE_BUSY while an external
      // SQLite connection holds BEGIN IMMEDIATE, neither the RESOLVED Rclone job nor execution becomes ERROR!
      externalLockDs = new SequelizeDataSource({
        name: 'extLock',
        displayName: 'External SQLite Writer',
        collectionManager: {
          dialect: 'sqlite',
          storage: mainSqlitePath,
          logging: false,
        },
      });

      let forceImmediateBusyExhaustion = true;
      let busyErrorsRaised = 0;
      mainSeq.transaction = async (opts?: Record<string, unknown>) => {
        if (forceImmediateBusyExhaustion && opts?.type === 'IMMEDIATE') {
          busyErrorsRaised += 1;
          // Exhaust openSerializedTransaction's deadline after 3 SQLITE_BUSY errors without waiting 25s wall-clock
          const sqliteBusyErr = Object.assign(new Error('SQLITE_BUSY: database is locked'), {
            parent: { code: 'SQLITE_BUSY', errno: 5, message: 'SQLITE_BUSY: database is locked' },
          });
          if (busyErrorsRaised >= 3) {
            forceImmediateBusyExhaustion = false;
            // Force openSerializedTransaction deadline exit on the 3rd SQLITE_BUSY by advancing past its retry loop
            const realNow = Date.now;
            Date.now = () => realNow() + 60_000;
            try {
              throw sqliteBusyErr;
            } finally {
              setTimeout(() => {
                Date.now = realNow;
              }, 0);
            }
          }
          throw sqliteBusyErr;
        }
        return origMainTx(opts);
      };

      await plugin.reconciler.reconcileOnce();
      await sleep(250);
      mainSeq.transaction = origMainTx;

      expect(busyErrorsRaised).toBeGreaterThanOrEqual(3);
      const rcloneJobAfterBusy = await srv.db.getRepository('jobs').findOne({ filterByTk: busyWfJobId });
      const execAfterBusy = await srv.db.getRepository('executions').findOne({ filterByTk: busyExecId });
      expect(Number(rcloneJobAfterBusy?.get('status'))).toBe(JOB_STATUS.RESOLVED);
      expect(Number(execAfterBusy?.get('status'))).toBe(EXECUTION_STATUS.STARTED);

      // Part 4B: Also hold a REAL OS-level SQLite BEGIN IMMEDIATE write lock on a second connection for ~1.5s
      // while reconciler resumes, then release it -> workflow waits out the lock and finishes RESOLVED cleanly!
      const extSeq = externalLockDs.collectionManager.db.sequelize as unknown as {
        transaction: (opts: { type: string }) => Promise<{ rollback: () => Promise<void> }>;
      };
      const realExternalWriteLock = await extSeq.transaction({ type: 'IMMEDIATE' });
      setTimeout(() => {
        realExternalWriteLock.rollback().catch(() => {});
      }, 1_200);

      plugin.reconciler.clearDispatchThrottle(busyWfJobId);
      await plugin.reconciler.reconcileOnce();
      await waitForCondition(async () => {
        const exec = await srv.db.getRepository('executions').findOne({ filterByTk: busyExecId });
        return Number(exec?.get('status')) === EXECUTION_STATUS.RESOLVED;
      }, 12_000);

      const finalRcloneJob = await srv.db.getRepository('jobs').findOne({ filterByTk: busyWfJobId });
      expect(Number(finalRcloneJob?.get('status'))).toBe(JOB_STATUS.RESOLVED);
      expect(await srv.db.getRepository('r8MainItems').count({ filter: { tag: 'sqlite_busy_once' } })).toBe(1);
    } finally {
      if (externalLockDs) {
        await externalLockDs.collectionManager.db.close().catch(() => {});
      }
      if (ds2) {
        await ds2.collectionManager.db.close().catch(() => {});
      }
      if (app) {
        await app.stop().catch(() => {});
      }
      await fs.rm(mainSqlitePath, { force: true }).catch(() => {});
      await fs.rm(ds2SqlitePath, { force: true }).catch(() => {});
    }
  }, 45_000);
});
