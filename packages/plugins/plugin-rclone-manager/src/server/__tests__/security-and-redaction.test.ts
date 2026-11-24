// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import { PassThrough } from 'node:stream';
import type { Context } from '@nocobase/actions';
import { describe, expect, it, vi } from 'vitest';
import { coerceRemoteParamsForForm } from '../../client-v2/utils/format';
import { COLLECTIONS, RCLONE_TRANSFER_INSTRUCTION_TYPE, RESOURCE_NAME, SECRET_MASK } from '../../shared/constants';
import { isConnectionStringOverride, isLocalFsTarget, normalizeRemoteSubPath } from '../../shared/fs-guard';
import { resolveSignedDownloadUrl } from '../../shared/signed-url';
import { createRcloneManagerActions } from '../actions/rclone-manager';
import { createRcloneResourceGuardMiddleware, RCLONE_ACTION_METHODS } from '../middlewares/request-method-policy';
import { assertFsTargetsPermitted, assertLocalFsPermitted, RCLONE_ACTIONS } from '../permissions';
import type PluginRcloneManagerServer from '../plugin';
import { RcloneConnectionManager } from '../services/connection-manager';
import { maskRemoteConfig, mergeRemoteConfigForUpdate } from '../utils/secret-redactor';
import { createStreamingZip } from '../utils/streaming-zip';
import {
  __resetSigningSecretForTest,
  buildContentDisposition,
  signStreamPayload,
  verifyStreamSignature,
} from '../utils/url-signing';

describe('Filesystem guard & traversal protection', () => {
  it('accurately distinguishes local paths and type=local remotes from cloud remotes', () => {
    const remoteTypes = {
      's3-prod': 's3',
      'gdrive-corp': 'drive',
      'host-mirror': 'local',
    };

    expect(isLocalFsTarget('', remoteTypes)).toBe(true);
    expect(isLocalFsTarget('/etc/passwd', remoteTypes)).toBe(true);
    expect(isLocalFsTarget('C:\\Users\\Administrator', remoteTypes)).toBe(true);
    expect(isLocalFsTarget('D:/backups', remoteTypes)).toBe(true);
    expect(isLocalFsTarget(':local:/var/log', remoteTypes)).toBe(true);
    expect(isLocalFsTarget('host-mirror:subfolder', remoteTypes)).toBe(true);

    expect(isLocalFsTarget('s3-prod:my-bucket/2026', remoteTypes)).toBe(false);
    expect(isLocalFsTarget('gdrive-corp:', remoteTypes)).toBe(false);
    expect(isLocalFsTarget(':s3,provider=AWS:bucket', remoteTypes)).toBe(false);

    // On-the-fly wrapper backends (alias/crypt/union...) must be treated as local
    expect(isLocalFsTarget(':alias,remote=/etc:', remoteTypes)).toBe(true);
    expect(isLocalFsTarget(':crypt,remote=/var/data:', remoteTypes)).toBe(true);

    // On-the-fly connection strings and inline comma overrides (including option values containing `/`) must be detected separately
    expect(isConnectionStringOverride(':http,url=http://169.254.169.254/:')).toBe(true);
    expect(isConnectionStringOverride('corp-sftp,host=attacker.com:path')).toBe(true);
    expect(isConnectionStringOverride('corp-sftp,key_file=/etc/ssh/id_rsa,host=attacker.com:')).toBe(true);
    expect(isConnectionStringOverride('/tmp/backup:2026')).toBe(false);
    expect(isConnectionStringOverride('s3-prod:my-bucket/2026')).toBe(false);
    expect(isConnectionStringOverride('C:/backups')).toBe(false);
  });

  it('normalizes relative remote sub-paths while preserving component whitespace and blocking .. traversal', () => {
    expect(normalizeRemoteSubPath('/reports\\2026/./q4/')).toBe('reports/2026/q4');
    expect(normalizeRemoteSubPath('/')).toBe('');
    expect(normalizeRemoteSubPath('report.txt ')).toBe('report.txt ');
    expect(normalizeRemoteSubPath(' report.txt')).toBe(' report.txt');
    expect(normalizeRemoteSubPath('/folder /report.txt ')).toBe('folder /report.txt ');
    expect(() => normalizeRemoteSubPath('reports/../../etc/shadow')).toThrow(/traversal/i);
  });

  it('enforces local-fs high-privilege permission when accessing local paths', () => {
    const throwFn = vi.fn((status: number, msg: string) => {
      throw Object.assign(new Error(msg), { status });
    });

    const regularCtx = {
      state: { currentRoles: ['member'] },
      can: vi.fn(({ action }: { action: string }) => action !== 'listDisks'),
      throw: throwFn,
    } as unknown as Context;

    expect(() => assertLocalFsPermitted(regularCtx, ['s3-prod:bucket'], { 's3-prod': 's3' })).not.toThrow();
    expect(() => assertLocalFsPermitted(regularCtx, ['/var/data'], { 's3-prod': 's3' })).toThrow(/local-fs/);
    expect(() => assertLocalFsPermitted(regularCtx, ['local-alias:docs'], { 'local-alias': 'local' })).toThrow(
      /local-fs/,
    );

    const adminCtx = {
      state: { currentRoles: ['infra-admin'] },
      can: vi.fn(() => true),
      throw: throwFn,
    } as unknown as Context;
    expect(() => assertLocalFsPermitted(adminCtx, ['/var/data'], {})).not.toThrow();
  });

  it('blocks ad-hoc connection strings and comma parameter overrides unless user has raw-config and local-fs', async () => {
    const throwFn = (status: number, msg: string) => {
      throw Object.assign(new Error(msg), { status });
    };
    const fakeClient = { isFsLocal: vi.fn(async () => false) };
    const readOnlyCtx = {
      state: { currentRoles: ['reader'] },
      can: vi.fn(({ action }: { action: string }) => action === 'dashboardSummary'),
      throw: throwFn,
    } as unknown as Context;

    await expect(
      assertFsTargetsPermitted(readOnlyCtx, fakeClient, [':http,url=http://169.254.169.254/:']),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      assertFsTargetsPermitted(readOnlyCtx, fakeClient, ['corp-sftp,host=attacker.com:']),
    ).rejects.toMatchObject({ status: 403 });
    await expect(assertFsTargetsPermitted(readOnlyCtx, fakeClient, ['s3-prod:bucket'])).resolves.toBeUndefined();

    // User with local-fs but WITHOUT raw-config must still be blocked from slash-containing comma overrides
    const localOnlyCtx = {
      state: { currentRoles: ['local-operator'] },
      can: vi.fn(({ action }: { action: string }) => action !== 'saveRawConfig'),
      throw: throwFn,
    } as unknown as Context;
    await expect(
      assertFsTargetsPermitted(localOnlyCtx, fakeClient, ['corp-sftp,key_file=/etc/ssh/id_rsa,host=attacker.com:']),
    ).rejects.toMatchObject({ status: 403 });

    const fullAdminCtx = {
      state: { currentRoles: ['root'] },
      can: vi.fn(() => true),
      throw: throwFn,
    } as unknown as Context;
    await expect(
      assertFsTargetsPermitted(fullAdminCtx, fakeClient, [':http,url=https://example.com/:']),
    ).resolves.toBeUndefined();
  });
});

describe('Secret masking, signed URLs, and resource guard middleware', () => {
  it('masks sensitive remote fields, omits untouched masked secrets, and explicitly clears emptied keys on update', () => {
    const providerOptions = [
      { Name: 'provider', IsPassword: false },
      { Name: 'access_key_id', IsPassword: false },
      { Name: 'secret_access_key', IsPassword: true },
      { Name: 'pass', IsPassword: true },
    ];
    const raw = {
      type: 's3',
      provider: 'AWS',
      access_key_id: 'AKIA123',
      secret_access_key: 'TOP_SECRET_VALUE',
      pass: 'OBSCURED_EXISTING_PASS',
      token: '{"access_token":"oauth-secret"}',
    };

    const masked = maskRemoteConfig(raw, providerOptions);
    expect(masked).toEqual({
      type: 's3',
      provider: 'AWS',
      access_key_id: SECRET_MASK,
      secret_access_key: SECRET_MASK,
      pass: SECRET_MASK,
      token: SECRET_MASK,
    });

    const merged = mergeRemoteConfigForUpdate(
      raw,
      {
        provider: 'Minio',
        access_key_id: SECRET_MASK,
        pass: SECRET_MASK,
        secret_access_key: 'NEW_ROTATED_SECRET',
        token: '',
        unset_optional: '',
      },
      providerOptions,
    );

    // Untouched masked secrets are omitted so Rclone keeps existing single-obscured values; cleared existing keys send "".
    expect(merged).toEqual({
      provider: 'Minio',
      secret_access_key: 'NEW_ROTATED_SECRET',
      token: '',
    });
  });

  it('signs and verifies download stream URLs and formats UTF-8 Content-Disposition', () => {
    process.env.RCLONE_STREAM_URL_SECRET = 'unit-test-hmac-secret';
    __resetSigningSecretForTest();

    const validPayload = {
      connectionId: 5,
      fs: 's3-prod:invoices',
      remote: '2026/Báo cáo quý 4.pdf',
      isDir: false,
      mode: 'attachment' as const,
      expires: Date.now() + 60_000,
    };

    const sig = signStreamPayload(validPayload, { appName: 'app-alpha' });
    expect(verifyStreamSignature(validPayload, sig, { appName: 'app-alpha' })).toBe(true);
    // Shared signing key must NOT validate across different NocoBase applications
    expect(verifyStreamSignature(validPayload, sig, { appName: 'app-beta' })).toBe(false);
    expect(verifyStreamSignature(validPayload, sig)).toBe(false);
    expect(verifyStreamSignature({ ...validPayload, fs: 's3-prod:other' }, sig, { appName: 'app-alpha' })).toBe(false);
    expect(verifyStreamSignature({ ...validPayload, expires: Date.now() - 1000 }, sig, { appName: 'app-alpha' })).toBe(
      false,
    );

    const disposition = buildContentDisposition('Báo cáo quý 4.pdf', 'attachment');
    expect(disposition).toContain('attachment; filename="B_o c_o qu_ 4.pdf"');
    expect(disposition).toContain("filename*=UTF-8''B%C3%A1o%20c%C3%A1o%20qu%C3%BD%204.pdf");
  });

  it('blocks direct REST access to private collections and enforces HTTP methods', async () => {
    const guard = createRcloneResourceGuardMiddleware();
    const makeCtx = (resourceName: string, actionName: string, method: string) =>
      ({
        method,
        action: { resourceName, actionName, params: {} },
        throw: (status: number, msg: string) => {
          throw Object.assign(new Error(msg), { status });
        },
      }) as unknown as Context;

    await expect(guard(makeCtx(COLLECTIONS.connections, 'list', 'GET'), async () => {})).rejects.toMatchObject({
      status: 403,
    });
    await expect(guard(makeCtx(COLLECTIONS.tasks, 'create', 'POST'), async () => {})).rejects.toMatchObject({
      status: 403,
    });
    await expect(guard(makeCtx(RESOURCE_NAME, 'deleteRemote', 'GET'), async () => {})).rejects.toMatchObject({
      status: 405,
    });

    const next = vi.fn().mockResolvedValue(undefined);
    await guard(makeCtx(RESOURCE_NAME, 'dashboardSummary', 'GET'), next);
    expect(next).toHaveBeenCalledTimes(1);

    expect(RCLONE_ACTION_METHODS).not.toHaveProperty('setConfigPath');
    expect(RCLONE_ACTION_METHODS).not.toHaveProperty('getOptionsInfo');
  });

  it('enforces local-fs ACL when creating, updating, or duplicating rclone-transfer workflow nodes with allowLocalPaths', async () => {
    const guard = createRcloneResourceGuardMiddleware();
    const makeNodeCtx = (
      resourceName: string,
      actionName: string,
      params: Record<string, unknown>,
      canLocalFs: boolean,
      existingNode?: { type: string; config?: Record<string, unknown> },
    ) =>
      ({
        method: 'POST',
        state: { currentRoles: [canLocalFs ? 'infra-admin' : 'workflow-editor'] },
        can: () => canLocalFs,
        action: { resourceName, actionName, params },
        db: {
          getRepository: () => ({
            findOne: vi.fn(async () =>
              existingNode ? { get: (k: string) => (existingNode as Record<string, unknown>)[k] } : null,
            ),
          }),
        },
        throw: (status: number, msg: string) => {
          throw Object.assign(new Error(msg), { status });
        },
      }) as unknown as Context;

    // Non-local-fs user cannot create or import an rclone-transfer node with allowLocalPaths: true
    await expect(
      guard(
        makeNodeCtx(
          'workflows.nodes',
          'create',
          { values: { type: RCLONE_TRANSFER_INSTRUCTION_TYPE, config: { allowLocalPaths: true } } },
          false,
        ),
        async () => {},
      ),
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      guard(
        makeNodeCtx(
          'workflows',
          'create',
          { values: { nodes: [{ type: RCLONE_TRANSFER_INSTRUCTION_TYPE, config: { allowLocalPaths: true } }] } },
          false,
        ),
        async () => {},
      ),
    ).rejects.toMatchObject({ status: 403 });

    // Non-local-fs user cannot mutate srcFs on an existing allowLocalPaths=true node or duplicate it
    await expect(
      guard(
        makeNodeCtx('flow_nodes', 'update', { filterByTk: 42, values: { config: { srcFs: '/etc' } } }, false, {
          type: RCLONE_TRANSFER_INSTRUCTION_TYPE,
          config: { allowLocalPaths: true },
        }),
        async () => {},
      ),
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      guard(
        makeNodeCtx('flow_nodes', 'duplicate', { filterByTk: 42 }, false, {
          type: RCLONE_TRANSFER_INSTRUCTION_TYPE,
          config: { allowLocalPaths: true },
        }),
        async () => {},
      ),
    ).rejects.toMatchObject({ status: 403 });

    // Allowed when allowLocalPaths is false or user has local-fs permission
    const next = vi.fn().mockResolvedValue(undefined);
    await guard(
      makeNodeCtx(
        'workflows.nodes',
        'create',
        { values: { type: RCLONE_TRANSFER_INSTRUCTION_TYPE, config: { allowLocalPaths: false } } },
        false,
      ),
      next,
    );
    await guard(
      makeNodeCtx(
        'workflows.nodes',
        'create',
        { values: { type: RCLONE_TRANSFER_INSTRUCTION_TYPE, config: { allowLocalPaths: true } } },
        true,
      ),
      next,
    );
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('blocks env-ref bypass, cross-origin password reuse in connection actions, and combine/capitalized wrapper bypasses', async () => {
    const savedConn = {
      id: 1,
      name: 'prod-rcd',
      baseUrl: 'http://127.0.0.1:5572',
      authType: 'basic',
      username: 'admin',
      password: 'encrypted-prod-password',
      enabled: true,
    };
    const fakeConnModel = {
      get: (k: string) => (savedConn as Record<string, unknown>)[k],
      update: vi.fn(async () => {}),
    };
    let job15Stopped = false;
    const fakeRcClient = {
      isFsLocal: vi.fn(async (fsPath: string) => fsPath.startsWith('workspace:') || fsPath.startsWith('/')),
      listRemoteNames: vi.fn(async () => ['existing-s3']),
      createRemote: vi.fn(async () => ({})),
      getRemoteRaw: vi.fn(async () => ({ type: 'combine', upstreams: 's3=minio:bucket' })),
      listProviders: vi.fn(async () => []),
      updateRemote: vi.fn(async () => ({})),
      stopJob: vi.fn(async () => {
        job15Stopped = true;
      }),
      getJobStatus: vi.fn(async () => ({
        id: 15,
        finished: job15Stopped,
        success: false,
        error: job15Stopped ? 'context canceled' : '',
        group: 'nb-task-55-g',
        duration: 0.2,
      })),
    };
    const mockApp = {
      db: {
        getRepository: vi.fn(() => ({ findOne: vi.fn(async () => fakeConnModel) })),
      },
      aesEncryptor: {
        decrypt: vi.fn(async (v: string) => `plain:${v}`),
        encrypt: vi.fn(async (v: string) => `enc:${v}`),
      },
      environment: {
        getNonSecretVariables: () => ({}),
        getVariablesAndSecrets: () => ({ DB_PASSWORD: 'super-secret-db-pass' }),
      },
    };
    const connectionManager = new RcloneConnectionManager(mockApp as never);
    vi.spyOn(connectionManager, 'getClient').mockResolvedValue({
      model: fakeConnModel as never,
      client: fakeRcClient as never,
    });
    const actions = createRcloneManagerActions({
      app: mockApp,
      db: mockApp.db,
      connectionManager,
    } as unknown as PluginRcloneManagerServer);

    const makeActionCtx = (values: Record<string, unknown>, roles = ['operator']) =>
      ({
        state: { currentRoles: roles },
        can: ({ resource, action }: { resource: string; action: string }) =>
          resource === RESOURCE_NAME && action !== 'listDisks' && action !== 'saveRawConfig',
        action: { params: { values } },
        throw: (status: number, msg: string) => {
          throw Object.assign(new Error(msg), { status });
        },
      }) as unknown as Context;

    // 1. testConnectionDraft must still enforce environmentVariables ACL when password === SECRET_MASK && id is set
    await expect(
      actions.testConnectionDraft(
        makeActionCtx({
          id: 1,
          baseUrl: 'http://127.0.0.1:5572',
          authType: 'basic',
          username: '{{$env.DB_PASSWORD}}',
          password: SECRET_MASK,
        }),
        async () => {},
      ),
    ).rejects.toMatchObject({ status: 403 });

    // 2. testConnectionDraft & updateConnection must reject reusing SECRET_MASK when baseUrl origin changes
    await expect(
      actions.testConnectionDraft(
        makeActionCtx({
          id: 1,
          baseUrl: 'http://attacker.example.com:5572',
          authType: 'basic',
          username: 'admin',
          password: SECRET_MASK,
        }),
        async () => {},
      ),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      actions.updateConnection(
        makeActionCtx({
          id: 1,
          baseUrl: 'http://attacker.example.com:5572',
          password: SECRET_MASK,
        }),
        async () => {},
      ),
    ).rejects.toMatchObject({ status: 400 });

    // 3. createRemote must block combine `dir=:local:/`, `dir=workspace:`, capitalized `Remote`, and empty wrapper targets
    await expect(
      actions.createRemote(
        makeActionCtx({ connectionId: 1, name: 'pwn1', type: 'combine', parameters: { upstreams: 'root=:local:/' } }),
        async () => {},
      ),
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      actions.createRemote(
        makeActionCtx({ connectionId: 1, name: 'pwn2', type: 'combine', parameters: { upstreams: 'root=workspace:' } }),
        async () => {},
      ),
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      actions.createRemote(
        makeActionCtx({ connectionId: 1, name: 'pwn3', type: 'alias', parameters: { Remote: '/etc' } }),
        async () => {},
      ),
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      actions.updateRemote(
        makeActionCtx({ connectionId: 1, name: 'existing-combine', parameters: { upstreams: '' } }),
        async () => {},
      ),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      actions.updateRemote(
        makeActionCtx({ connectionId: 1, name: 'existing-combine', parameters: { upstreams: '   ' } }),
        async () => {},
      ),
    ).rejects.toMatchObject({ status: 400 });

    expect(fakeRcClient.createRemote).not.toHaveBeenCalled();

    // 4. stopJob must kick the reconciler when finalizeTaskAndWorkflowJob returns false (unflushed workflow JobModel race)
    const kickSpy = vi.fn();
    const finalizeSpy = vi.fn().mockResolvedValue(false);
    const stopActions = createRcloneManagerActions({
      app: { pm: { get: vi.fn() } },
      db: {
        getRepository: vi.fn(() => ({
          findOne: vi.fn(async () => ({
            get: (k: string) =>
              ({ id: 55, connectionId: 1, status: 'running', rcloneJobId: 15, rcloneGroup: 'nb-task-55-g' })[k],
          })),
        })),
      },
      connectionManager,
      reconciler: { finalizeTaskAndWorkflowJob: finalizeSpy, kick: kickSpy },
    } as unknown as PluginRcloneManagerServer);

    const stopCtx = makeActionCtx({ taskId: 55 });
    await stopActions.stopJob(stopCtx, async () => {});
    expect(finalizeSpy).toHaveBeenCalledTimes(1);
    expect(kickSpy).toHaveBeenCalledWith(400);
  });

  it('resolves signed download URLs without percent-encoding query separator', () => {
    const rel = '/api/rcloneManager:downloadStream?connectionId=1&fs=minio%3A&sig=abc';
    expect(resolveSignedDownloadUrl('/api/', 'https://portal.gems.id.vn', rel)).toBe(
      'https://portal.gems.id.vn/api/rcloneManager:downloadStream?connectionId=1&fs=minio%3A&sig=abc',
    );
    expect(resolveSignedDownloadUrl('https://portal.gems.id.vn/api/', 'https://portal.gems.id.vn', rel)).toBe(
      'https://portal.gems.id.vn/api/rcloneManager:downloadStream?connectionId=1&fs=minio%3A&sig=abc',
    );
    expect(resolveSignedDownloadUrl('/subpath/api/', 'https://portal.gems.id.vn', rel)).toBe(
      'https://portal.gems.id.vn/subpath/api/rcloneManager:downloadStream?connectionId=1&fs=minio%3A&sig=abc',
    );
  });

  it('prefers JWT_SECRET and APP_KEY env vars over local jwt_secret.dat and warns once on ephemeral fallback', () => {
    const prevStreamSecret = process.env.RCLONE_STREAM_URL_SECRET;
    const prevJwtSecret = process.env.JWT_SECRET;
    const prevAppKey = process.env.APP_KEY;
    delete process.env.RCLONE_STREAM_URL_SECRET;
    delete process.env.JWT_SECRET;
    delete process.env.APP_KEY;
    __resetSigningSecretForTest();

    const payload = {
      connectionId: 1,
      fs: 'minio:',
      remote: 'file.txt',
      isDir: false,
      mode: 'attachment' as const,
      expires: Date.now() + 60_000,
    };

    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const readSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('pod-local-jwt-secret-A'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      // Shared JWT_SECRET and APP_KEY must win over different per-pod appSecret values (e.g. AuthManager jwt_secret.dat)
      process.env.JWT_SECRET = 'shared-cluster-jwt-secret';
      __resetSigningSecretForTest();
      const sigPodA = signStreamPayload(payload, { appSecret: Buffer.from('pod-A-local-jwt-secret'), appName: 'main' });
      expect(
        verifyStreamSignature(payload, sigPodA, { appSecret: Buffer.from('pod-B-local-jwt-secret'), appName: 'main' }),
      ).toBe(true);

      // Without env vars, per-app jwt_secret.dat cache stays isolated by appName
      delete process.env.JWT_SECRET;
      __resetSigningSecretForTest();
      readSpy.mockReturnValueOnce(Buffer.from('app-main-secret'));
      const sigMain = signStreamPayload(payload, { appName: 'main' });
      readSpy.mockReturnValueOnce(Buffer.from('app-sub1-secret'));
      expect(verifyStreamSignature(payload, sigMain, { appName: 'sub1' })).toBe(false);

      // Ephemeral fallback warns once when no env secret, appSecret, or jwt_secret.dat exists
      existsSpy.mockReturnValue(false);
      __resetSigningSecretForTest();
      signStreamPayload(payload);
      signStreamPayload(payload);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
      readSpy.mockRestore();
      existsSpy.mockRestore();
      if (prevStreamSecret !== undefined) process.env.RCLONE_STREAM_URL_SECRET = prevStreamSecret;
      else delete process.env.RCLONE_STREAM_URL_SECRET;
      if (prevJwtSecret !== undefined) process.env.JWT_SECRET = prevJwtSecret;
      else delete process.env.JWT_SECRET;
      if (prevAppKey !== undefined) process.env.APP_KEY = prevAppKey;
      else delete process.env.APP_KEY;
      __resetSigningSecretForTest();
    }
  });

  it('kicks reconciler non-blockingly in listJobs, scopes localAuthorized tasks, and blocks non-local-fs stopJob', async () => {
    const kickSpy = vi.fn();
    const reconcileOnceSpy = vi.fn();
    const findSpy = vi.fn(async () => [{ toJSON: () => ({ id: 1, title: 'cloud copy' }) }]);
    const createSpy = vi.fn(async ({ values }: { values: Record<string, unknown> }) => ({ toJSON: () => values }));
    const taskRows: Record<number, Record<string, unknown>> = {
      88: { id: 88, connectionId: 1, rcloneJobId: 12, localAuthorized: true },
    };

    const fakeRcClient = {
      isFsLocal: vi.fn(async (fsPath: string) => fsPath.startsWith('/')),
      isUnrootedBucketFs: vi.fn(async () => false),
      stopJob: vi.fn(async () => {}),
    };
    const fakeConnectionManager = {
      getClient: vi.fn(async () => ({ model: {}, client: fakeRcClient })),
    };
    const actions = createRcloneManagerActions({
      app: {
        pm: {
          get: vi.fn((name: string) =>
            name === 'workflow'
              ? {
                  app: {},
                }
              : undefined,
          ),
        },
        db: {
          getCollection: vi.fn(() => ({})),
          getRepository: vi.fn((name: string) => {
            if (name === 'workflows') {
              return { findOne: vi.fn(async () => ({ id: 1, title: 'Default', enabled: true })) };
            }
            return {};
          }),
        },
      },
      db: {
        getRepository: vi.fn(() => ({
          find: findSpy,
          create: createSpy,
          findOne: vi.fn(async ({ filterByTk }: { filterByTk: number }) =>
            taskRows[filterByTk] ? { get: (k: string) => taskRows[filterByTk][k] } : null,
          ),
        })),
      },
      connectionManager: fakeConnectionManager,
      reconciler: {
        kick: kickSpy,
        reconcileOnce: reconcileOnceSpy,
        finalizeTaskAndWorkflowJob: vi.fn(async () => true),
      },
    } as unknown as PluginRcloneManagerServer);

    const makeCtx = (params: Record<string, unknown>, canLocalFs: boolean) =>
      ({
        state: { currentRoles: [canLocalFs ? 'infra' : 'operator'], currentUser: { id: 7 } },
        can: ({ resource, action }: { resource: string; action: string }) =>
          resource === RESOURCE_NAME && (canLocalFs || action !== 'listDisks'),
        action: { params },
        body: undefined,
        throw: (status: number, msg: string) => {
          throw Object.assign(new Error(msg), { status });
        },
      }) as unknown as Context;

    // 1. listJobs triggers non-blocking kick(0) (not reconcileOnce) and filters out localAuthorized rows for non-local-fs
    const opCtx = makeCtx({ connectionId: 1 }, false);
    await actions.listJobs(opCtx, async () => {});
    expect(kickSpy).toHaveBeenCalledWith(0);
    expect(reconcileOnceSpy).not.toHaveBeenCalled();
    expect(findSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filter: { connectionId: 1, localAuthorized: { $isFalsy: true } },
      }),
    );

    // local-fs users see all jobs without localAuthorized restriction
    const adminListCtx = makeCtx({ connectionId: 1 }, true);
    await actions.listJobs(adminListCtx, async () => {});
    expect(findSpy).toHaveBeenLastCalledWith(expect.objectContaining({ filter: { connectionId: 1 } }));

    // 2. stopJob rejects stopping a localAuthorized task when caller lacks local-fs permission
    await expect(actions.stopJob(makeCtx({ taskId: 88 }, false), async () => {})).rejects.toMatchObject({
      status: 403,
    });
    expect(fakeRcClient.stopJob).not.toHaveBeenCalled();

    // 3. triggerTransferWorkflow sets localAuthorized=false for admin cloud-to-cloud and true for admin local-disk transfers
    const adminCloudCtx = makeCtx(
      { connectionId: 1, operation: 'sync/copy', srcFs: 's3:src', dstFs: 'gdrive:dst' },
      true,
    );
    await actions.triggerTransferWorkflow(adminCloudCtx, async () => {});
    expect((adminCloudCtx.body as Record<string, unknown>).localAuthorized).toBe(false);

    const adminLocalCtx = makeCtx(
      { connectionId: 1, operation: 'sync/copy', srcFs: '/mnt/data', dstFs: 's3:backup' },
      true,
    );
    await actions.triggerTransferWorkflow(adminLocalCtx, async () => {});
    expect((adminLocalCtx.body as Record<string, unknown>).localAuthorized).toBe(true);
  });

  it('destroys active upstream entry stream immediately when createStreamingZip is aborted or destroyed', async () => {
    const controller = new AbortController();
    const stalledUpstream = new PassThrough();
    let opened = false;

    const zipStream = createStreamingZip(
      [
        {
          name: 'slow-file.bin',
          openStream: async () => {
            opened = true;
            stalledUpstream.write(Buffer.from('partial-chunk'));
            return stalledUpstream;
          },
        },
      ],
      controller.signal,
    );

    // Pull chunks until the entry stream opens, then abort while stalled waiting for more data
    const readerError = new Promise<unknown>((resolve) => {
      zipStream.on('error', resolve);
      zipStream.on('close', () => resolve(null));
    });
    zipStream.on('data', () => {
      if (opened && !controller.signal.aborted) {
        controller.abort();
      }
    });

    await readerError;
    expect(opened).toBe(true);
    expect(stalledUpstream.destroyed).toBe(true);
  });

  it('coerces Rclone string booleans and plain ints for remote edit forms without altering masked secrets or enum ints', () => {
    const options = [
      { Name: 'env_auth', Type: 'bool', Default: false },
      { Name: 'upload_concurrency', Type: 'int', Default: 4 },
      { Name: 'storage_class', Type: 'int', Examples: [{ Value: '0', Help: 'Standard' }] },
      { Name: 'secret_access_key', Type: 'string', IsPassword: true },
    ];
    const coerced = coerceRemoteParamsForForm(
      {
        env_auth: 'false',
        upload_concurrency: '8',
        storage_class: '0',
        secret_access_key: SECRET_MASK,
        unknown_flag: 'false',
      },
      options,
    );

    expect(coerced).toEqual({
      env_auth: false,
      upload_concurrency: 8,
      storage_class: '0',
      secret_access_key: SECRET_MASK,
      unknown_flag: 'false',
    });
  });

  it('hardens downloadStream against XSS, prevents renameItem overwrites, guards logFile changes, and exposes standalone mount/serve read actions', async () => {
    expect(RCLONE_ACTIONS.mounts).toContain(`${RESOURCE_NAME}:listConnections`);
    expect(RCLONE_ACTIONS.mounts).toContain(`${RESOURCE_NAME}:listRemotes`);
    expect(RCLONE_ACTIONS.serves).toContain(`${RESOURCE_NAME}:listConnections`);
    expect(RCLONE_ACTIONS.serves).toContain(`${RESOURCE_NAME}:listRemotes`);
    expect(RCLONE_ACTIONS.rawConfig).toContain(`${RESOURCE_NAME}:listConnections`);

    const moveFileSpy = vi.fn(async () => {});
    const setOptionsSpy = vi.fn(async () => {});
    const statItemSpy = vi.fn(async (_fs: string, remote: string) =>
      remote === 'existing.txt' ? { Name: 'existing.txt', Size: 10, IsDir: false } : null,
    );
    const fakeClient = {
      isFsLocal: vi.fn(async () => false),
      statItem: statItemSpy,
      moveFileSync: moveFileSpy,
      getOptions: vi.fn(async () => ({ main: { BwLimit: 'off' }, log: { File: '/var/log/rclone.log' } })),
      setOptions: setOptionsSpy,
      openDownloadStream: vi.fn(async () => ({
        stream: new PassThrough(),
        status: 200,
        contentType: 'text/html; charset=utf-8',
        filename: 'report.html',
        cleanup: vi.fn(async () => {}),
      })),
    };
    const actions = createRcloneManagerActions({
      app: { name: 'main' },
      db: { getRepository: vi.fn() },
      connectionManager: { getClient: vi.fn(async () => ({ model: {}, client: fakeClient })) },
    } as unknown as PluginRcloneManagerServer);

    // 1. downloadStream sets CSP sandbox + nosniff + no-store and forces attachment for HTML even when mode=inline
    const payload = {
      connectionId: 1,
      fs: 's3:bucket',
      remote: 'report.html',
      isDir: false,
      mode: 'inline' as const,
      expires: Date.now() + 60_000,
    };
    const sig = signStreamPayload(payload, { appName: 'main' });
    const headers: Record<string, string> = {};
    const dlCtx = {
      request: {
        query: {
          connectionId: '1',
          fs: payload.fs,
          remote: payload.remote,
          isDir: '0',
          mode: 'inline',
          expires: String(payload.expires),
          sig,
        },
        headers: {},
      },
      req: { once: vi.fn(), off: vi.fn() },
      res: { once: vi.fn(), writableEnded: false },
      set: (k: string, v: string) => {
        headers[k.toLowerCase()] = v;
      },
      throw: (status: number, msg: string) => {
        throw Object.assign(new Error(msg), { status });
      },
    } as unknown as Context;

    await actions.downloadStream(dlCtx);
    expect(headers['content-security-policy']).toBe('sandbox');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['cache-control']).toBe('private, no-store');
    expect(headers['content-disposition']).toMatch(/^attachment;/);

    // 2. renameItem no-ops when srcRemote === dstRemote and rejects 409 when destination exists
    const makeOpCtx = (values: Record<string, unknown>, canLocalFs = false) =>
      ({
        state: { currentRoles: [canLocalFs ? 'infra' : 'operator'] },
        can: ({ resource, action }: { resource: string; action: string }) =>
          resource === RESOURCE_NAME && (canLocalFs || action !== 'listDisks'),
        action: { params: { values } },
        body: undefined,
        throw: (status: number, msg: string) => {
          throw Object.assign(new Error(msg), { status });
        },
      }) as unknown as Context;

    await actions.renameItem(
      makeOpCtx({ connectionId: 1, fs: 's3:bucket', srcRemote: 'a.txt', dstRemote: 'a.txt', isDir: false }),
      async () => {},
    );
    expect(moveFileSpy).not.toHaveBeenCalled();

    await expect(
      actions.renameItem(
        makeOpCtx({ connectionId: 1, fs: 's3:bucket', srcRemote: 'a.txt', dstRemote: 'existing.txt', isDir: false }),
        async () => {},
      ),
    ).rejects.toMatchObject({ status: 409 });

    // 3. setRuntimeOptions allows unchanged logFile for non-local-fs user, but blocks changing logFile to a new host path
    await actions.setRuntimeOptions(
      makeOpCtx({ connectionId: 1, bwLimit: '50M', logFile: '/var/log/rclone.log' }, false),
      async () => {},
    );
    expect(setOptionsSpy).toHaveBeenCalledWith({ main: { BwLimit: '50M' } });

    await expect(
      actions.setRuntimeOptions(makeOpCtx({ connectionId: 1, logFile: '/etc/cron.d/pwn' }, false), async () => {}),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('enforces transfer ACL for signDownload, preserves trailing-space deleteItem names, rejects duplicate createRemote, aborts renameItem on stat errors, fails stopJob on daemon errors, and caps chunked uploads', async () => {
    expect(RCLONE_ACTIONS.read).not.toContain(`${RESOURCE_NAME}:signDownload`);
    expect(RCLONE_ACTIONS.transfer).toContain(`${RESOURCE_NAME}:signDownload`);

    const deleteFileSpy = vi.fn(async () => {});
    const moveFileSpy = vi.fn(async () => {});
    const createRemoteSpy = vi.fn(async () => ({}));
    const stopJobSpy = vi.fn(async () => {
      throw new Error('daemon unreachable');
    });
    const finalizeSpy = vi.fn(async () => true);

    let statShouldTimeout = true;
    const statItemSpy = vi.fn(async () => {
      if (statShouldTimeout) {
        throw Object.assign(new Error('Failed to reach rclone rcd (/operations/stat): timeout'), { status: 502 });
      }
      return null;
    });

    let capturedUploadBytes = 0;
    let capturedAbortSignal: AbortSignal | undefined;
    const uploadMultipartStreamSpy = vi.fn(
      async (
        _fs: string,
        _remote: string,
        stream: NodeJS.ReadableStream,
        _contentType: string,
        _contentLength?: string,
        signal?: AbortSignal,
      ) => {
        capturedAbortSignal = signal;
        for await (const chunk of stream) {
          capturedUploadBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.from(chunk as string).length;
        }
      },
    );

    const fakeClient = {
      classifyFsLocality: vi.fn(async (fsPath: string) => (fsPath === 'mystery:' ? 'unknown' : 'remote')),
      isFsLocal: vi.fn(async () => false),
      isUnrootedBucketFs: vi.fn(async () => false),
      listRemoteNames: vi.fn(async () => ['prod-s3']),
      createRemote: createRemoteSpy,
      deleteFile: deleteFileSpy,
      statItem: statItemSpy,
      moveFileSync: moveFileSpy,
      stopJob: stopJobSpy,
      uploadMultipartStream: uploadMultipartStreamSpy,
    };

    const runningTaskState: Record<string, unknown> = {
      id: 77,
      connectionId: 1,
      status: 'running',
      rcloneJobId: 9,
      rcloneExecuteId: 'exec-abc',
      localAuthorized: false,
    };

    const actions = createRcloneManagerActions({
      app: { name: 'sub-app-1', pm: { get: vi.fn() } },
      db: {
        getRepository: vi.fn(() => ({
          findOne: vi.fn(async () => ({ get: (k: string) => runningTaskState[k] })),
        })),
      },
      connectionManager: { getClient: vi.fn(async () => ({ model: {}, client: fakeClient })) },
      reconciler: { finalizeTaskAndWorkflowJob: finalizeSpy, kick: vi.fn() },
    } as unknown as PluginRcloneManagerServer);

    const makeCtx = (values: Record<string, unknown>) =>
      ({
        state: { currentRoles: ['operator'] },
        can: ({ resource, action }: { resource: string; action: string }) =>
          resource === RESOURCE_NAME && action !== 'listDisks' && action !== 'saveRawConfig',
        action: { params: { values } },
        body: undefined,
        throw: (status: number, msg: string) => {
          throw Object.assign(new Error(msg), { status });
        },
      }) as unknown as Context;

    // 1. deleteItem preserves trailing spaces on filenames ("report.txt " !== "report.txt")
    await actions.deleteItem(
      makeCtx({ connectionId: 1, fs: 'prod-s3:bucket', remote: 'report.txt ', isDir: false }),
      async () => {},
    );
    expect(deleteFileSpy).toHaveBeenCalledWith('prod-s3:bucket', 'report.txt ');

    // 2. createRemote returns 409 when daemon already has a remote of the same name
    await expect(
      actions.createRemote(
        makeCtx({ connectionId: 1, name: 'prod-s3', type: 's3', parameters: { provider: 'Minio' } }),
        async () => {},
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(createRemoteSpy).not.toHaveBeenCalled();

    // 3. renameItem aborts before moveFileSync when statItem times out or errors
    await expect(
      actions.renameItem(
        makeCtx({ connectionId: 1, fs: 'prod-s3:bucket', srcRemote: 'a.txt', dstRemote: 'b.txt', isDir: false }),
        async () => {},
      ),
    ).rejects.toMatchObject({ status: 502 });
    expect(moveFileSpy).not.toHaveBeenCalled();

    statShouldTimeout = false;
    await actions.renameItem(
      makeCtx({ connectionId: 1, fs: 'prod-s3:bucket', srcRemote: 'a.txt', dstRemote: 'b.txt', isDir: false }),
      async () => {},
    );
    expect(moveFileSpy).toHaveBeenCalledWith('prod-s3:bucket', 'a.txt', 'prod-s3:bucket', 'b.txt');

    // 4. Indeterminate ('unknown') remote locality denies access (403) until metadata can classify it
    await expect(
      actions.listFiles(makeCtx({ connectionId: 1, fs: 'mystery:', remote: '' }), async () => {}),
    ).rejects.toMatchObject({ status: 403 });

    // 5. stopJob propagates daemon failure and keeps task in running state instead of reporting stopped=true
    await expect(actions.stopJob(makeCtx({ taskId: 77 }), async () => {})).rejects.toThrow(/daemon unreachable/);
    expect(finalizeSpy).not.toHaveBeenCalled();
    expect(runningTaskState.status).toBe('running');

    // 6. downloadStream rejects signatures issued by a different NocoBase app even with shared key
    const prevSecret = process.env.RCLONE_STREAM_URL_SECRET;
    process.env.RCLONE_STREAM_URL_SECRET = 'shared-multi-app-secret';
    __resetSigningSecretForTest();
    try {
      const foreignPayload = {
        connectionId: 1,
        fs: 'prod-s3:bucket',
        remote: 'secret.pdf',
        isDir: false,
        mode: 'attachment' as const,
        expires: Date.now() + 60_000,
      };
      const foreignSig = signStreamPayload(foreignPayload, { appName: 'sub-app-2' });
      const dlCtx = {
        request: {
          query: {
            connectionId: '1',
            fs: foreignPayload.fs,
            remote: foreignPayload.remote,
            isDir: '0',
            mode: 'attachment',
            expires: String(foreignPayload.expires),
            sig: foreignSig,
          },
          headers: {},
        },
        throw: (status: number, msg: string) => {
          throw Object.assign(new Error(msg), { status });
        },
      } as unknown as Context;
      await expect(actions.downloadStream(dlCtx)).rejects.toMatchObject({ status: 403 });
    } finally {
      if (prevSecret !== undefined) process.env.RCLONE_STREAM_URL_SECRET = prevSecret;
      else delete process.env.RCLONE_STREAM_URL_SECRET;
      __resetSigningSecretForTest();
    }

    // 7. Chunked upload without Content-Length enforces RCLONE_MAX_UPLOAD_MB on actual bytes read and aborts upstream
    const prevMaxMb = process.env.RCLONE_MAX_UPLOAD_MB;
    process.env.RCLONE_MAX_UPLOAD_MB = '0.001'; // ~1048 bytes
    try {
      const chunkedReq = new PassThrough();
      const uploadCtx = {
        state: { currentRoles: ['operator'] },
        can: () => true,
        action: { params: {} },
        request: {
          query: { connectionId: '1', fs: 'prod-s3:bucket', remote: 'uploads' },
          headers: { 'content-type': 'multipart/form-data; boundary=---test' },
        },
        req: chunkedReq,
        set: vi.fn(),
        throw: (status: number, msg: string) => {
          throw Object.assign(new Error(msg), { status });
        },
      } as unknown as Context;

      const uploadPromise = actions.uploadFile(uploadCtx, async () => {});
      chunkedReq.write(Buffer.alloc(600, 0x61));
      chunkedReq.write(Buffer.alloc(600, 0x62));
      chunkedReq.write(Buffer.alloc(600, 0x63));
      chunkedReq.end();

      await expect(uploadPromise).rejects.toMatchObject({ status: 413 });
      expect(capturedAbortSignal?.aborted).toBe(true);
      expect(capturedUploadBytes).toBeLessThanOrEqual(1048);
    } finally {
      if (prevMaxMb !== undefined) process.env.RCLONE_MAX_UPLOAD_MB = prevMaxMb;
      else delete process.env.RCLONE_MAX_UPLOAD_MB;
    }
  });

  it('serializes concurrent createRemote calls, reconciles already-completed jobs on late stopJob, and blocks unverified legacy stopJob', async () => {
    const existingRemotes = new Set<string>(['prod-s3']);
    const createRemoteSpy = vi.fn(async (name: string) => {
      existingRemotes.add(name);
      return {};
    });
    const listRemoteNamesSpy = vi.fn(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 15));
      return [...existingRemotes];
    });

    const taskRows: Record<number, Record<string, unknown>> = {
      90: {
        id: 90,
        connectionId: 1,
        status: 'running',
        rcloneJobId: 45,
        rcloneExecuteId: 'exec-1',
        rcloneGroup: 'nb-task-90-g1',
        localAuthorized: false,
      },
      91: {
        id: 91,
        connectionId: 1,
        status: 'running',
        rcloneJobId: 46,
        rcloneExecuteId: 'exec-1',
        rcloneGroup: 'nb-task-91-g2',
        localAuthorized: false,
      },
      92: {
        id: 92,
        connectionId: 1,
        status: 'running',
        rcloneJobId: 47,
        rcloneExecuteId: 'exec-1',
        rcloneGroup: 'nb-task-92-g3',
        localAuthorized: false,
      },
      93: {
        id: 93,
        connectionId: 1,
        status: 'running',
        rcloneJobId: 48,
        rcloneExecuteId: null,
        rcloneGroup: null,
        localAuthorized: false,
      },
      94: {
        id: 94,
        connectionId: 1,
        status: 'running',
        rcloneJobId: 49,
        rcloneExecuteId: 'exec-1',
        rcloneGroup: 'nb-task-94-g4',
        localAuthorized: false,
      },
    };

    let job47Stopped = false;
    const stopJobSpy = vi.fn(async (jobid: number) => {
      if (jobid === 47) {
        job47Stopped = true;
      }
    });
    const getJobStatusSpy = vi.fn(async (jobid: number) => {
      if (jobid === 45) {
        return {
          id: 45,
          finished: true,
          success: true,
          duration: 1.8,
          group: 'nb-task-90-g1',
          executeId: 'exec-1',
        };
      }
      if (jobid === 46) {
        return {
          id: 46,
          finished: false,
          success: false,
          duration: 0.4,
          group: 'nb-task-91-g2',
          executeId: 'exec-1',
        };
      }
      if (jobid === 49) {
        return {
          id: 49,
          finished: true,
          success: false,
          error: 'directory not found',
          duration: 0.3,
          group: 'nb-task-94-g4',
          executeId: 'exec-1',
        };
      }
      return {
        id: 47,
        finished: job47Stopped,
        success: false,
        error: job47Stopped ? 'context canceled' : '',
        duration: 0.6,
        group: 'nb-task-92-g3',
        executeId: 'exec-1',
      };
    });
    const getStatsSpy = vi.fn(async (group?: string) =>
      group === 'nb-task-90-g1' ? { bytes: 4096, totalBytes: 4096 } : { bytes: 512, totalBytes: 1024 },
    );
    const finalizeSpy = vi.fn(async () => true);
    const kickSpy = vi.fn();

    const makeFakeClient = (baseUrl: string) => ({
      baseUrl,
      classifyFsLocality: vi.fn(async () => 'remote' as const),
      isFsLocal: vi.fn(async () => false),
      listRemoteNames: listRemoteNamesSpy,
      createRemote: createRemoteSpy,
      stopJob: stopJobSpy,
      getJobStatus: getJobStatusSpy,
      getStats: getStatsSpy,
    });
    const fakeClientLoopbackIp = makeFakeClient('http://127.0.0.1:5572');
    const fakeClientLocalhost = makeFakeClient('http://localhost:5572');

    const actions = createRcloneManagerActions({
      app: { name: 'main', pm: { get: vi.fn() } },
      db: {
        getRepository: vi.fn(() => ({
          findOne: vi.fn(async ({ filterByTk }: { filterByTk: number }) =>
            taskRows[filterByTk] ? { get: (k: string) => taskRows[filterByTk][k] } : null,
          ),
        })),
      },
      connectionManager: {
        getClient: vi.fn(async (connId: string | number) => ({
          model: {},
          client: String(connId) === '2' ? fakeClientLocalhost : fakeClientLoopbackIp,
        })),
      },
      reconciler: { finalizeTaskAndWorkflowJob: finalizeSpy, kick: kickSpy },
    } as unknown as PluginRcloneManagerServer);

    const makeCtx = (values: Record<string, unknown>) =>
      ({
        state: { currentRoles: ['operator'] },
        can: ({ resource, action }: { resource: string; action: string }) =>
          resource === RESOURCE_NAME && action !== 'listDisks' && action !== 'saveRawConfig',
        action: { params: { values } },
        body: undefined,
        throw: (status: number, msg: string) => {
          throw Object.assign(new Error(msg), { status });
        },
      }) as unknown as Context;

    // 1. Concurrent createRemote requests with the same remote name serialize even across localhost vs 127.0.0.1 URLs
    const ctxCreateA = makeCtx({ connectionId: 1, name: 'race-s3', type: 's3', parameters: { provider: 'Minio' } });
    const ctxCreateB = makeCtx({ connectionId: 2, name: 'race-s3', type: 's3', parameters: { provider: 'AWS' } });
    const [resA, resB] = await Promise.allSettled([
      actions.createRemote(ctxCreateA, async () => {}),
      actions.createRemote(ctxCreateB, async () => {}),
    ]);
    expect(createRemoteSpy).toHaveBeenCalledTimes(1);
    const fulfilled = [resA, resB].filter((r) => r.status === 'fulfilled');
    const rejected = [resA, resB].filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0]?.reason as { status?: number }).status).toBe(409);

    // 2. Late stopJob on a job that already finished with success=true records completed (not stopped/failed)
    const ctxCompleted = makeCtx({ taskId: 90 });
    await actions.stopJob(ctxCompleted, async () => {});
    expect(ctxCompleted.body).toEqual({ stopped: false, status: 'completed', taskId: 90 });
    expect(finalizeSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Map),
      undefined,
      expect.objectContaining({ status: 'completed', success: true, bytes: 4096, totalBytes: 4096 }),
    );

    // 3. stopJob when daemon has not yet confirmed finished=true rejects 409 without prematurely finalizing
    finalizeSpy.mockClear();
    await expect(actions.stopJob(makeCtx({ taskId: 91 }), async () => {})).rejects.toMatchObject({ status: 409 });
    expect(finalizeSpy).not.toHaveBeenCalled();
    expect(kickSpy).toHaveBeenCalledWith(250);

    // 4. stopJob when daemon confirms cancellation (finished=true, success=false, context canceled) records stopped=true
    const ctxStopped = makeCtx({ taskId: 92 });
    await actions.stopJob(ctxStopped, async () => {});
    expect(ctxStopped.body).toEqual({ stopped: true, status: 'stopped', taskId: 92 });
    expect(finalizeSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Map),
      undefined,
      expect.objectContaining({ status: 'stopped', success: false }),
    );

    // 5. Pre-upgrade running task missing both rcloneExecuteId and rcloneGroup refuses stopJob with 409
    stopJobSpy.mockClear();
    await expect(actions.stopJob(makeCtx({ taskId: 93 }), async () => {})).rejects.toMatchObject({ status: 409 });
    expect(stopJobSpy).not.toHaveBeenCalled();

    // 6. Late stopJob on a job that already failed ("directory not found") preserves status='failed' and root cause
    finalizeSpy.mockClear();
    stopJobSpy.mockClear();
    const ctxAlreadyFailed = makeCtx({ taskId: 94 });
    await actions.stopJob(ctxAlreadyFailed, async () => {});
    expect(stopJobSpy).not.toHaveBeenCalled();
    expect(ctxAlreadyFailed.body).toEqual({ stopped: false, status: 'failed', taskId: 94 });
    expect(finalizeSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Map),
      undefined,
      expect.objectContaining({ status: 'failed', success: false, errorText: 'directory not found' }),
    );
  });
});
