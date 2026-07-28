import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { createMockServer, type MockServer } from '@nocobase/test';

import PluginSkillRegistryServer from '../plugin';

describe('Skill Registry plugin integration', () => {
  let app: MockServer | undefined;
  let syncAgent: ReturnType<MockServer['agent']> | undefined;
  let storagePath = '';
  const originalStoragePath = process.env.SKILL_REGISTRY_STORAGE_PATH;
  const originalPublicEnabled = process.env.SKILL_REGISTRY_PUBLIC_ENABLED;
  const originalRateLimitStore = process.env.SKILL_REGISTRY_RATE_LIMIT_STORE;

  beforeAll(async () => {
    storagePath = mkdtempSync(join(tmpdir(), 'skill-registry-plugin-'));
    process.env.SKILL_REGISTRY_STORAGE_PATH = storagePath;
    process.env.SKILL_REGISTRY_PUBLIC_ENABLED = 'true';
    delete process.env.SKILL_REGISTRY_RATE_LIMIT_STORE;
    app = await createMockServer({
      acl: true,
      registerActions: true,
      plugins: [
        'field-sort',
        'system-settings',
        'users',
        'auth',
        'acl',
        'data-source-manager',
        'data-source-main',
        'error-handler',
        [PluginSkillRegistryServer, { name: 'skill-registry' }],
      ],
    });
    await app.db.getRepository('roles').create({
      values: {
        name: 'registry-syncer',
        title: 'Registry syncer',
        snippets: ['pm.skill-registry.sync'],
      },
    });
    const syncUser = await app.db.getRepository('users').create({
      values: {
        nickname: 'Registry syncer',
        username: 'registry-syncer',
        roles: ['registry-syncer'],
      },
    });
    syncAgent = await app.agent().login(syncUser, 'registry-syncer');
  });

  afterAll(async () => {
    await app?.destroy();
    if (storagePath) {
      rmSync(storagePath, { recursive: true, force: true });
    }
    if (originalStoragePath === undefined) {
      delete process.env.SKILL_REGISTRY_STORAGE_PATH;
    } else {
      process.env.SKILL_REGISTRY_STORAGE_PATH = originalStoragePath;
    }
    if (originalPublicEnabled === undefined) {
      delete process.env.SKILL_REGISTRY_PUBLIC_ENABLED;
    } else {
      process.env.SKILL_REGISTRY_PUBLIC_ENABLED = originalPublicEnabled;
    }
    if (originalRateLimitStore === undefined) {
      delete process.env.SKILL_REGISTRY_RATE_LIMIT_STORE;
    } else {
      process.env.SKILL_REGISTRY_RATE_LIMIT_STORE = originalRateLimitStore;
    }
  });

  const requireApp = (): MockServer => {
    if (!app) {
      throw new Error('Skill Registry MockServer was not initialized.');
    }
    return app;
  };

  it('loads its immutable registry collections', () => {
    const server = requireApp();
    for (const collectionName of [
      'skillRegistrySources',
      'skillRegistrySourceItems',
      'skillRegistryPackages',
      'skillRegistryVersions',
      'skillRegistryArtifacts',
      'skillRegistrySyncRuns',
      'skillRegistryDownloads',
    ]) {
      expect(server.db.getCollection(collectionName)).toBeTruthy();
    }
  });

  it('allows anonymous metadata requests through the public resource and limiter', async () => {
    const server = requireApp();
    const response = await server.agent().get('/skillRegistryPublic:metadata');

    expect(response.status).toBe(200);
    expect(response.headers['ratelimit-remaining']).toBeDefined();
    expect(response.body.data).toMatchObject({
      contractVersion: 'registry.skill.nocobase.io/v1',
      artifactFormat: 'zip',
    });
  });

  it('does not grant anonymous callers access to registry mutations', async () => {
    const server = requireApp();
    const response = await server.agent().post('/skillRegistryAdmin:sync').send({ sourceId: '1' });

    expect([401, 403]).toContain(response.status);

    const genericMutation = await server.agent().post('/skillRegistrySources:create').send({
      name: 'must-not-create',
      providerType: 'skill-hub',
      namespace: 'acme',
      providerConfig: {},
    });

    expect([401, 403]).toContain(genericMutation.status);
  });

  it('allows the root role to use protected registry operations', async () => {
    const server = requireApp();
    const rootUser = await server.db.getRepository('users').findOne();
    expect(rootUser).toBeTruthy();
    const rootAgent = await server.agent().login(rootUser);

    const response = await rootAgent.get('/skillRegistryHealth:readiness');

    expect(response.status).toBe(200);
  });

  it('applies registry snippets as separate least-privilege grants', async () => {
    if (!syncAgent) {
      throw new Error('Registry sync test agent was not initialized.');
    }

    // A missing source proves the request passed authentication/ACL and reached the
    // sync service. The same role must not cross the publish boundary.
    const syncResponse = await syncAgent.post('/skillRegistryAdmin:sync').send({ sourceId: 'missing-source' });
    expect(syncResponse.status).toBe(404);

    const publishResponse = await syncAgent.post('/skillRegistryAdmin:publish').send({
      sourceItemId: 'missing-item',
      version: '1.0.0',
    });
    expect(publishResponse.status).toBe(403);
  });

  it('blocks GET mutations, bulk writes, and generic upserts even for root', async () => {
    const server = requireApp();
    const rootUser = await server.db.getRepository('users').findOne();
    expect(rootUser).toBeTruthy();
    const rootAgent = await server.agent().login(rootUser);

    const getCreate = await rootAgent.get('/skillRegistrySources:create');
    expect(getCreate.status).toBe(405);

    const bulkVersionUpdate = await rootAgent.resource('skillRegistryVersions').update({
      filter: { status: { $ne: 'never' } },
      values: { status: 'published' },
    });
    expect(bulkVersionUpdate.status).toBe(405);

    const sourceUpsert = await rootAgent.post('/skillRegistrySources:updateOrCreate').send({
      filterKeys: ['name'],
      values: { name: 'bypass', namespace: 'acme', providerType: 'skill-hub', providerConfig: {} },
    });
    expect(sourceUpsert.status).toBe(405);
  });

  it('validates the complete source configuration on single-record updates', async () => {
    const server = requireApp();
    const rootUser = await server.db.getRepository('users').findOne();
    expect(rootUser).toBeTruthy();
    const rootAgent = await server.agent().login(rootUser);
    const sourceResource = rootAgent.resource('skillRegistrySources');

    const created = await sourceResource.create({
      values: {
        name: 'validated-source',
        providerType: 'skill-hub',
        namespace: 'Acme',
        providerConfig: {},
        syncPolicy: 'manual',
      },
    });
    expect(created.status).toBe(200);
    const sourceId = created.body.data.id as string | number;

    const credentialInjection = await sourceResource.update({
      filterByTk: sourceId,
      values: { providerConfig: { token: 'must-not-be-stored' } },
    });
    expect(credentialInjection.status).toBe(422);
    expect(credentialInjection.body.errors?.[0]?.code).toBe('INVALID_MANIFEST');

    const nestedCredentialInjection = await sourceResource.update({
      filterByTk: sourceId,
      values: { providerConfig: { nested: { ToKeN: 'must-not-be-stored' } } },
    });
    expect(nestedCredentialInjection.status).toBe(422);
    expect(nestedCredentialInjection.body.errors?.[0]?.code).toBe('INVALID_MANIFEST');

    const selfGrant = await sourceResource.update({
      filterByTk: sourceId,
      values: { providerConfig: { Registry_Export_Enabled: true } },
    });
    expect(selfGrant.status).toBe(422);
    expect(selfGrant.body.errors?.[0]?.code).toBe('INVALID_MANIFEST');

    const operationalField = await sourceResource.update({
      filterByTk: sourceId,
      values: { status: 'ready' },
    });
    expect(operationalField.status).toBe(422);
    expect(operationalField.body.errors?.[0]?.code).toBe('INVALID_MANIFEST');

    const stored = await server.db.getRepository('skillRegistrySources').findOne({ filterByTk: sourceId });
    expect(stored?.get('namespace')).toBe('acme');
    expect(stored?.get('providerConfig')).toEqual({});

    const destroyed = await sourceResource.destroy({ filterByTk: sourceId });
    expect(destroyed.status).toBe(200);
  });
});
