// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Context } from '@nocobase/actions';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { COLLECTIONS, HAPROXY_SNIPPETS, RESOURCE_NAME, SECRET_MASK } from '../../shared/constants';
import { computeConfigDiff } from '../../shared/diff';
import type { ConfigDiffResult, HaproxyAuditLogRecord, HaproxyConfigRevisionSummary } from '../../shared/types';
import { createHaproxyDataplaneActions } from '../actions/haproxy-dataplane';
import { createHaproxyResourceGuardMiddleware } from '../middlewares/resource-guard';
import PluginHaproxyDataplaneServer from '../plugin';
import {
  assertSafeStorageFileName,
  DataplaneV3Client,
  normalizeDataplaneV3BaseUrl,
} from '../services/dataplane-v3-client';

type PluginApp = ConstructorParameters<typeof PluginHaproxyDataplaneServer>[0];

function startMockDataplaneNode(hostname: string) {
  let configVersion = 3;
  let rawCfg = 'global\n  maxconn 2000\n';
  let currentAdminState = 'ready';
  let currentWeight = 100;
  let lastPutBody: Record<string, unknown> | null = null;
  let lastRawContentType = '';
  let lastSslMultipart = '';
  const certs = new Map<string, string>();
  const frontends: Array<Record<string, unknown>> = [{ name: 'fe_https', mode: 'http', default_backend: 'be_app' }];

  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization;
    if (auth !== `Basic ${Buffer.from('admin:s3cr3t').toString('base64')}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 401, message: 'Invalid credentials' }));
      return;
    }

    const parsedUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = parsedUrl.pathname;

    const readBody = (cb: (buf: Buffer) => void) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => cb(Buffer.concat(chunks)));
    };

    if (req.method === 'GET' && pathname === '/v3/info') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          api: { version: 'v3.1.2 8a91bc', build_date: '2026-06-01T00:00:00Z' },
          system: { hostname, os_string: 'Linux', uptime: 86400 },
        }),
      );
      return;
    }

    if (req.method === 'GET' && pathname === '/v3/services/haproxy/runtime/info') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          runtimeAPI: '/var/run/haproxy.sock',
          info: {
            version: '3.0.8',
            uptime: 7200,
            pid: 42,
            nbthread: 4,
            curr_conns: 18,
            cum_conns: 9400,
            conn_rate: 6,
            max_conn: 4096,
          },
        }),
      );
      return;
    }

    if (req.method === 'GET' && pathname === '/v3/services/haproxy/configuration/version') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Configuration-Version': String(configVersion),
      });
      res.end(String(configVersion));
      return;
    }

    if (req.method === 'GET' && pathname === '/v3/services/haproxy/transactions') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return;
    }

    if (req.method === 'POST' && pathname === '/v3/services/haproxy/transactions') {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'tx-unit-01',
          status: 'in_progress',
          _version: Number(parsedUrl.searchParams.get('version') ?? configVersion),
        }),
      );
      return;
    }

    if (req.method === 'PUT' && pathname === '/v3/services/haproxy/transactions/tx-unit-01') {
      configVersion += 1;
      res.writeHead(202, {
        'Content-Type': 'application/json',
        'Configuration-Version': String(configVersion),
        'Reload-ID': '2026-11-25-0',
      });
      res.end(JSON.stringify({ id: 'tx-unit-01', status: 'success', _version: configVersion }));
      return;
    }

    if (req.method === 'GET' && pathname === '/v3/services/haproxy/reloads') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{ id: '2026-11-25-0', status: 'succeeded', reload_timestamp: 1764060000 }]));
      return;
    }

    if (req.method === 'GET' && pathname === '/v3/services/haproxy/configuration/raw') {
      const checksum =
        rawCfg === 'global\n  maxconn 2000\n'
          ? 'deadbeef123456'
          : crypto.createHash('sha256').update(rawCfg, 'utf8').digest('hex').slice(0, 16);
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Configuration-Version': String(configVersion),
        'Configuration-Checksum': checksum,
      });
      res.end(rawCfg);
      return;
    }

    if (req.method === 'POST' && pathname === '/v3/services/haproxy/configuration/raw') {
      readBody((buf) => {
        lastRawContentType = String(req.headers['content-type'] ?? '');
        rawCfg = buf.toString('utf8');
        configVersion += 1;
        res.writeHead(202, {
          'Content-Type': 'application/json',
          'Configuration-Version': String(configVersion),
          'Reload-ID': '2026-11-25-1',
        });
        res.end('');
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/v3/services/haproxy/configuration/frontends') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(frontends));
      return;
    }

    if (req.method === 'POST' && pathname === '/v3/services/haproxy/configuration/frontends') {
      readBody((buf) => {
        const body = JSON.parse(buf.toString('utf8')) as Record<string, unknown>;
        frontends.push(body);
        if (!parsedUrl.searchParams.get('transaction_id')) {
          configVersion += 1;
        }
        res.writeHead(202, {
          'Content-Type': 'application/json',
          'Configuration-Version': String(configVersion),
          'Reload-ID': '2026-11-25-2',
        });
        res.end(JSON.stringify(body));
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/v3/services/haproxy/storage/ssl_certificates') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(
          Array.from(certs.keys()).map((name) => ({
            storage_name: name,
            subject: '/CN=*.example.com',
            domains: '*.example.com',
          })),
        ),
      );
      return;
    }

    if (req.method === 'POST' && pathname === '/v3/services/haproxy/storage/ssl_certificates') {
      readBody((buf) => {
        const text = buf.toString('utf8');
        lastSslMultipart = text;
        const match = text.match(/filename="([^"]+)"/);
        const name = match?.[1] ?? 'uploaded.pem';
        certs.set(name, text);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ storage_name: name, domains: '*.example.com' }));
      });
      return;
    }

    if (req.method === 'PUT' && pathname.startsWith('/v3/services/haproxy/storage/ssl_certificates/')) {
      readBody((buf) => {
        const name = decodeURIComponent(pathname.split('/').pop() ?? '');
        certs.set(name, buf.toString('utf8'));
        res.writeHead(202, {
          'Content-Type': 'application/json',
          'Reload-ID': '2026-11-25-ssl',
        });
        res.end(JSON.stringify({ storage_name: name }));
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/v3/services/haproxy/stats/native') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          runtimeAPI: '/var/run/haproxy.sock',
          stats: [
            {
              type: 'frontend',
              name: 'fe_https',
              stats: {
                status: 'OPEN',
                mode: 'http',
                scur: 18,
                smax: 64,
                slim: 4096,
                stot: 9400,
                req_rate: 12,
                req_tot: 25000,
                bin: 204800,
                bout: 1048576,
                hrsp_2xx: 24500,
                hrsp_4xx: 490,
                hrsp_5xx: 10,
              },
            },
            {
              type: 'backend',
              name: 'be_app',
              stats: {
                status: 'UP',
                mode: 'http',
                algo: 'roundrobin',
                act: 1,
                bck: 0,
                scur: 9,
                smax: 30,
                stot: 9400,
                bin: 204800,
                bout: 1048576,
                hrsp_2xx: 24500,
                hrsp_4xx: 490,
                hrsp_5xx: 10,
                rtime: 8,
              },
            },
            {
              type: 'server',
              name: 'srv_01',
              backend_name: 'be_app',
              stats: {
                status: 'UP',
                addr: '10.0.1.11:13000',
                weight: currentWeight,
                scur: 9,
                smax: 30,
                stot: 9400,
                bin: 204800,
                bout: 1048576,
                hrsp_2xx: 24500,
                hrsp_4xx: 490,
                hrsp_5xx: 10,
                check_status: 'L7OK',
                check_code: 200,
                check_duration: 2,
              },
            },
          ],
        }),
      );
      return;
    }

    if (req.method === 'GET' && pathname === '/v3/services/haproxy/runtime/backends/be_app/servers') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            id: '1',
            name: 'srv_01',
            backend_name: 'be_app',
            address: '10.0.1.11',
            port: 13000,
            admin_state: currentAdminState,
            operational_state: currentAdminState === 'drain' ? 'stopping' : 'up',
            weight: currentWeight,
            uweight: currentWeight,
            iweight: 100,
          },
        ]),
      );
      return;
    }

    if (req.method === 'PUT' && pathname === '/v3/services/haproxy/runtime/backends/be_app/servers/srv_01') {
      readBody((buf) => {
        const parsed = JSON.parse(buf.toString('utf8')) as Record<string, unknown>;
        lastPutBody = parsed;
        if (typeof parsed.admin_state === 'string') {
          currentAdminState = parsed.admin_state;
        }
        if (typeof parsed.weight === 'number') {
          currentWeight = parsed.weight;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: '1',
            name: 'srv_01',
            backend_name: 'be_app',
            address: '10.0.1.11',
            port: 13000,
            admin_state: currentAdminState,
            operational_state: currentAdminState === 'drain' ? 'stopping' : 'up',
            weight: currentWeight,
          }),
        );
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 404, message: `Not found: ${req.method} ${pathname}` }));
  });

  return {
    server,
    getState: () => ({ rawCfg, configVersion, lastPutBody, lastRawContentType, lastSslMultipart, certs }),
  };
}

describe('DataplaneV3Client zero-SSH configuration, transactions, raw sync, and storage', () => {
  const node1 = startMockDataplaneNode('lb-edge-01');
  const node2 = startMockDataplaneNode('lb-edge-02');
  let baseUrl1 = '';
  let baseUrl2 = '';

  beforeAll(async () => {
    await Promise.all([
      new Promise<void>((resolve) => node1.server.listen(0, '127.0.0.1', () => resolve())),
      new Promise<void>((resolve) => node2.server.listen(0, '127.0.0.1', () => resolve())),
    ]);
    baseUrl1 = `http://127.0.0.1:${(node1.server.address() as AddressInfo).port}`;
    baseUrl2 = `http://127.0.0.1:${(node2.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await Promise.all([
      new Promise<void>((resolve) => node1.server.close(() => resolve())),
      new Promise<void>((resolve) => node2.server.close(() => resolve())),
    ]);
  });

  it('normalizes valid v3 URLs and rejects unsafe storage filenames, v2 paths, and cloud metadata', () => {
    expect(normalizeDataplaneV3BaseUrl('http://haproxy:5555')).toBe('http://haproxy:5555/v3');
    expect(normalizeDataplaneV3BaseUrl('https://haproxy.internal:5555/v3/')).toBe('https://haproxy.internal:5555/v3');
    expect(assertSafeStorageFileName('wildcard.example.com.pem')).toBe('wildcard.example.com.pem');

    expect(() => assertSafeStorageFileName('../etc/passwd')).toThrow(/Invalid storage/i);
    expect(() => assertSafeStorageFileName('sub/cert.pem')).toThrow(/Invalid storage/i);
    expect(() => normalizeDataplaneV3BaseUrl('http://haproxy:5555/v2')).toThrow(/v3/);
    expect(() => normalizeDataplaneV3BaseUrl('http://user:pass@haproxy:5555')).toThrow(/credentials/i);
    expect(() => normalizeDataplaneV3BaseUrl('http://169.254.169.254/latest')).toThrow(/metadata/i);
  });

  it('manages live runtime servers, transactions, structured frontends, raw text/plain config, and SSL storage', async () => {
    const client = new DataplaneV3Client({
      baseUrl: baseUrl1,
      authType: 'basic',
      username: 'admin',
      password: 's3cr3t',
    });

    const snapshot = await client.getSnapshot(1, 'prod-lb-1');
    expect(snapshot.configVersion).toBe(3);
    expect(snapshot.apiInfo.hostname).toBe('lb-edge-01');
    expect(snapshot.servers[0]).toMatchObject({
      backendName: 'be_app',
      name: 'srv_01',
      adminState: 'ready',
      weight: 100,
    });

    // Runtime drain + weight
    const drained = await client.updateRuntimeServer('be_app', 'srv_01', { adminState: 'drain', weight: 50 });
    expect(node1.getState().lastPutBody).toEqual({ admin_state: 'drain', weight: 50 });
    expect(drained.adminState).toBe('drain');
    expect(drained.weight).toBe(50);

    // Transaction stage + commit
    const tx = await client.startTransaction();
    expect(tx.id).toBe('tx-unit-01');
    await client.createFrontend({ name: 'fe_api', mode: 'http', default_backend: 'be_app' }, { transactionId: tx.id });
    const committed = await client.commitTransaction(tx.id, true);
    expect(committed.meta.reloadId).toBe('2026-11-25-0');
    expect(committed.meta.configurationVersion).toBe(4);

    // Raw haproxy.cfg read + text/plain push
    const rawBefore = await client.getRawConfig();
    expect(rawBefore.version).toBe(4);
    expect(rawBefore.checksum).toBe('deadbeef123456');
    const rawMeta = await client.pushRawConfig('global\n  maxconn 4096\n', { forceReload: true });
    expect(node1.getState().lastRawContentType).toBe('text/plain');
    expect(rawMeta.configurationVersion).toBe(5);

    // SSL multipart upload + text/plain replace
    const uploaded = await client.uploadSslCertificate('edge.pem', '-----BEGIN CERTIFICATE-----\nMIIB...\n');
    expect(uploaded.cert?.storage_name).toBe('edge.pem');
    expect(node1.getState().lastSslMultipart).toContain('filename="edge.pem"');
    const replaced = await client.replaceSslCertificate('edge.pem', '-----BEGIN CERTIFICATE-----\nNEW...\n');
    expect(replaced.meta.reloadId).toBe('2026-11-25-ssl');
  });

  it('executes fleetOverview, pushRawConfigBatch, and syncSslCertificateBatch across multiple HAProxy servers', async () => {
    const rows = [
      {
        id: 1,
        name: 'lb-01',
        title: 'LB 01',
        baseUrl: baseUrl1,
        authType: 'basic',
        username: 'admin',
        password: 'enc:s3cr3t',
        enabled: true,
      },
      {
        id: 2,
        name: 'lb-02',
        title: 'LB 02',
        baseUrl: baseUrl2,
        authType: 'basic',
        username: 'admin',
        password: 'enc:s3cr3t',
        enabled: true,
      },
    ];
    const wrap = (r: Record<string, unknown>) => ({ get: (k: string) => r[k] });

    const app = {
      aesEncryptor: {
        encrypt: vi.fn(async (s: string) => `enc:${s}`),
        decrypt: vi.fn(async (s: string) => (s.startsWith('enc:') ? s.slice(4) : s)),
      },
      db: {
        getRepository: vi.fn(() => ({
          find: vi.fn(async () => rows.map(wrap)),
          findOne: vi.fn(async ({ filterByTk }: { filterByTk: number }) => {
            const hit = rows.find((r) => r.id === Number(filterByTk));
            return hit ? wrap(hit) : null;
          }),
        })),
      },
      on: vi.fn(),
      off: vi.fn(),
    };

    const plugin = new PluginHaproxyDataplaneServer(app as unknown as PluginApp, {});
    const actions = createHaproxyDataplaneActions(plugin);

    const makeCtx = (params: Record<string, unknown>) =>
      ({
        state: { currentRoles: ['root'] },
        action: { params },
        body: undefined as unknown,
        throw(status: number, msg: string) {
          throw Object.assign(new Error(msg), { status });
        },
      }) as unknown as Context;

    const fleetCtx = makeCtx({});
    await actions.fleetOverview(fleetCtx, async () => {});
    expect(fleetCtx.body).toEqual([
      expect.objectContaining({ connectionId: 1, reachable: true, hostname: 'lb-edge-01' }),
      expect.objectContaining({ connectionId: 2, reachable: true, hostname: 'lb-edge-02' }),
    ]);

    const syncCfgCtx = makeCtx({
      values: {
        targetConnectionIds: [1, 2],
        content: 'global\n  maxconn 8192\n',
        forceReload: true,
        skipVersion: true,
      },
    });
    await actions.pushRawConfigBatch(syncCfgCtx, async () => {});
    expect(syncCfgCtx.body).toEqual({
      results: [
        expect.objectContaining({ connectionId: 1, connectionName: 'lb-01', ok: true }),
        expect.objectContaining({ connectionId: 2, connectionName: 'lb-02', ok: true }),
      ],
    });
    expect(node2.getState().rawCfg).toContain('maxconn 8192');

    // Sync SSL certificate across both nodes (replaces on node 1 if present, uploads on node 2)
    const syncSslCtx = makeCtx({
      values: {
        targetConnectionIds: [1, 2],
        fileName: 'edge.pem',
        pemContent: '-----BEGIN CERTIFICATE-----\nCLUSTER...\n',
        forceReload: true,
      },
    });
    await actions.syncSslCertificateBatch(syncSslCtx, async () => {});
    expect(syncSslCtx.body).toEqual({
      results: [
        expect.objectContaining({ connectionId: 1, ok: true }),
        expect.objectContaining({ connectionId: 2, ok: true }),
      ],
    });
    expect(node2.getState().certs.has('edge.pem')).toBe(true);
  });

  it('captures config revisions, computes visual & live server drift diffs, rolls back 1-click, and records audit logs', async () => {
    // 1. Unit verify line-by-line LCS diff engine (including CRLF normalization)
    const unitDiff = computeConfigDiff(
      'global\r\n  maxconn 2000\r\n  daemon\r\n',
      'global\n  maxconn 4096\n  daemon\n',
      'rev-1',
      'live',
    );
    expect(unitDiff.identical).toBe(false);
    expect(unitDiff.addedCount).toBe(1);
    expect(unitDiff.deletedCount).toBe(1);
    expect(computeConfigDiff('global\r\n  daemon\r\n', 'global\n  daemon\n', 'a', 'b').identical).toBe(true);

    // 2. Integration verify snapshots, cross-node drift, rollback, and audit logs
    const connRows = [
      {
        id: 1,
        name: 'lb-01',
        title: 'LB 01',
        baseUrl: baseUrl1,
        authType: 'basic',
        username: 'admin',
        password: 'enc:s3cr3t',
        enabled: true,
      },
      {
        id: 2,
        name: 'lb-02',
        title: 'LB 02',
        baseUrl: baseUrl2,
        authType: 'basic',
        username: 'admin',
        password: 'enc:s3cr3t',
        enabled: true,
      },
    ];
    const revisionRows: Array<Record<string, unknown>> = [];
    const auditRows: Array<Record<string, unknown>> = [];
    let nextRevId = 1;
    let nextAuditId = 1;
    const wrap = (r: Record<string, unknown>) => ({ get: (k: string) => r[k] });

    const makeInMemoryRepo = (store: Array<Record<string, unknown>>, nextIdFn: () => number) => ({
      find: vi.fn(async ({ filter }: { filter?: Record<string, unknown> } = {}) => {
        const filtered = store
          .filter((r) => {
            if (filter?.connectionId != null && Number(r.connectionId) !== Number(filter.connectionId)) return false;
            if (filter?.category != null && r.category !== filter.category) return false;
            return true;
          })
          .sort((a, b) => Number(b.id) - Number(a.id));
        return filtered.map(wrap);
      }),
      findOne: vi.fn(async ({ filterByTk }: { filterByTk: number }) => {
        const hit = store.find((r) => Number(r.id) === Number(filterByTk));
        return hit ? wrap(hit) : null;
      }),
      create: vi.fn(async ({ values }: { values: Record<string, unknown> }) => {
        const created = { id: nextIdFn(), createdAt: '2026-11-25T12:00:00.000Z', ...values };
        store.push(created);
        return wrap(created);
      }),
      destroy: vi.fn(async ({ filterByTk }: { filterByTk: number }) => {
        const idx = store.findIndex((r) => Number(r.id) === Number(filterByTk));
        if (idx >= 0) store.splice(idx, 1);
      }),
    });

    const revRepo = makeInMemoryRepo(revisionRows, () => nextRevId++);
    const auditRepo = makeInMemoryRepo(auditRows, () => nextAuditId++);
    const connRepo = {
      find: vi.fn(async () => connRows.map(wrap)),
      findOne: vi.fn(async ({ filterByTk }: { filterByTk: number }) => {
        const hit = connRows.find((r) => r.id === Number(filterByTk));
        return hit ? wrap(hit) : null;
      }),
    };

    const app = {
      aesEncryptor: {
        encrypt: vi.fn(async (s: string) => `enc:${s}`),
        decrypt: vi.fn(async (s: string) => (s.startsWith('enc:') ? s.slice(4) : s)),
      },
      db: {
        getRepository: vi.fn((name: string) => {
          if (name === COLLECTIONS.revisions) return revRepo;
          if (name === COLLECTIONS.auditLogs) return auditRepo;
          return connRepo;
        }),
      },
      on: vi.fn(),
      off: vi.fn(),
    };

    const plugin = new PluginHaproxyDataplaneServer(app as unknown as PluginApp, {});
    const actions = createHaproxyDataplaneActions(plugin);

    const makeCtx = (params: Record<string, unknown>) =>
      ({
        state: { currentRoles: ['root'], currentUser: { id: 7, nickname: 'DevOps Lead' } },
        action: { params },
        body: undefined as unknown,
        throw(status: number, msg: string) {
          throw Object.assign(new Error(msg), { status });
        },
      }) as unknown as Context;

    // Take baseline manual snapshot on lb-01 (currently maxconn 8192 from earlier test)
    const snapCtx = makeCtx({ values: { connectionId: 1, summary: 'Golden baseline' } });
    await actions.createSnapshot(snapCtx, async () => {});
    const baselineSnap = snapCtx.body as HaproxyConfigRevisionSummary;
    expect(baselineSnap.id).toBe(1);
    expect(baselineSnap.source).toBe('manual_snapshot');
    expect(baselineSnap.actorName).toBe('DevOps Lead');

    // Push a diverging config onto lb-01 only -> auto-snapshot #2 + drift against lb-02
    const pushCtx = makeCtx({
      values: {
        connectionId: 1,
        content: 'global\n  maxconn 16384\n',
        forceReload: true,
        skipVersion: true,
      },
    });
    await actions.pushRawConfig(pushCtx, async () => {});
    expect(revisionRows).toHaveLength(2);

    // Compare lb-01 vs lb-02 live drift
    const driftCtx = makeCtx({ leftConnectionId: 1, rightConnectionId: 2 });
    await actions.diffLiveNodes(driftCtx, async () => {});
    const driftResult = driftCtx.body as ConfigDiffResult;
    expect(driftResult.identical).toBe(false);
    expect(driftResult.addedCount).toBe(1);
    expect(driftResult.deletedCount).toBe(1);

    // Compare revision #1 vs live lb-01
    const revDiffCtx = makeCtx({ leftRevisionId: 1, rightRevisionId: 'live', connectionId: 1 });
    await actions.diffRevisions(revDiffCtx, async () => {});
    expect((revDiffCtx.body as ConfigDiffResult).identical).toBe(false);

    // Rollback lb-01 to revision #1 -> restores maxconn 8192 so lb-01 and lb-02 are identical again
    const rbCtx = makeCtx({ values: { revisionId: 1, forceReload: true, skipVersion: true } });
    await actions.rollbackRevision(rbCtx, async () => {});
    expect(node1.getState().rawCfg).toBe('global\n  maxconn 8192\n');

    const postRollbackDriftCtx = makeCtx({ leftConnectionId: 1, rightConnectionId: 2 });
    await actions.diffLiveNodes(postRollbackDriftCtx, async () => {});
    expect((postRollbackDriftCtx.body as ConfigDiffResult).identical).toBe(true);

    // Verify audit trail entries
    const auditCtx = makeCtx({ connectionId: 1 });
    await actions.listAuditLogs(auditCtx, async () => {});
    const logs = auditCtx.body as HaproxyAuditLogRecord[];
    expect(logs.map((l) => l.action)).toEqual(['rollbackRevision', 'pushRawConfig', 'createSnapshot']);
    expect(logs[0]?.actorName).toBe('DevOps Lead');
  });
});

describe('PluginHaproxyDataplaneServer security, ACL, and bundle boundaries', () => {
  it('registers all ACL snippets, scrubs passwords/PEM/raw config from logs, and enforces resource guards', async () => {
    const appMiddlewares: Array<(ctx: Record<string, unknown>, next: () => Promise<void>) => Promise<void>> = [];
    const registerSnippet = vi.fn();
    const allow = vi.fn();
    const defineResource = vi.fn();
    const useResourceMiddleware = vi.fn();
    const dbImport = vi.fn().mockResolvedValue(undefined);

    const app = {
      db: { import: dbImport },
      use: vi.fn((fn) => appMiddlewares.push(fn)),
      resourceManager: {
        use: useResourceMiddleware,
        define: defineResource,
      },
      acl: {
        registerSnippet,
        allow,
      },
      on: vi.fn(),
      off: vi.fn(),
    };

    const plugin = new PluginHaproxyDataplaneServer(app as unknown as PluginApp, {});
    await plugin.load();

    expect(dbImport).toHaveBeenCalledTimes(1);
    expect(defineResource).toHaveBeenCalledWith(expect.objectContaining({ name: RESOURCE_NAME }));
    expect(registerSnippet.mock.calls.map(([s]: [{ name: string }]) => s.name)).toEqual([
      HAPROXY_SNIPPETS.access,
      HAPROXY_SNIPPETS.read,
      HAPROXY_SNIPPETS.runtime,
      HAPROXY_SNIPPETS.config,
      HAPROXY_SNIPPETS.rawConfig,
      HAPROXY_SNIPPETS.storage,
      HAPROXY_SNIPPETS.connections,
      HAPROXY_SNIPPETS.manage,
    ]);
    expect(allow).toHaveBeenCalledWith(RESOURCE_NAME, 'myPermissions', 'loggedIn');

    // Redaction of password, pemContent, and raw config content
    const redactMiddleware = appMiddlewares[0];
    const reqBody = {
      password: 'plain-password',
      values: {
        password: 'nested-password',
        pemContent: '-----BEGIN PRIVATE KEY-----',
        content: 'userlist admins\n  user root insecure-password secret',
      },
    };
    const logCtx = {
      action: {
        resourceName: RESOURCE_NAME,
        params: { values: { ...reqBody.values } },
      },
      request: { body: reqBody },
    };
    await redactMiddleware(logCtx, async () => {});
    expect(reqBody.password).toBe(SECRET_MASK);
    expect(reqBody.values.password).toBe(SECRET_MASK);
    expect(reqBody.values.pemContent).toBe(SECRET_MASK);
    expect(reqBody.values.content).toBe(SECRET_MASK);
    expect(logCtx.action.params.values.pemContent).toBe(SECRET_MASK);

    const guard = createHaproxyResourceGuardMiddleware();
    const makeGuardCtx = (resourceName: string, actionName: string, method: string) =>
      ({
        method,
        action: { resourceName, actionName, params: {} },
        throw(status: number, msg: string) {
          throw Object.assign(new Error(msg), { status });
        },
      }) as unknown as Context;

    await expect(guard(makeGuardCtx(COLLECTIONS.connections, 'list', 'GET'), async () => {})).rejects.toThrow(
      /Direct collection access is disabled/,
    );
    await expect(guard(makeGuardCtx(COLLECTIONS.revisions, 'list', 'GET'), async () => {})).rejects.toThrow(
      /Direct collection access is disabled/,
    );
    await expect(guard(makeGuardCtx(COLLECTIONS.auditLogs, 'list', 'GET'), async () => {})).rejects.toThrow(
      /Direct collection access is disabled/,
    );
    await expect(guard(makeGuardCtx(RESOURCE_NAME, 'pushRawConfigBatch', 'GET'), async () => {})).rejects.toThrow(
      /HTTP GET is not allowed/,
    );
    await expect(guard(makeGuardCtx(RESOURCE_NAME, 'rollbackRevision', 'GET'), async () => {})).rejects.toThrow(
      /HTTP GET is not allowed/,
    );
    await expect(guard(makeGuardCtx(RESOURCE_NAME, 'upsertReverseProxy', 'GET'), async () => {})).rejects.toThrow(
      /HTTP GET is not allowed/,
    );
    await expect(
      guard(makeGuardCtx(RESOURCE_NAME, 'listReverseProxies', 'GET'), async () => {}),
    ).resolves.toBeUndefined();
    await expect(guard(makeGuardCtx(RESOURCE_NAME, 'fleetOverview', 'GET'), async () => {})).resolves.toBeUndefined();
  });

  it('masks secrets for admins, hides sensitive fields from read-only viewers, and blocks cross-origin password reuse', async () => {
    const records = new Map<number, Record<string, unknown>>();
    let nextId = 1;
    const wrapModel = (row: Record<string, unknown>) => ({ get: (k: string) => row[k] });

    const repo = {
      find: vi.fn(async ({ filter }: { filter?: { enabled?: boolean } }) => {
        const all = Array.from(records.values()).filter((r) => (filter?.enabled === true ? r.enabled !== false : true));
        return all.map(wrapModel);
      }),
      findOne: vi.fn(async ({ filterByTk, filter }: { filterByTk?: number; filter?: { name?: string } }) => {
        if (filterByTk != null) {
          const hit = records.get(Number(filterByTk));
          return hit ? wrapModel(hit) : null;
        }
        if (filter?.name) {
          const hit = Array.from(records.values()).find((r) => r.name === filter.name);
          return hit ? wrapModel(hit) : null;
        }
        return null;
      }),
      create: vi.fn(async ({ values }: { values: Record<string, unknown> }) => {
        const id = nextId++;
        const saved = { id, ...values };
        records.set(id, saved);
        return wrapModel(saved);
      }),
      update: vi.fn(async ({ filterByTk, values }: { filterByTk: number; values: Record<string, unknown> }) => {
        const existing = records.get(Number(filterByTk));
        if (existing) Object.assign(existing, values);
      }),
      destroy: vi.fn(async ({ filterByTk }: { filterByTk: number }) => {
        records.delete(Number(filterByTk));
      }),
    };

    const auditStore: Array<Record<string, unknown>> = [];
    const auditMockRepo = {
      find: vi.fn(async () => auditStore.map(wrapModel)),
      create: vi.fn(async ({ values }: { values: Record<string, unknown> }) => {
        const entry = { id: auditStore.length + 1, ...values };
        auditStore.push(entry);
        return wrapModel(entry);
      }),
      destroy: vi.fn(),
    };

    const app = {
      aesEncryptor: {
        encrypt: vi.fn(async (s: string) => `enc:${s}`),
        decrypt: vi.fn(async (s: string) => (s.startsWith('enc:') ? s.slice(4) : s)),
      },
      environment: {
        getNonSecretVariables: () => ({ HAPROXY_URL: 'http://10.0.0.10:5555' }),
        getVariablesAndSecrets: () => ({ HAPROXY_URL: 'http://10.0.0.10:5555', HAPROXY_PASS: 'env-secret' }),
      },
      db: {
        getRepository: vi.fn((name: string) => (name === COLLECTIONS.auditLogs ? auditMockRepo : repo)),
      },
      on: vi.fn(),
      off: vi.fn(),
    };

    const plugin = new PluginHaproxyDataplaneServer(app as unknown as PluginApp, {});
    const actions = createHaproxyDataplaneActions(plugin);

    const makeActionCtx = (roles: string[], allowedActions: string[], params: Record<string, unknown>) =>
      ({
        state: { currentRoles: roles },
        action: { params },
        body: undefined as unknown,
        can: ({ resource, action }: { resource: string; action: string }) =>
          resource === RESOURCE_NAME ? allowedActions.includes(action) : false,
        throw(status: number, msg: string) {
          throw Object.assign(new Error(msg), { status });
        },
      }) as unknown as Context;

    const noEnvCtx = makeActionCtx(['admin'], ['createConnection'], {
      values: { name: 'lb-env', baseUrl: '{{$env.HAPROXY_URL}}', authType: 'basic', username: 'u', password: 'p' },
    });
    await expect(actions.createConnection(noEnvCtx, async () => {})).rejects.toThrow(/environmentVariables/);

    const rootCreateCtx = makeActionCtx(['root'], [], {
      values: {
        values: {
          name: 'lb-main',
          title: 'Main LB',
          baseUrl: 'http://10.0.0.10:5555',
          authType: 'basic',
          username: 'admin',
          password: 'my-password',
        },
      },
    });
    await actions.createConnection(rootCreateCtx, async () => {});
    expect(records.get(1)?.password).toBe('enc:my-password');
    expect(rootCreateCtx.body).toMatchObject({ id: 1, password: SECRET_MASK });

    const readerCtx = makeActionCtx(['viewer'], ['getSnapshot', 'listConnections'], {});
    await actions.listConnections(readerCtx, async () => {});
    expect(readerCtx.body).toEqual([expect.objectContaining({ id: 1, baseUrl: '', username: null, password: null })]);

    const changeHostCtx = makeActionCtx(['root'], [], {
      values: { id: 1, baseUrl: 'http://attacker.example:5555', password: SECRET_MASK },
    });
    await expect(actions.updateConnection(changeHostCtx, async () => {})).rejects.toThrow(/Re-enter the password/);
  });

  it('keeps client v1 bundle free of client-v2 imports when built', () => {
    const v1BundlePath = path.resolve(__dirname, '../../../dist/client/index.js');
    if (fs.existsSync(v1BundlePath)) {
      const bundle = fs.readFileSync(v1BundlePath, 'utf8');
      expect(bundle).not.toContain('"@nocobase/client-v2"');
      expect(bundle).not.toContain("'@nocobase/client-v2'");
    }
  });
});
