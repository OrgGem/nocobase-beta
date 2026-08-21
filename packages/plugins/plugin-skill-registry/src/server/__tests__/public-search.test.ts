import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { createMockServer, type MockServer } from '@nocobase/test';

import PluginSkillRegistryServer from '../plugin';

describe('Skill Registry public catalog search', () => {
  let app: MockServer | undefined;
  let storagePath = '';
  const originalStoragePath = process.env.SKILL_REGISTRY_STORAGE_PATH;
  const originalPublicEnabled = process.env.SKILL_REGISTRY_PUBLIC_ENABLED;
  const originalRateLimitStore = process.env.SKILL_REGISTRY_RATE_LIMIT_STORE;

  beforeAll(async () => {
    storagePath = mkdtempSync(join(tmpdir(), 'skill-registry-search-'));
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

    const digest = `sha256:${'a'.repeat(64)}`;
    const manifestDigest = `sha256:${'b'.repeat(64)}`;
    const artifacts = app.db.getRepository('skillRegistryArtifacts');
    const packages = app.db.getRepository('skillRegistryPackages');
    const versions = app.db.getRepository('skillRegistryVersions');

    const seeds = [
      {
        namespace: 'orggem',
        slug: 'gen-doc-ppt-master',
        displayName: 'PPT Generator',
        description: 'Generates ppt documents',
        tags: ['ppt'],
        digestSeed: 'a',
        manifestSeed: 'b',
      },
      {
        namespace: 'acme',
        slug: 'report-builder',
        displayName: 'Report Builder',
        description: 'Builds quarterly reports',
        tags: ['report'],
        digestSeed: 'c',
        manifestSeed: 'd',
      },
    ];

    for (const [index, seed] of seeds.entries()) {
      const artifactDigest = `sha256:${seed.digestSeed.repeat(64)}`;
      const manifestDigest = `sha256:${seed.manifestSeed.repeat(64)}`;
      const artifact = await artifacts.create({
        values: {
          digest: artifactDigest,
          storageDriver: 'filesystem',
          storageKey: `sha256/${seed.digestSeed}${seed.digestSeed}/${artifactDigest.slice('sha256:'.length)}.zip`,
          format: 'zip',
          contentType: 'application/zip',
          sizeBytes: 10,
          expandedSizeBytes: 20,
          manifestDigest,
          verificationStatus: 'verified',
        },
      });
      const pkg = await packages.create({
        values: {
          namespace: seed.namespace,
          slug: seed.slug,
          displayName: seed.displayName,
          description: seed.description,
          tags: seed.tags,
          visibility: 'public',
          status: 'published',
          defaultChannel: 'stable',
          publishedAt: new Date(`2026-08-0${index + 1}T00:00:00.000Z`),
        },
      });
      await versions.create({
        values: {
          packageId: pkg.get('id'),
          version: '1.0.0',
          channel: 'stable',
          status: 'published',
          sourceRevision: `rev-${index + 1}`,
          candidateDigest: artifactDigest,
          manifest: {},
          manifestDigest,
          runtime: 'node',
          entrypoint: 'index.js',
          artifactId: artifact.get('id'),
          artifactDigest,
          publishedAt: new Date(`2026-08-0${index + 1}T00:00:00.000Z`),
        },
      });
    }
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

  it('lists the full catalog anonymously', async () => {
    const server = requireApp();
    const response = await server.agent().get('/skillRegistryPublic:list');
    expect(response.status).toBe(200);
    expect(response.body.data.map((row: { name: string }) => row.name).sort()).toEqual([
      'acme/report-builder',
      'orggem/gen-doc-ppt-master',
    ]);
    expect(response.body.meta).toEqual({ nextCursor: null });
  });

  it('searches the catalog anonymously by keyword', async () => {
    const server = requireApp();
    const response = await server.agent().get('/skillRegistryPublic:list?q=ppt');
    expect(response.status).toBe(200);
    expect(response.body.data.map((row: { name: string }) => row.name)).toEqual(['orggem/gen-doc-ppt-master']);
  });

  it('searches the catalog anonymously by namespace/slug identity', async () => {
    const server = requireApp();
    const response = await server.agent().get('/skillRegistryPublic:list?q=acme/report');
    expect(response.status).toBe(200);
    expect(response.body.data.map((row: { name: string }) => row.name)).toEqual(['acme/report-builder']);
  });

  it('returns an empty page when nothing matches', async () => {
    const server = requireApp();
    const response = await server.agent().get('/skillRegistryPublic:list?q=does-not-exist');
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
    expect(response.body.meta).toEqual({ nextCursor: null });
  });

  it('searches the catalog as an authenticated user', async () => {
    const server = requireApp();
    const user = await server.db.getRepository('users').create({ values: { nickname: 'Searcher' } });
    const agent = await server.agent().login(user);
    const response = await agent.get('/skillRegistryPublic:list?q=report');
    expect(response.status).toBe(200);
    expect(response.body.data.map((row: { name: string }) => row.name)).toEqual(['acme/report-builder']);
  });

  it('returns package metadata anonymously', async () => {
    const server = requireApp();
    const response = await server.agent().get('/skillRegistryPublic:get?package=orggem/gen-doc-ppt-master');
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      name: 'orggem/gen-doc-ppt-master',
      displayName: 'PPT Generator',
      latest: { version: '1.0.0', channel: 'stable' },
    });
  });

  it('returns a 404 for unknown packages anonymously', async () => {
    const server = requireApp();
    const response = await server.agent().get('/skillRegistryPublic:get?package=orggem/missing');
    expect(response.status).toBe(404);
  });

  it('lists version history anonymously', async () => {
    const server = requireApp();
    const response = await server.agent().get('/skillRegistryPublic:versions?package=orggem/gen-doc-ppt-master');
    expect(response.status).toBe(200);
    expect(response.body.data.map((row: { version: string }) => row.version)).toEqual(['1.0.0']);
    expect(response.body.meta).toEqual({ nextCursor: null });
  });
});
