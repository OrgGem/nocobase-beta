import type { RegistrySkillCandidateV1, RegistrySourceProvider } from '../contracts/types';
import { RegistryError } from '../contracts/errors';
import type { RegistryModel } from '../services/model-values';
import { PublishService } from '../services/publish-service';
import type { RegistryDatabase, RegistryRepository } from '../services/repository-types';
import { candidateDigest } from '../services/canonical-json';

function model(values: Record<string, unknown>): RegistryModel {
  return { get: (attribute: string) => values[attribute] };
}

function repository(overrides: Partial<RegistryRepository> = {}): RegistryRepository {
  return {
    find: vi.fn().mockResolvedValue([]),
    findOne: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(model({ id: 'created' })),
    update: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function candidate(): RegistrySkillCandidateV1 {
  const manifest: RegistrySkillCandidateV1['manifest'] = {
    schemaVersion: 'registry.skill.nocobase.io/v1',
    name: 'acme/original-report',
    displayName: 'Report skill',
    description: 'Creates reports.',
    runtime: { kind: 'node', entrypoint: 'index.js' },
    inputSchema: {},
    outputSchema: {},
    permissions: {},
    dependencies: [],
    compatibility: {},
    tags: ['reports'],
  };
  const files = [{ path: 'index.js', content: Buffer.from('module.exports = {};') }];
  return {
    contractVersion: 'registry-candidate/v1',
    source: {
      provider: 'skill-hub',
      sourceId: 'source-1',
      externalKey: 'skillDefinitions:1',
      revision: 'revision-1',
    },
    identity: { namespace: 'acme', slug: 'original-report', suggestedVersion: '1.0.0' },
    manifest,
    files,
    candidateDigest: candidateDigest(manifest, files),
  };
}

function createPublishFixture(versionCreateError?: Error) {
  const providerCandidate = candidate();
  const sourceItem = model({
    id: 'item-1',
    sourceId: 'source-1',
    packageId: 'package-1',
    externalKey: 'skillDefinitions:1',
    sourceRevision: 'revision-1',
    candidateDigest: providerCandidate.candidateDigest,
    state: 'ready',
  });
  const source = model({
    id: 'source-1',
    providerType: 'skill-hub',
    namespace: 'acme',
    providerConfig: {},
  });
  const packageRecord = model({
    id: 'package-1',
    namespace: 'acme',
    slug: 'report',
    publishedAt: null,
    license: null,
  });
  const createdVersion = model({
    id: 'version-1',
    version: '1.0.0',
    candidateDigest: providerCandidate.candidateDigest,
  });
  const sourceItems = repository({ findOne: vi.fn().mockResolvedValue(sourceItem) });
  const syncRuns = repository();
  const sources = repository({ findOne: vi.fn().mockResolvedValue(source) });
  const packages = repository({ findOne: vi.fn().mockResolvedValue(packageRecord) });
  const versions = repository({
    findOne: vi.fn().mockResolvedValue(null),
    create: versionCreateError
      ? vi.fn().mockRejectedValue(versionCreateError)
      : vi.fn().mockResolvedValue(createdVersion),
  });
  const artifacts = repository({
    findOne: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(model({ id: 'artifact-1' })),
  });
  const transaction = { id: 'transaction-1' };
  const repositories: Record<string, RegistryRepository> = {
    skillRegistrySourceItems: sourceItems,
    skillRegistrySyncRuns: syncRuns,
    skillRegistrySources: sources,
    skillRegistryPackages: packages,
    skillRegistryVersions: versions,
    skillRegistryArtifacts: artifacts,
  };
  const database: RegistryDatabase = {
    getRepository(name: string): RegistryRepository {
      return repositories[name];
    },
    sequelize: {
      transaction: <T>(callback: (currentTransaction: unknown) => Promise<T>) => callback(transaction),
    },
  };
  const provider: RegistrySourceProvider = {
    type: 'skill-hub',
    discover: vi.fn().mockResolvedValue([]),
    getCandidate: vi.fn().mockResolvedValue(providerCandidate),
    releaseSource: vi.fn().mockResolvedValue(undefined),
  };
  const generatedStorageKey = 'sha256/aa/bb/artifact-generation.zip';
  const artifactStore = {
    keyForDigestGeneration: vi.fn().mockReturnValue(generatedStorageKey),
    isKeyForDigest: vi.fn().mockReturnValue(true),
    putAt: vi.fn().mockResolvedValue({ storageKey: generatedStorageKey, sizeBytes: 123 }),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  const signatureService = { keyId: 'unconfigured', signEnvelope: vi.fn().mockReturnValue(null) };
  const lockKeys: string[] = [];
  const lockManager = {
    tryAcquire: vi.fn().mockImplementation(async (key: string) => {
      lockKeys.push(`try:${key}`);
      return {
        runExclusive: <T>(operation: () => Promise<T>) => operation(),
      };
    }),
    runExclusive: <T>(key: string, operation: () => Promise<T>) => {
      lockKeys.push(`run:${key}`);
      return operation();
    },
  };
  const service = new PublishService(
    database,
    new Map([['skill-hub', provider]]),
    artifactStore as never,
    signatureService as never,
    lockManager,
  );
  return {
    service,
    sourceItems,
    syncRuns,
    packages,
    versions,
    artifacts,
    provider,
    artifactStore,
    signatureService,
    transaction,
    lockKeys,
    createdVersion,
    candidateDigest: providerCandidate.candidateDigest,
  };
}

describe('PublishService concurrency', () => {
  it('shares the source lock with sync and fails before reading a candidate when it is busy', async () => {
    const sourceItems = repository({
      findOne: vi.fn().mockResolvedValue(model({ id: 'item-1', sourceId: 'source-1' })),
    });
    const database: RegistryDatabase = {
      getRepository(name: string): RegistryRepository {
        if (name !== 'skillRegistrySourceItems') {
          throw new Error(`Unexpected repository ${name}`);
        }
        return sourceItems;
      },
    };
    const lockManager = { tryAcquire: vi.fn().mockRejectedValue(new Error('locked')) };
    const service = new PublishService(database, new Map(), { putAt: vi.fn() } as never, {} as never, lockManager);

    await expect(service.publish({ sourceItemId: 'item-1', version: '1.0.0' })).rejects.toMatchObject({
      code: 'REGISTRY_OPERATION_BUSY',
      status: 409,
    } satisfies Partial<RegistryError>);
    expect(lockManager.tryAcquire).toHaveBeenCalledWith('skill-registry:source:source-1', 0);
  });

  it('locks source, package, and digest and commits related records in one transaction', async () => {
    const fixture = createPublishFixture();

    await expect(fixture.service.publish({ sourceItemId: 'item-1', version: '1.0.0' })).resolves.toBe(
      fixture.createdVersion,
    );
    expect(fixture.lockKeys[0]).toBe('try:skill-registry:source:source-1');
    expect(fixture.lockKeys[1]).toBe('run:skill-registry:package:package-1');
    expect(fixture.lockKeys[2]).toMatch(/^run:skill-registry:artifact:sha256:[a-f0-9]{64}$/);
    expect(fixture.artifactStore.keyForDigestGeneration).toHaveBeenCalledWith(
      expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    );
    expect(fixture.artifactStore.putAt).toHaveBeenCalledWith(
      'sha256/aa/bb/artifact-generation.zip',
      expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      expect.any(Buffer),
    );
    expect(fixture.artifacts.create).toHaveBeenCalledWith(
      expect.objectContaining({
        transaction: fixture.transaction,
        values: expect.objectContaining({ storageKey: 'sha256/aa/bb/artifact-generation.zip' }),
      }),
    );
    expect(fixture.versions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        transaction: fixture.transaction,
        values: expect.objectContaining({ manifest: expect.objectContaining({ name: 'acme/report' }) }),
      }),
    );
    expect(fixture.signatureService.signEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({ packageName: 'acme/report', version: '1.0.0' }),
    );
    expect(fixture.packages.update).toHaveBeenCalledWith(expect.objectContaining({ transaction: fixture.transaction }));
    expect(fixture.sourceItems.update).toHaveBeenCalledWith(
      expect.objectContaining({ transaction: fixture.transaction }),
    );
    expect(fixture.provider.releaseSource).toHaveBeenCalledTimes(1);
  });

  it('rejects publish when the database still records an active sync after a lock lease expires', async () => {
    const fixture = createPublishFixture();
    vi.mocked(fixture.syncRuns.findOne).mockResolvedValue(model({ id: 'run-1', activeKey: 'source-1' }));

    await expect(fixture.service.publish({ sourceItemId: 'item-1', version: '1.0.0' })).rejects.toMatchObject({
      code: 'REGISTRY_OPERATION_BUSY',
      status: 409,
    } satisfies Partial<RegistryError>);
    expect(fixture.artifactStore.putAt).not.toHaveBeenCalled();
  });

  it('does not silently republish a yanked immutable version', async () => {
    const fixture = createPublishFixture();
    vi.mocked(fixture.versions.findOne).mockResolvedValue(
      model({
        id: 'version-yanked',
        version: '1.0.0',
        candidateDigest: fixture.candidateDigest,
        status: 'yanked',
      }),
    );

    await expect(fixture.service.publish({ sourceItemId: 'item-1', version: '1.0.0' })).rejects.toMatchObject({
      code: 'VERSION_IMMUTABLE',
      status: 409,
    } satisfies Partial<RegistryError>);
    expect(fixture.artifactStore.putAt).not.toHaveBeenCalled();
  });

  it('removes newly stored bytes when the database transaction rolls back without an artifact row', async () => {
    const fixture = createPublishFixture(new Error('database unavailable'));

    await expect(fixture.service.publish({ sourceItemId: 'item-1', version: '1.0.0' })).rejects.toThrow(
      'database unavailable',
    );
    expect(fixture.artifactStore.remove).toHaveBeenCalledWith('sha256/aa/bb/artifact-generation.zip');
    expect(fixture.provider.releaseSource).toHaveBeenCalledTimes(1);
  });
});

describe('PublishService unpublish', () => {
  it('returns the package to draft when its final published version is yanked', async () => {
    const publishedVersion = model({
      id: 'version-1',
      packageId: 'package-1',
      channel: 'stable',
      status: 'published',
    });
    const versions = repository({
      findOne: vi
        .fn()
        .mockResolvedValueOnce(publishedVersion)
        .mockResolvedValueOnce(publishedVersion)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null),
    });
    const packages = repository({
      findOne: vi.fn().mockResolvedValue(model({ id: 'package-1', latestStableVersionId: 'version-1' })),
    });
    const database: RegistryDatabase = {
      getRepository(name: string): RegistryRepository {
        return name === 'skillRegistryVersions' ? versions : packages;
      },
      sequelize: { transaction: <T>(callback: (transaction: unknown) => Promise<T>) => callback({}) },
    };
    const service = new PublishService(database, new Map(), {} as never, {} as never);

    await service.yank('version-1', 'Superseded');

    expect(packages.update).toHaveBeenCalledWith(
      expect.objectContaining({
        filterByTk: 'package-1',
        values: { status: 'draft', latestStableVersionId: null },
      }),
    );
  });

  it('yanks every published version and returns the candidate to ready', async () => {
    const sourceItems = repository({
      findOne: vi.fn().mockResolvedValue(model({ id: 'item-1', sourceId: 'source-1', state: 'published' })),
    });
    const publishedVersions = [
      model({ id: 'version-2', status: 'published' }),
      model({ id: 'version-1', status: 'published' }),
    ];
    const versions = repository({
      find: vi.fn().mockResolvedValue(publishedVersions),
      findOne: vi.fn().mockResolvedValue(null),
    });
    const database: RegistryDatabase = {
      getRepository(name: string): RegistryRepository {
        return name === 'skillRegistrySourceItems' ? sourceItems : versions;
      },
    };
    const service = new PublishService(database, new Map(), {} as never, {} as never);
    const yank = vi.spyOn(service, 'yank').mockResolvedValue(undefined);

    await expect(service.unpublishSourceItem('item-1', 'Superseded')).resolves.toEqual({
      sourceItemId: 'item-1',
      state: 'ready',
      yanked: 2,
    });

    expect(yank).toHaveBeenNthCalledWith(1, 'version-2', 'Superseded');
    expect(yank).toHaveBeenNthCalledWith(2, 'version-1', 'Superseded');
    expect(sourceItems.update).toHaveBeenCalledWith({ filterByTk: 'item-1', values: { state: 'ready' } });
  });

  it('rejects a candidate that is not published', async () => {
    const sourceItems = repository({
      findOne: vi.fn().mockResolvedValue(model({ id: 'item-1', state: 'ready' })),
    });
    const database: RegistryDatabase = { getRepository: () => sourceItems };
    const service = new PublishService(database, new Map(), {} as never, {} as never);

    await expect(service.unpublishSourceItem('item-1', 'Mistake')).rejects.toMatchObject({
      code: 'SOURCE_ITEM_NOT_PUBLISHED',
      status: 409,
    } satisfies Partial<RegistryError>);
  });

  it('uses the same source lock as publish and sync operations', async () => {
    const sourceItems = repository({
      findOne: vi.fn().mockResolvedValue(model({ id: 'item-1', sourceId: 'source-1', state: 'published' })),
    });
    const database: RegistryDatabase = { getRepository: () => sourceItems };
    const lockManager = { tryAcquire: vi.fn().mockRejectedValue(new Error('locked')) };
    const service = new PublishService(database, new Map(), {} as never, {} as never, lockManager);

    await expect(service.unpublishSourceItem('item-1', 'Mistake')).rejects.toMatchObject({
      code: 'REGISTRY_OPERATION_BUSY',
      status: 409,
    } satisfies Partial<RegistryError>);
    expect(lockManager.tryAcquire).toHaveBeenCalledWith('skill-registry:source:source-1', 0);
  });
});
