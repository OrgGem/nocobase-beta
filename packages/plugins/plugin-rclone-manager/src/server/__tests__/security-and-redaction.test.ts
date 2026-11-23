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

  it('normalizes relative remote sub-paths and blocks .. traversal', () => {
    expect(normalizeRemoteSubPath('/reports\\2026/./q4/')).toBe('reports/2026/q4');
    expect(normalizeRemoteSubPath('/')).toBe('');
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

    const sig = signStreamPayload(validPayload);
    expect(verifyStreamSignature(validPayload, sig)).toBe(true);
    expect(verifyStreamSignature({ ...validPayload, fs: 's3-prod:other' }, sig)).toBe(false);
    expect(verifyStreamSignature({ ...validPayload, expires: Date.now() - 1000 }, sig)).toBe(false);

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
    const fakeRcClient = {
      isFsLocal: vi.fn(async (fsPath: string) => fsPath.startsWith('workspace:') || fsPath.startsWith('/')),
      createRemote: vi.fn(async () => ({})),
      getRemoteRaw: vi.fn(async () => ({ type: 'combine', upstreams: 's3=minio:bucket' })),
      listProviders: vi.fn(async () => []),
      updateRemote: vi.fn(async () => ({})),
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
            get: (k: string) => ({ id: 55, connectionId: 1, rcloneJobId: null })[k],
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
});
