/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Context } from '@nocobase/actions';
import type Application from '@nocobase/server';
import { SECRET_MASK } from '../../shared/constants';
import { buildEffectiveStackEnv, normalizeGitReference, parseDotEnvText } from '../../shared/env';
import { createPortainerResourceActions } from '../actions/portainer';
import { executePortainerControl } from '../instructions/PortainerStackControlInstruction';
import { executePortainerRedeploy } from '../instructions/PortainerStackRedeployInstruction';
import { PluginWorkflowPortainerServer } from '../plugin';
import {
  assertValidContainerId,
  assertValidPortainerUrl,
  computeDockerContainerStats,
  demuxDockerLogBuffer,
  PortainerApiError,
  PortainerClient,
} from '../services/PortainerClient';

interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

function createFakeApp(instanceRow: Record<string, unknown>): Application {
  const model = {
    get: (key: string) => instanceRow[key],
  };
  return {
    aesEncryptor: {
      decrypt: async (v: string) => (v.startsWith('enc:') ? v.slice(4) : v),
      encrypt: async (v: string) => `enc:${v}`,
    },
    db: {
      getRepository: () => ({
        findOne: async () => model,
      }),
    },
  } as unknown as Application;
}

describe('plugin-workflow-portainer shared env & server instructions', () => {
  let server: http.Server;
  let baseUrl = '';
  let recorded: RecordedRequest[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsedBody: unknown = null;
        if (raw) {
          try {
            parsedBody = JSON.parse(raw);
          } catch {
            parsedBody = raw;
          }
        }
        recorded.push({
          method: req.method || 'GET',
          url: req.url || '/',
          headers: req.headers,
          body: parsedBody,
        });

        const url = new URL(req.url || '/', 'http://127.0.0.1');

        if (req.method === 'GET' && url.pathname === '/api/stacks/10') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              Id: 10,
              Name: 'api-build-stack',
              EndpointId: 2,
              Status: 1,
              Env: [
                { name: 'EXISTING_FLAG', value: 'keep-me' },
                { name: 'DB_PASSWORD', value: 'super-secret-db' },
                { name: 'IMAGE_TAG', value: 'old-tag' },
              ],
              GitConfig: {
                URL: 'https://gitlab.example.com/org/service.git',
                ReferenceName: 'refs/heads/develop',
                Authentication: {
                  Username: 'gitbot',
                  GitCredentialID: 7,
                },
              },
            }),
          );
          return;
        }

        if (req.method === 'PUT' && url.pathname === '/api/stacks/10/git/redeploy') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ Id: 10, Name: 'api-build-stack', EndpointId: 2, Status: 1 }));
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/stacks/20') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              Id: 20,
              Name: 'api-prod-deploy',
              EndpointId: 3,
              Status: 1,
              Env: [{ name: 'PORT', value: '8080' }],
              GitConfig: null,
            }),
          );
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/stacks/20/file') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              StackFileContent: 'services:\n  app:\n    image: registry.local/api:${IMAGE_TAG}\n',
            }),
          );
          return;
        }

        if (req.method === 'PUT' && url.pathname === '/api/stacks/20') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ Id: 20, Name: 'api-prod-deploy', EndpointId: 3, Status: 1 }));
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/stacks/20/stop') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ Id: 20, Name: 'api-prod-deploy', EndpointId: 3, Status: 2 }));
          return;
        }

        if (req.method === 'POST' && url.pathname.startsWith('/api/stacks/webhooks/')) {
          res.writeHead(204);
          res.end();
          return;
        }

        if (req.method === 'GET' && url.pathname.endsWith('/docker/containers/json')) {
          const filters = url.searchParams.get('filters') || '';
          if (filters.includes('api-prod-deploy') && recorded.some((r) => r.url.includes('/stop'))) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify([]));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify([
              {
                Id: 'abcdef1234567890',
                Names: ['/api-build-stack-app-1'],
                Image: 'registry.local/api:v1.4.0',
                State: 'running',
                Status: 'Up 12 seconds (healthy)',
              },
            ]),
          );
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Not found' }));
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    recorded = [];
  });

  it('merges existing Stack Env, dynamic JSON, .env text, and key-value pairs while masking secrets', () => {
    const parsedDotEnv = parseDotEnvText(
      '# comment\nexport NODE_ENV="production"\nDATABASE_URL="postgres://u:p@db:5432/app?sslmode=disable"\n',
    );
    expect(parsedDotEnv).toEqual([
      { name: 'NODE_ENV', value: 'production' },
      { name: 'DATABASE_URL', value: 'postgres://u:p@db:5432/app?sslmode=disable' },
    ]);

    const merged = buildEffectiveStackEnv({
      existingEnv: [
        { name: 'KEEP_EXISTING', value: '1' },
        { name: 'IMAGE_TAG', value: 'v0.9.0' },
        { name: 'JWT_SECRET', value: 'existing-jwt-secret' },
      ],
      strategy: 'merge',
      dynamicEnv: '{"IMAGE_TAG":"v1.0.0","EXTRA_JSON":"from-catalog"}',
      envText: 'EXTRA_JSON=from-dotenv\nLOG_LEVEL=info',
      envPairs: [
        { name: 'IMAGE_TAG', value: 'v1.1.0', secret: false },
        { name: 'CUSTOM_INTERNAL', value: 'hidden-val', secret: true },
      ],
    });

    expect(merged.env).toEqual([
      { name: 'KEEP_EXISTING', value: '1' },
      { name: 'IMAGE_TAG', value: 'v1.1.0' },
      { name: 'JWT_SECRET', value: 'existing-jwt-secret' },
      { name: 'EXTRA_JSON', value: 'from-dotenv' },
      { name: 'LOG_LEVEL', value: 'info' },
      { name: 'CUSTOM_INTERNAL', value: 'hidden-val' },
    ]);
    expect(merged.maskedEnv.JWT_SECRET).toBe(SECRET_MASK);
    expect(merged.maskedEnv.CUSTOM_INTERNAL).toBe(SECRET_MASK);
    expect(merged.maskedEnv.IMAGE_TAG).toBe('v1.1.0');
  });

  it('normalizes Git references while preserving existing refs/* values', () => {
    expect(normalizeGitReference('', 'refs/heads/release')).toBe('refs/heads/release');
    expect(normalizeGitReference('feature/ci', 'refs/heads/main')).toBe('refs/heads/feature/ci');
    expect(normalizeGitReference('refs/tags/v2.0.0', 'refs/heads/main')).toBe('refs/tags/v2.0.0');
  });

  it('redeploys a Git-backed Portainer Stack preserving GitCredentialID and existing Stack Env', async () => {
    const app = createFakeApp({
      id: 1,
      name: 'Portainer Primary',
      baseUrl,
      apiKey: 'enc:ptr_test_key_123',
      enabled: true,
      isDefault: true,
      defaultTimeoutMs: 30_000,
    });

    const result = await executePortainerRedeploy(app, {
      stackId: 10,
      gitReference: 'release/1.4',
      envStrategy: 'merge',
      dynamicEnv: { BUILD_NUMBER: 42 },
      envPairs: [{ name: 'IMAGE_TAG', value: 'v1.4.0', secret: false }],
    });

    expect(result.ok).toBe(true);
    expect(result.stackType).toBe('git');
    expect(result.endpointId).toBe(2);
    expect(result.gitReference).toBe('refs/heads/release/1.4');
    expect(result.healthy).toBe(true);
    expect(result.runningCount).toBe(1);
    expect(result.appliedEnv.DB_PASSWORD).toBe(SECRET_MASK);
    expect(result.appliedEnv.IMAGE_TAG).toBe('v1.4.0');

    const redeployCall = recorded.find((r) => r.method === 'PUT' && r.url.startsWith('/api/stacks/10/git/redeploy'));
    expect(redeployCall).toBeDefined();
    expect(redeployCall?.url).toContain('endpointId=2');
    expect(redeployCall?.headers['x-api-key']).toBe('ptr_test_key_123');
    expect(redeployCall?.body).toMatchObject({
      repositoryReferenceName: 'refs/heads/release/1.4',
      repositoryAuthentication: true,
      repositoryGitCredentialID: 7,
      repositoryUsername: 'gitbot',
      env: [
        { name: 'EXISTING_FLAG', value: 'keep-me' },
        { name: 'DB_PASSWORD', value: 'super-secret-db' },
        { name: 'IMAGE_TAG', value: 'v1.4.0' },
        { name: 'BUILD_NUMBER', value: '42' },
      ],
    });
  });

  it('redeploys a separate non-Git Compose Deploy Stack with repullImage and Replace strategy', async () => {
    const app = createFakeApp({
      id: 1,
      name: 'Portainer Primary',
      baseUrl,
      apiKey: 'enc:ptr_test_key_123',
      enabled: true,
      isDefault: true,
    });

    const result = await executePortainerRedeploy(app, {
      endpointId: 3,
      stackId: 20,
      repullImage: true,
      prune: true,
      envStrategy: 'replace',
      envText: 'IMAGE_TAG=v1.4.0\nPORT=9090',
    });

    expect(result.ok).toBe(true);
    expect(result.stackType).toBe('compose');
    expect(result.appliedEnv).toEqual({ IMAGE_TAG: 'v1.4.0', PORT: '9090' });

    const composePut = recorded.find((r) => r.method === 'PUT' && r.url.startsWith('/api/stacks/20?'));
    expect(composePut).toBeDefined();
    expect(composePut?.body).toMatchObject({
      pullImage: true,
      prune: true,
      env: [
        { name: 'IMAGE_TAG', value: 'v1.4.0' },
        { name: 'PORT', value: '9090' },
      ],
    });
  });

  it('triggers Stack Webhook without leaking X-API-Key header and supports Control inspect/stop', async () => {
    const app = createFakeApp({
      id: 1,
      name: 'Portainer Primary',
      baseUrl,
      apiKey: 'enc:ptr_test_key_123',
      enabled: true,
      isDefault: true,
    });

    const webhookRes = await executePortainerRedeploy(app, {
      mode: 'webhook',
      webhookId: '638e6967-ef77-4906-8af8-236800621360',
      webhookTag: 'v1.4.0',
    });
    expect(webhookRes.stackType).toBe('webhook');

    const hookCall = recorded.find((r) => r.url.startsWith('/api/stacks/webhooks/'));
    expect(hookCall?.url).toBe('/api/stacks/webhooks/638e6967-ef77-4906-8af8-236800621360?tag=v1.4.0');
    expect(hookCall?.headers['x-api-key']).toBeUndefined();

    const inspectRes = await executePortainerControl(app, {
      stackId: 10,
      action: 'inspect',
    });
    expect(inspectRes.healthy).toBe(true);
    expect(inspectRes.currentEnv.DB_PASSWORD).toBe(SECRET_MASK);

    const stopRes = await executePortainerControl(app, {
      stackId: 20,
      action: 'stop',
    });
    expect(stopRes.action).toBe('stop');
    expect(stopRes.stackStatus).toBe(2);
    expect(stopRes.healthy).toBe(true);
  });

  it('rejects unsafe URLs with non-HTTP schemes or embedded credentials', () => {
    expect(() => assertValidPortainerUrl('ftp://portainer.local')).toThrow(PortainerApiError);
    expect(() => assertValidPortainerUrl('https://admin:secret@portainer.local:9443')).toThrow(PortainerApiError);
  });

  it('polls asynchronous Portainer Status=3 (Deploying) until Active or throws on Status=4 (Error)', async () => {
    const client = new PortainerClient({ baseUrl, apiKey: 'ptr_test_key_123', timeoutMs: 5_000 });
    let pollCalls = 0;
    vi.spyOn(client, 'getRawStack').mockImplementation(async () => {
      pollCalls += 1;
      if (pollCalls < 2) {
        return { Id: 10, Name: 'api-build-stack', EndpointId: 2, Status: 3 };
      }
      return { Id: 10, Name: 'api-build-stack', EndpointId: 2, Status: 1 };
    });

    const settled = await client.waitForStackSettlement(
      10,
      { Id: 10, Name: 'api-build-stack', EndpointId: 2, Status: 3 },
      { pollIntervalMs: 50, timeoutMs: 2_000 },
    );
    expect(settled.Status).toBe(1);
    expect(pollCalls).toBe(2);

    vi.spyOn(client, 'getRawStack').mockResolvedValueOnce({
      Id: 10,
      Name: 'api-build-stack',
      EndpointId: 2,
      Status: 4,
      DeploymentStatus: [{ Status: 4, Time: 123, Message: 'Dockerfile syntax error on line 4' }],
    });

    await expect(
      client.waitForStackSettlement(
        10,
        { Id: 10, Name: 'api-build-stack', EndpointId: 2, Status: 3 },
        { pollIntervalMs: 50, timeoutMs: 2_000 },
      ),
    ).rejects.toThrow('Dockerfile syntax error on line 4');
  });

  it('enforces ACL on metadata actions and masks stored secrets in API responses', async () => {
    const allowRules = new Map<string, (ctx: Record<string, unknown>) => boolean>();
    let responseMiddleware: ((ctx: Record<string, unknown>, next: () => Promise<void>) => Promise<void>) | null = null;
    const registeredInstructions = new Map<string, unknown>();

    const fakePlugin = Object.create(PluginWorkflowPortainerServer.prototype) as PluginWorkflowPortainerServer & {
      app: Record<string, unknown>;
    };
    fakePlugin.app = {
      pm: {
        get: () => ({
          registerInstruction: (name: string, inst: unknown) => registeredInstructions.set(name, inst),
        }),
      },
      resourceManager: {
        define: vi.fn(),
        use: (mw: (ctx: Record<string, unknown>, next: () => Promise<void>) => Promise<void>) => {
          responseMiddleware = mw;
        },
      },
      acl: {
        registerSnippet: vi.fn(),
        allow: (_res: string, action: string, fn: (ctx: Record<string, unknown>) => boolean) => {
          allowRules.set(action, fn);
        },
        can: ({ role, resource, action }: { role: string; resource: string; action: string }) => {
          if (role === 'workflow_editor' && resource === 'workflows' && action === 'update') {
            return true;
          }
          return false;
        },
      },
    };

    await PluginWorkflowPortainerServer.prototype.load.call(fakePlugin);

    expect(registeredInstructions.has('portainer-stack-redeploy')).toBe(true);
    expect(registeredInstructions.has('portainer-stack-control')).toBe(true);

    const checkListStacks = allowRules.get('listStacks');
    expect(checkListStacks).toBeDefined();
    expect(checkListStacks?.({ state: {} })).toBe(false);
    expect(checkListStacks?.({ state: { currentUser: { id: 2 }, currentRoles: ['member'] } })).toBe(false);
    expect(checkListStacks?.({ state: { currentUser: { id: 3 }, currentRoles: ['workflow_editor'] } })).toBe(true);
    expect(checkListStacks?.({ state: { currentUser: { id: 1 }, currentRoles: ['root'] } })).toBe(true);

    const ctx: Record<string, unknown> = {
      action: { resourceName: 'portainerInstances' },
      body: {
        data: [
          {
            id: 1,
            name: 'Prod',
            apiKey: 'enc:secret-key',
            gitAccessToken: 'enc:git-pat',
          },
        ],
      },
    };
    await responseMiddleware?.(ctx, async () => {});
    const maskedRow = (ctx.body as { data: Array<Record<string, string>> }).data[0];
    expect(maskedRow.apiKey).toBe(SECRET_MASK);
    expect(maskedRow.gitAccessToken).toBe(SECRET_MASK);
    expect(allowRules.has('getStackOverview')).toBe(true);
    expect(allowRules.has('getContainerLogs')).toBe(true);
    expect(allowRules.has('controlStack')).toBe(false);
  });

  it('computes live Docker container stats, demuxes binary log frames, and builds getStackOverview', async () => {
    const stats = computeDockerContainerStats({
      cpu_stats: {
        cpu_usage: { total_usage: 250_000_000 },
        system_cpu_usage: 2_000_000_000,
        online_cpus: 2,
      },
      precpu_stats: {
        cpu_usage: { total_usage: 150_000_000 },
        system_cpu_usage: 1_000_000_000,
      },
      memory_stats: {
        usage: 120 * 1024 * 1024,
        limit: 1024 * 1024 * 1024,
        stats: { inactive_file: 20 * 1024 * 1024 },
      },
      networks: {
        eth0: { rx_bytes: 4096, tx_bytes: 2048 },
        eth1: { rx_bytes: 1024, tx_bytes: 512 },
      },
      blkio_stats: {
        io_service_bytes_recursive: [
          { op: 'Read', value: 8192 },
          { op: 'Write', value: 4096 },
        ],
      },
      pids_stats: { current: 7 },
    });

    expect(stats.cpuPercent).toBe(20);
    expect(stats.memUsageBytes).toBe(100 * 1024 * 1024);
    expect(stats.memLimitBytes).toBe(1024 * 1024 * 1024);
    expect(stats.memPercent).toBe(9.77);
    expect(stats.netRxBytes).toBe(5120);
    expect(stats.netTxBytes).toBe(2560);
    expect(stats.blockReadBytes).toBe(8192);
    expect(stats.blockWriteBytes).toBe(4096);
    expect(stats.pids).toBe(7);

    const line1 = Buffer.from('2026-11-26T16:25:00Z nginx ready\n', 'utf8');
    const hdr1 = Buffer.alloc(8);
    hdr1[0] = 1;
    hdr1.writeUInt32BE(line1.length, 4);
    const line2 = Buffer.from('2026-11-26T16:25:01Z worker started\n', 'utf8');
    const hdr2 = Buffer.alloc(8);
    hdr2[0] = 2;
    hdr2.writeUInt32BE(line2.length, 4);
    const muxBuf = Buffer.concat([hdr1, line1, hdr2, line2]);

    expect(demuxDockerLogBuffer(muxBuf)).toBe(
      '2026-11-26T16:25:00Z nginx ready\n2026-11-26T16:25:01Z worker started\n',
    );
    expect(demuxDockerLogBuffer(Buffer.from('plain tty log\n', 'utf8'))).toBe('plain tty log\n');
    expect(() => assertValidContainerId('../bad-path')).toThrow(PortainerApiError);
    expect(assertValidContainerId('afb6265776d5')).toBe('afb6265776d5');

    const app = createFakeApp({
      id: 1,
      name: 'Primary Portainer',
      baseUrl,
      apiKey: 'enc:ptr_test_key_123',
      enabled: true,
      defaultTimeoutMs: 10_000,
    });

    vi.spyOn(PortainerClient.prototype, 'getContainerLiveStats').mockResolvedValueOnce(stats);

    const actions = createPortainerResourceActions(app);
    const ctx = {
      action: { params: { instanceId: 1, stackId: 10 } },
      t: (k: string) => k,
      throw: (code: number, msg: string) => {
        throw new Error(`${code}:${msg}`);
      },
      body: undefined as unknown,
    } as unknown as Context;

    await actions.getStackOverview(ctx, async () => {});
    const overview = ctx.body as {
      detail: { env: Array<{ name: string; value: string; sensitive: boolean }> };
      summary: { totalCpuPercent: number; runningCount: number };
    };
    expect(overview.summary.totalCpuPercent).toBe(20);
    expect(overview.summary.runningCount).toBe(1);
    const dbSecret = overview.detail.env.find((item) => item.name === 'DB_PASSWORD');
    const existingFlag = overview.detail.env.find((item) => item.name === 'EXISTING_FLAG');
    expect(dbSecret?.sensitive).toBe(true);
    expect(dbSecret?.value).toBe(SECRET_MASK);
    expect(existingFlag?.sensitive).toBe(false);
    expect(existingFlag?.value).toBe('keep-me');
  });
});
