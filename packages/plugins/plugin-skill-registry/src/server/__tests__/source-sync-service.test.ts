import type { RegistryModel } from '../services/model-values';
import type { RegistryDatabase, RegistryRepository } from '../services/repository-types';
import { SourceSyncService } from '../services/source-sync-service';
import { RegistryError } from '../contracts/errors';
import { candidateDigest } from '../services/canonical-json';

function model(values: Record<string, unknown>): RegistryModel {
  return {
    get(attribute: string): unknown {
      return values[attribute];
    },
  };
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

function database(repositories: Record<string, RegistryRepository>): RegistryDatabase {
  return {
    getRepository(name: string): RegistryRepository {
      const selected = repositories[name];
      if (!selected) {
        throw new Error(`Unexpected repository ${name}`);
      }
      return selected;
    },
  };
}

function validCandidate(sourceId: string, externalKey: string, slug = 'report') {
  const manifest = {
    schemaVersion: 'registry.skill.nocobase.io/v1' as const,
    name: `acme/${slug}`,
    displayName: 'Report generator',
    description: 'Generates reports.',
    runtime: { kind: 'node' as const, entrypoint: 'index.js' },
    inputSchema: {},
    outputSchema: {},
    permissions: {},
    dependencies: [],
    compatibility: {},
    tags: ['reports'],
  };
  const files = [{ path: 'index.js', content: Buffer.from('module.exports = {};') }];
  return {
    contractVersion: 'registry-candidate/v1' as const,
    source: { provider: 'skill-hub' as const, sourceId, externalKey, revision: 'sha256:revision-1' },
    identity: { namespace: 'acme', slug },
    manifest,
    files,
    candidateDigest: candidateDigest(manifest, files),
  };
}

describe('SourceSyncService maintenance and locking', () => {
  it('previews candidates without creating a sync run or mutating registry records', async () => {
    const source = model({
      id: 'source-1',
      providerType: 'skill-hub',
      namespace: 'acme',
      providerConfig: {},
    });
    const sourceRepository = repository({ findOne: vi.fn().mockResolvedValue(source) });
    const candidate = validCandidate('source-1', 'skillDefinitions:1');
    const provider = {
      discover: vi.fn().mockResolvedValue(['skillDefinitions:1']),
      type: 'skill-hub' as const,
      getCandidate: vi.fn().mockResolvedValue(candidate),
      releaseSource: vi.fn().mockResolvedValue(undefined),
    };
    const service = new SourceSyncService(
      database({ skillRegistrySources: sourceRepository }),
      new Map([['skill-hub', provider as never]]),
    );

    await expect(service.discover('source-1')).resolves.toEqual({
      sourceId: 'source-1',
      resolvedRevision: 'sha256:revision-1',
      candidates: [
        {
          externalKey: 'skillDefinitions:1',
          status: 'ready',
          sourceRevision: 'sha256:revision-1',
          candidateDigest: candidate.candidateDigest,
          displayName: 'Report generator',
        },
      ],
    });
    expect(sourceRepository.create).not.toHaveBeenCalled();
    expect(sourceRepository.update).not.toHaveBeenCalled();
    expect(provider.releaseSource).toHaveBeenCalledTimes(1);
  });

  it('uses the application lock before creating a sync run', async () => {
    const source = model({ id: 'source-1' });
    const sourceRepository = repository({ findOne: vi.fn().mockResolvedValue(source) });
    const runRepository = repository();
    const tryAcquire = vi.fn().mockRejectedValue(new Error('locked'));
    const service = new SourceSyncService(
      database({ skillRegistrySources: sourceRepository, skillRegistrySyncRuns: runRepository }),
      new Map(),
      { tryAcquire },
    );

    await expect(service.sync('source-1', 'manual')).rejects.toMatchObject({
      code: 'SYNC_ALREADY_RUNNING',
      status: 409,
    } satisfies Partial<RegistryError>);
    expect(tryAcquire).toHaveBeenCalledWith('skill-registry:source:source-1', 0);
    expect(runRepository.create).not.toHaveBeenCalled();
  });

  it('uses a unique active-run key as a database backstop when a lock lease is ineffective', async () => {
    const source = model({ id: 'source-1' });
    const sourceRepository = repository({ findOne: vi.fn().mockResolvedValue(source) });
    const uniqueError = new Error('duplicate activeKey');
    uniqueError.name = 'SequelizeUniqueConstraintError';
    const runRepository = repository({ create: vi.fn().mockRejectedValue(uniqueError) });
    const tryAcquire = vi.fn().mockResolvedValue({
      runExclusive: vi.fn().mockImplementation((operation: () => Promise<unknown>) => operation()),
    });
    const service = new SourceSyncService(
      database({ skillRegistrySources: sourceRepository, skillRegistrySyncRuns: runRepository }),
      new Map(),
      { tryAcquire },
    );

    await expect(service.sync('source-1', 'manual')).rejects.toMatchObject({
      code: 'SYNC_ALREADY_RUNNING',
      status: 409,
    } satisfies Partial<RegistryError>);
    expect(runRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ values: expect.objectContaining({ activeKey: 'source-1', status: 'running' }) }),
    );
    expect(sourceRepository.update).not.toHaveBeenCalled();
  });

  it('atomically clears the active-run key when a sync completes', async () => {
    const source = model({
      id: 'source-1',
      providerType: 'skill-hub',
      namespace: 'acme',
      providerConfig: {},
    });
    const completedRun = model({ id: 'run-1', status: 'succeeded' });
    const sourceRepository = repository({ findOne: vi.fn().mockResolvedValue(source) });
    const runRepository = repository({
      create: vi.fn().mockResolvedValue(model({ id: 'run-1' })),
      findOne: vi.fn().mockResolvedValue(completedRun),
    });
    const sourceItems = repository();
    const transaction = { id: 'transaction-1' };
    const db = database({
      skillRegistrySources: sourceRepository,
      skillRegistrySyncRuns: runRepository,
      skillRegistrySourceItems: sourceItems,
    });
    db.sequelize = {
      transaction: <T>(callback: (currentTransaction: unknown) => Promise<T>) => callback(transaction),
    };
    const provider = {
      discover: vi.fn().mockResolvedValue([]),
      releaseSource: vi.fn().mockResolvedValue(undefined),
    };
    const service = new SourceSyncService(db, new Map([['skill-hub', provider as never]]));

    await expect(service.sync('source-1', 'manual')).resolves.toBe(completedRun);
    expect(runRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        transaction,
        values: expect.objectContaining({ activeKey: 'source-1', status: 'running' }),
      }),
    );
    expect(runRepository.update).toHaveBeenCalledWith(
      expect.objectContaining({
        transaction,
        values: expect.objectContaining({ activeKey: null, status: 'succeeded' }),
      }),
    );
    expect(sourceRepository.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ transaction, values: expect.objectContaining({ status: 'ready' }) }),
    );
  });

  it('preserves an administrator-resolved package mapping on the next sync', async () => {
    const source = model({
      id: 'source-2',
      providerType: 'skill-hub',
      namespace: 'acme',
      providerConfig: {},
    });
    const existingItem = model({
      id: 'item-2',
      sourceId: 'source-2',
      packageId: 'package-1',
      externalKey: 'skillDefinitions:2',
      sourceRevision: 'revision-old',
      candidateDigest: `sha256:${'b'.repeat(64)}`,
      state: 'ready',
    });
    const otherSourceItem = model({ id: 'item-1', sourceId: 'source-1', packageId: 'package-1' });
    const resolvedPackage = model({ id: 'package-1', namespace: 'curated', slug: 'report' });
    const sourceRepository = repository({ findOne: vi.fn().mockResolvedValue(source) });
    const runRepository = repository({
      create: vi.fn().mockResolvedValue(model({ id: 'run-1' })),
      findOne: vi.fn().mockResolvedValue(model({ id: 'run-1', status: 'succeeded' })),
    });
    const sourceItems = repository({
      findOne: vi.fn().mockResolvedValue(existingItem),
      find: vi
        .fn()
        .mockImplementation(async ({ filter }: { filter: Record<string, unknown> }) =>
          filter.packageId ? [otherSourceItem] : [existingItem],
        ),
    });
    const packages = repository({ findOne: vi.fn().mockResolvedValue(resolvedPackage) });
    const updatedCandidate = validCandidate('source-2', 'skillDefinitions:2', 'different-name');
    const provider = {
      type: 'skill-hub' as const,
      discover: vi.fn().mockResolvedValue(['skillDefinitions:2']),
      getCandidate: vi.fn().mockResolvedValue(updatedCandidate),
      releaseSource: vi.fn().mockResolvedValue(undefined),
    };
    const service = new SourceSyncService(
      database({
        skillRegistrySources: sourceRepository,
        skillRegistrySyncRuns: runRepository,
        skillRegistrySourceItems: sourceItems,
        skillRegistryPackages: packages,
      }),
      new Map([['skill-hub', provider as never]]),
    );

    await expect(service.sync('source-2', 'manual')).resolves.toMatchObject({ get: expect.any(Function) });
    expect(sourceItems.update).toHaveBeenCalledWith(
      expect.objectContaining({
        filterByTk: 'item-2',
        values: expect.objectContaining({
          packageId: 'package-1',
          state: 'ready',
          conflictCode: null,
        }),
      }),
    );
  });

  it('records a package ownership unique-index race as an identity conflict', async () => {
    const source = model({
      id: 'source-2',
      providerType: 'skill-hub',
      namespace: 'acme',
      providerConfig: {},
    });
    const sourceRepository = repository({ findOne: vi.fn().mockResolvedValue(source) });
    const runRepository = repository({
      create: vi.fn().mockResolvedValue(model({ id: 'run-1' })),
      findOne: vi.fn().mockResolvedValue(model({ id: 'run-1', status: 'running' })),
    });
    const uniqueError = new Error('packageId is already owned');
    uniqueError.name = 'SequelizeUniqueConstraintError';
    const sourceItems = repository({
      findOne: vi.fn().mockResolvedValue(null),
      create: vi
        .fn()
        .mockRejectedValueOnce(uniqueError)
        .mockResolvedValue(model({ id: 'item-conflict' })),
    });
    const packages = repository({
      findOne: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(model({ id: 'package-1', namespace: 'acme', slug: 'report' })),
    });
    const discoveredCandidate = validCandidate('source-2', 'skillDefinitions:2');
    const provider = {
      type: 'skill-hub' as const,
      discover: vi.fn().mockResolvedValue(['skillDefinitions:2']),
      getCandidate: vi.fn().mockResolvedValue(discoveredCandidate),
      releaseSource: vi.fn().mockResolvedValue(undefined),
    };
    const service = new SourceSyncService(
      database({
        skillRegistrySources: sourceRepository,
        skillRegistrySyncRuns: runRepository,
        skillRegistrySourceItems: sourceItems,
        skillRegistryPackages: packages,
      }),
      new Map([['skill-hub', provider as never]]),
    );

    await service.sync('source-2', 'manual');

    expect(sourceItems.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        values: expect.objectContaining({
          packageId: null,
          state: 'conflict',
          conflictCode: 'PACKAGE_IDENTITY_COLLISION',
        }),
      }),
    );
    expect(runRepository.update).toHaveBeenCalledWith(
      expect.objectContaining({ values: expect.objectContaining({ conflictCount: 1, errorCount: 0 }) }),
    );
  });

  it('marks stale runs and their source as recoverable failures', async () => {
    const staleRun = model({
      id: 'run-1',
      sourceId: 'source-1',
      status: 'running',
      startedAt: new Date('2026-07-27T00:00:00.000Z'),
    });
    const sourceRepository = repository();
    const runRepository = repository({
      find: vi.fn().mockResolvedValue([staleRun]),
      findOne: vi.fn().mockResolvedValue(staleRun),
    });
    const service = new SourceSyncService(
      database({ skillRegistrySources: sourceRepository, skillRegistrySyncRuns: runRepository }),
      new Map(),
    );

    await expect(service.recoverStuckRuns(1)).resolves.toBe(1);
    expect(runRepository.update).toHaveBeenCalledWith(
      expect.objectContaining({
        filterByTk: 'run-1',
        values: expect.objectContaining({ status: 'failed', activeKey: null, errorCode: 'SYNC_STUCK_RECOVERED' }),
      }),
    );
    expect(sourceRepository.update).toHaveBeenCalledWith(
      expect.objectContaining({
        filterByTk: 'source-1',
        values: expect.objectContaining({ status: 'error', lastErrorCode: 'SYNC_STUCK_RECOVERED' }),
      }),
    );
  });

  it('fences a recovered slow worker so it cannot resurrect run or source state', async () => {
    const sourceValues: Record<string, unknown> = {
      id: 'source-1',
      providerType: 'skill-hub',
      namespace: 'acme',
      providerConfig: {},
      status: 'ready',
    };
    const runValues: Record<string, unknown> = {};
    const source = model(sourceValues);
    const run = model(runValues);
    const sourceRepository = repository({
      findOne: vi.fn().mockResolvedValue(source),
      update: vi.fn().mockImplementation(async ({ values }: { values: Record<string, unknown> }) => {
        Object.assign(sourceValues, values);
      }),
    });
    const runRepository = repository({
      create: vi.fn().mockImplementation(async ({ values }: { values: Record<string, unknown> }) => {
        Object.assign(runValues, values, { id: 'run-1' });
        return run;
      }),
      find: vi.fn().mockImplementation(async () => (runValues.status === 'running' ? [run] : [])),
      findOne: vi
        .fn()
        .mockImplementation(
          async ({ filter, filterByTk }: { filter?: Record<string, unknown>; filterByTk?: string }) => {
            if (filterByTk) {
              return filterByTk === runValues.id ? run : null;
            }
            if (!filter) {
              return null;
            }
            return Object.entries(filter).every(([key, value]) => runValues[key] === value) ? run : null;
          },
        ),
      update: vi.fn().mockImplementation(async ({ values }: { values: Record<string, unknown> }) => {
        Object.assign(runValues, values);
      }),
    });
    const sourceItems = repository();
    const db = database({
      skillRegistrySources: sourceRepository,
      skillRegistrySyncRuns: runRepository,
      skillRegistrySourceItems: sourceItems,
    });
    db.sequelize = {
      transaction: <T>(callback: (transaction: unknown) => Promise<T>) => callback({ id: 'transaction' }),
    };
    let notifyDiscoveryStarted = () => undefined;
    const discoveryStarted = new Promise<void>((resolve) => {
      notifyDiscoveryStarted = resolve;
    });
    let finishDiscovery = (_keys: string[]) => undefined;
    const provider = {
      discover: vi.fn().mockImplementation(async () => {
        notifyDiscoveryStarted();
        return new Promise<string[]>((resolve) => {
          finishDiscovery = resolve;
        });
      }),
      releaseSource: vi.fn().mockResolvedValue(undefined),
    };
    const lockManager = {
      tryAcquire: vi.fn().mockResolvedValue({
        runExclusive: vi.fn().mockImplementation((operation: () => Promise<unknown>) => operation()),
      }),
    };
    const service = new SourceSyncService(db, new Map([['skill-hub', provider as never]]), lockManager);

    const slowSync = service.sync('source-1', 'manual');
    await discoveryStarted;
    runValues.heartbeatAt = new Date('2026-07-27T00:00:00.000Z');
    await expect(service.recoverStuckRuns(1)).resolves.toBe(1);
    finishDiscovery([]);

    await expect(slowSync).rejects.toMatchObject({ code: 'SYNC_RUN_FENCED', status: 409 });
    expect(runValues).toMatchObject({
      status: 'failed',
      activeKey: null,
      fencingToken: null,
      errorCode: 'SYNC_STUCK_RECOVERED',
    });
    expect(sourceValues).toMatchObject({ status: 'error', lastErrorCode: 'SYNC_STUCK_RECOVERED' });
    expect(sourceRepository.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ values: expect.objectContaining({ status: 'ready' }) }),
    );
    expect(sourceItems.update).not.toHaveBeenCalled();
  });

  it('schedules only sources whose interval is due', async () => {
    const due = model({ id: 'due', syncIntervalMinutes: 5, lastSyncedAt: null });
    const current = model({
      id: 'current',
      syncIntervalMinutes: 5,
      lastSyncedAt: new Date('2026-07-28T10:58:00.000Z'),
    });
    const invalid = model({ id: 'invalid', syncIntervalMinutes: 0, lastSyncedAt: null });
    const sourceRepository = repository({ find: vi.fn().mockResolvedValue([due, current, invalid]) });
    const service = new SourceSyncService(database({ skillRegistrySources: sourceRepository }), new Map());
    const sync = vi.spyOn(service, 'sync').mockResolvedValue(model({ id: 'run-1' }));

    await expect(service.syncDueSources(new Date('2026-07-28T11:00:00.000Z'))).resolves.toEqual({
      syncedCount: 1,
      skippedCount: 2,
      errorCount: 0,
    });
    expect(sync).toHaveBeenCalledWith('due', 'schedule');
  });
});
