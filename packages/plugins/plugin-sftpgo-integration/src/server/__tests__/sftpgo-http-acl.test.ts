// SPDX-License-Identifier: Apache-2.0

import { createMockServer, type MockServer } from '@nocobase/test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import PluginSftpgoIntegrationServer from '../plugin';
import type { SftpgoClient } from '../sftpgo-client';

type MockAgent = ReturnType<MockServer['agent']>;

describe('SFTPGo ACL and private key secrets over HTTP', () => {
  let app: MockServer | undefined;
  let rowReader: MockAgent;
  let secretManager: MockAgent;
  let rootAgent: MockAgent;
  let plugin: PluginSftpgoIntegrationServer;
  let visibleConnectionId: number;
  let hiddenConnectionId: number;
  let probeId: number;
  let secretId: number;
  let visibleSecretCiphertext: string;
  let getClient: ReturnType<typeof vi.spyOn<PluginSftpgoIntegrationServer, 'getClient'>>;
  let fakeClient: SftpgoClient;

  beforeAll(async () => {
    app = await createMockServer({
      name: 'main',
      acl: true,
      database: { dialect: 'sqlite', storage: ':memory:' },
      beforeInstall: async (mockApp: MockServer) => {
        mockApp.db.collection({
          name: 'sftpgoAclProbe',
          fields: [{ type: 'string', name: 'name', allowNull: false }],
        });
      },
      plugins: [
        'field-sort',
        'system-settings',
        'users',
        'auth',
        'acl',
        'data-source-manager',
        'data-source-main',
        'error-handler',
        [
          PluginSftpgoIntegrationServer,
          {
            name: 'plugin-sftpgo-integration',
            packageName: 'plugin-sftpgo-integration',
            enabled: true,
            isPreset: true,
          },
        ],
      ],
    });

    const connections = app.db.getRepository('sftpgoConnections');
    const visibleConnection = await connections.create({
      values: {
        name: 'Visible',
        title: 'Visible initial title',
        baseUrl: 'https://sftpgo.test.invalid',
        authMethod: 'admin',
        enabled: true,
      },
    });
    const hiddenConnection = await connections.create({
      values: {
        name: 'Hidden',
        title: 'Hidden initial title',
        baseUrl: 'https://sftpgo.test.invalid',
        authMethod: 'admin',
        enabled: true,
      },
    });
    visibleConnectionId = visibleConnection.get('id') as number;
    hiddenConnectionId = hiddenConnection.get('id') as number;
    const probe = await app.db.getRepository('sftpgoAclProbe').create({ values: { name: 'Probe unchanged' } });
    probeId = probe.get('id') as number;

    await app.db.getRepository('roles').create({
      values: { name: 'sftpgo-row-reader', title: 'SFTPGo row reader' },
    });
    await app.db.getRepository('roles').create({
      values: { name: 'sftpgo-secret-manager', title: 'SFTPGo secret manager' },
    });
    const readerUser = await app.db.getRepository('users').create({
      values: { username: 'sftpgo-row-reader', roles: ['sftpgo-row-reader'] },
    });
    const managerUser = await app.db.getRepository('users').create({
      values: { username: 'sftpgo-secret-manager', roles: ['sftpgo-secret-manager'] },
    });

    app.acl.define({
      role: 'sftpgo-row-reader',
      actions: {
        'sftpgoConnections:view': { filter: { name: 'Visible' } },
        'sftpgoConnections:update': { filter: { name: 'Visible' }, fields: ['title'] },
        'sftpgoConnections:testConnection': {},
        'sftpgoUsers:list': {},
      },
    });
    app.acl.registerSnippet({
      name: 'test.sftpgo-secret-resource-admin',
      actions: ['sftpgoApiKeySecrets:*', 'sftpgoApiKeySecrets.connection:*', 'sftpgoConnections:*'],
    });
    app.acl.define({ role: 'sftpgo-secret-manager' }).snippets.add('test.sftpgo-secret-resource-admin');

    rowReader = await app.agent().login(readerUser, 'sftpgo-row-reader');
    secretManager = await app.agent().login(managerUser, 'sftpgo-secret-manager');
    const rootUser = await app.db.getRepository('users').findOne();
    if (!rootUser) throw new Error('The mock server did not seed its root user');
    rootAgent = await app.agent().login(rootUser);

    plugin = app.pm.get('plugin-sftpgo-integration') as PluginSftpgoIntegrationServer;
    fakeClient = {
      listResources: vi.fn().mockResolvedValue([{ username: 'remote-user' }]),
      healthCheck: vi.fn().mockResolvedValue({ status: 'ok' }),
      verifyAuth: vi.fn().mockResolvedValue(undefined),
    } as unknown as SftpgoClient;
    getClient = vi.spyOn(plugin, 'getClient').mockResolvedValue(fakeClient);

    await plugin.saveApiKeySecret(visibleConnectionId, 'stored-key-id', 'Stored key', 'test-only-secret-value');
    const storedSecret = await app.db
      .getRepository('sftpgoApiKeySecrets')
      .findOne({ filter: { connectionId: visibleConnectionId, apiKeyId: 'stored-key-id' } });
    if (!storedSecret) throw new Error('The internal API-key secret was not persisted');
    secretId = storedSecret.get('id') as number;
    visibleSecretCiphertext = storedSecret.get('encryptedSecret') as string;
  }, 120000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.destroy();
  });

  it('allows scoped HTTP list/get and permits only visible connections for proxy and testConnection', async () => {
    if (!app) throw new Error('Mock server was not initialized');
    const list = await rowReader.resource('sftpgoConnections').list();
    expect(list.status).toBe(200);
    expect(list.body.data.map((row: { name: string }) => row.name)).toEqual(['Visible']);

    const visible = await rowReader.resource('sftpgoConnections').get({ filterByTk: visibleConnectionId });
    expect(visible.status).toBe(200);
    expect(visible.body.data.name).toBe('Visible');

    const hidden = await rowReader.resource('sftpgoConnections').get({ filterByTk: hiddenConnectionId });
    expect(hidden.body.data).toBeNull();

    const explicitSelf = await rowReader.resource('sftpgoConnections').get({
      filterByTk: visibleConnectionId,
      targetCollection: 'sftpgoConnections',
    });
    expect(explicitSelf.status).toBe(200);
    expect(explicitSelf.body.data.name).toBe('Visible');
    const explicitSelfHidden = await rowReader.resource('sftpgoConnections').get({
      filterByTk: hiddenConnectionId,
      targetCollection: 'sftpgoConnections',
    });
    expect(explicitSelfHidden.body.data).toBeNull();

    const normalUpdate = await rowReader.resource('sftpgoConnections').update({
      filterByTk: visibleConnectionId,
      values: { title: 'Visible updated normally' },
    });
    expect(normalUpdate.status).toBe(200);
    const explicitSelfUpdate = await rowReader.resource('sftpgoConnections').update({
      filterByTk: visibleConnectionId,
      targetCollection: 'sftpgoConnections',
      values: { title: 'Visible updated explicitly' },
    });
    expect(explicitSelfUpdate.status).toBe(200);
    await rowReader.resource('sftpgoConnections').update({
      filterByTk: hiddenConnectionId,
      values: { title: 'Hidden must stay unchanged' },
    });
    const updatedVisible = await app.db.getRepository('sftpgoConnections').findOne({ filterByTk: visibleConnectionId });
    const unchangedHidden = await app.db.getRepository('sftpgoConnections').findOne({ filterByTk: hiddenConnectionId });
    expect(updatedVisible?.get('title')).toBe('Visible updated explicitly');
    expect(unchangedHidden?.get('title')).toBe('Hidden initial title');

    getClient.mockClear();
    const allowedProxy = await rowReader.resource('sftpgoUsers').list({ connectionId: visibleConnectionId });
    expect(allowedProxy.status).toBe(200);
    expect(allowedProxy.body.data).toEqual([{ username: 'remote-user' }]);
    expect(getClient).toHaveBeenCalledTimes(1);

    getClient.mockClear();
    const deniedProxy = await rowReader.resource('sftpgoUsers').list({ connectionId: hiddenConnectionId });
    expect(deniedProxy.status).toBe(404);
    expect(getClient).not.toHaveBeenCalled();

    const deniedTestConnection = await rowReader
      .resource('sftpgoConnections')
      .testConnection({ filterByTk: hiddenConnectionId });
    expect(deniedTestConnection.status).toBe(404);
    expect(getClient).not.toHaveBeenCalled();

    const allowedTestConnection = await rowReader
      .resource('sftpgoConnections')
      .testConnection({ filterByTk: visibleConnectionId });
    expect(allowedTestConnection.status).toBe(200);
    expect(allowedTestConnection.body.data.success).toBe(true);
    expect(getClient).toHaveBeenCalledTimes(1);
    expect(fakeClient.healthCheck).toHaveBeenCalledTimes(1);
    expect(fakeClient.verifyAuth).toHaveBeenCalledTimes(1);
  });

  it('blocks cross-collection get/update selectors and preserves probe and secret rows', async () => {
    if (!app) throw new Error('Mock server was not initialized');
    const probeRepo = app.db.getRepository('sftpgoAclProbe');
    const connectionRepo = app.db.getRepository('sftpgoConnections');
    const secretRepo = app.db.getRepository('sftpgoApiKeySecrets');
    const probeBefore = await probeRepo.findOne({ filterByTk: probeId });
    const secretBefore = await secretRepo.findOne({ filterByTk: secretId });
    const connectionBefore = await connectionRepo.findOne({ filterByTk: visibleConnectionId });
    const originalConnectionTitle = connectionBefore?.get('title');
    expect(probeBefore?.get('name')).toBe('Probe unchanged');
    expect(secretBefore?.get('name')).toBe('Stored key');
    expect(originalConnectionTitle).toBeTruthy();

    const inaccessibleProbe = await rowReader.resource('sftpgoAclProbe').get({ filterByTk: probeId });
    expect(inaccessibleProbe.status).toBe(403);

    const probeGetDenied = await rootAgent.resource('sftpgoConnections').get({
      filterByTk: probeId,
      targetCollection: 'sftpgoAclProbe',
    });
    expect(probeGetDenied.status).toBe(403);
    const managerProbeGetDenied = await secretManager.resource('sftpgoConnections').get({
      filterByTk: probeId,
      targetCollection: 'sftpgoAclProbe',
    });
    expect(managerProbeGetDenied.status).toBe(403);
    const probeUpdateDenied = await rootAgent.resource('sftpgoConnections').update({
      filterByTk: probeId,
      targetCollection: 'sftpgoAclProbe',
      values: { name: 'Probe was redirected' },
    });
    expect(probeUpdateDenied.status).toBe(403);
    const managerProbeUpdateDenied = await secretManager.resource('sftpgoConnections').update({
      filterByTk: probeId,
      targetCollection: 'sftpgoAclProbe',
      values: { name: 'Probe was redirected by manager' },
    });
    expect(managerProbeUpdateDenied.status).toBe(403);
    const valuesCollectionUpdateDenied = await rootAgent.resource('sftpgoConnections').update({
      filterByTk: probeId,
      values: { __collection: 'sftpgoAclProbe', name: 'Probe was redirected by values' },
    });
    expect(valuesCollectionUpdateDenied.status).toBe(403);
    const managerValuesCollectionUpdateDenied = await secretManager.resource('sftpgoConnections').update({
      filterByTk: probeId,
      values: { __collection: 'sftpgoAclProbe', name: 'Probe was redirected by manager values' },
    });
    expect(managerValuesCollectionUpdateDenied.status).toBe(403);

    for (const agent of [secretManager, rootAgent]) {
      const secretGetDenied = await agent.resource('sftpgoConnections').get({
        filterByTk: secretId,
        targetCollection: 'sftpgoApiKeySecrets',
      });
      const secretUpdateDenied = await agent.resource('sftpgoConnections').update({
        filterByTk: secretId,
        targetCollection: 'sftpgoApiKeySecrets',
        values: { name: 'Secret must stay unchanged' },
      });
      const valuesSecretUpdateDenied = await agent.resource('sftpgoConnections').update({
        filterByTk: secretId,
        values: { __collection: 'sftpgoApiKeySecrets', name: 'Secret must stay unchanged' },
      });
      expect([secretGetDenied.status, secretUpdateDenied.status, valuesSecretUpdateDenied.status]).toEqual([
        403, 403, 403,
      ]);
    }

    const probeAfter = await probeRepo.findOne({ filterByTk: probeId });
    const secretAfter = await secretRepo.findOne({ filterByTk: secretId });
    const connectionAfter = await connectionRepo.findOne({ filterByTk: visibleConnectionId });
    expect(probeAfter?.get('name')).toBe('Probe unchanged');
    expect(secretAfter?.get('name')).toBe('Stored key');
    expect(secretAfter?.get('encryptedSecret')).toBe(visibleSecretCiphertext);
    expect(secretAfter?.get('connectionId')).toBe(visibleConnectionId);
    expect(connectionAfter?.get('title')).toBe(originalConnectionTitle);
  });

  it('blocks direct secret CRUD and nested secret targeting for snippet managers and root without changing data', async () => {
    if (!app) throw new Error('Mock server was not initialized');
    const secretRepo = app.db.getRepository('sftpgoApiKeySecrets');
    const beforeCount = (await secretRepo.find({ filter: { connectionId: visibleConnectionId } })).length;
    const before = await secretRepo.findOne({ filterByTk: secretId });
    expect(before).toBeTruthy();
    expect(before?.get('encryptedSecret')).toBe(visibleSecretCiphertext);

    for (const agent of [secretManager, rootAgent]) {
      const list = await agent.resource('sftpgoApiKeySecrets').list();
      const get = await agent.resource('sftpgoApiKeySecrets').get({ filterByTk: secretId });
      const create = await agent.resource('sftpgoApiKeySecrets').create({
        values: {
          connectionId: visibleConnectionId,
          apiKeyId: 'forged-key-id',
          name: 'Forged key',
          encryptedSecret: 'forged-secret',
        },
      });
      const update = await agent.resource('sftpgoApiKeySecrets').update({
        filterByTk: secretId,
        values: { name: 'Overwritten key', encryptedSecret: 'overwritten-secret' },
      });
      const destroy = await agent.resource('sftpgoApiKeySecrets').destroy({ filterByTk: secretId });

      expect([list.status, get.status, create.status, update.status, destroy.status]).toEqual([
        403, 403, 403, 403, 403,
      ]);

      const nestedRelation = await agent
        .resource('sftpgoApiKeySecrets.connection', secretId)
        .set({ values: [hiddenConnectionId] });
      expect(nestedRelation.status).toBe(403);

      const relationUpdate = await agent.resource('sftpgoApiKeySecrets.connection', secretId).update({
        filterByTk: visibleConnectionId,
        values: { name: 'Changed through secret relation' },
      });
      const relationDestroy = await agent
        .resource('sftpgoApiKeySecrets.connection', secretId)
        .destroy({ filterByTk: visibleConnectionId });
      expect([relationUpdate.status, relationDestroy.status]).toEqual([403, 403]);

      const nestedCollectionTarget = await agent.resource('sftpgoConnections').create({
        values: {
          __collection: 'sftpgoApiKeySecrets',
          connectionId: visibleConnectionId,
          apiKeyId: 'nested-forged-key-id',
          name: 'Nested forged key',
          encryptedSecret: 'nested-forged-secret',
        },
      });
      expect(nestedCollectionTarget.status).toBe(403);

      const explicitCollectionTarget = await agent.resource('sftpgoConnections').create({
        targetCollection: 'sftpgoApiKeySecrets',
        values: {
          connectionId: visibleConnectionId,
          apiKeyId: 'target-forged-key-id',
          name: 'Target forged key',
          encryptedSecret: 'target-forged-secret',
        },
      });
      expect(explicitCollectionTarget.status).toBe(403);

      expect((await secretRepo.find({ filter: { connectionId: visibleConnectionId } })).length).toBe(beforeCount);
      const unchanged = await secretRepo.findOne({ filterByTk: secretId });
      expect(unchanged?.get('name')).toBe('Stored key');
      expect(unchanged?.get('encryptedSecret')).toBe(visibleSecretCiphertext);
      expect(unchanged?.get('connectionId')).toBe(visibleConnectionId);
      const unchangedConnection = await app.db
        .getRepository('sftpgoConnections')
        .findOne({ filterByTk: visibleConnectionId });
      expect(unchangedConnection?.get('name')).toBe('Visible');
    }
  });

  it('keeps internal secret storage usable and cascades secrets when a connection is removed', async () => {
    if (!app) throw new Error('Mock server was not initialized');
    const stored = await app.db.getRepository('sftpgoApiKeySecrets').findOne({ filterByTk: secretId });
    expect(stored).toBeTruthy();
    expect(stored?.get('encryptedSecret')).not.toBe('test-only-secret-value');
    const aes = app.aesEncryptor as { decrypt: (value: string) => Promise<string> };
    await expect(aes.decrypt(stored?.get('encryptedSecret') as string)).resolves.toBe('test-only-secret-value');

    await app.db.getRepository('sftpgoConnections').destroy({ filterByTk: visibleConnectionId });
    await expect(app.db.getRepository('sftpgoApiKeySecrets').findOne({ filterByTk: secretId })).resolves.toBeNull();
  });
});
