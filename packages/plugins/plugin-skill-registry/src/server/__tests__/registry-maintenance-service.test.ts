import type { RegistryModel } from '../services/model-values';
import { RegistryMaintenanceService } from '../services/registry-maintenance-service';
import type { RegistryDatabase, RegistryRepository } from '../services/repository-types';

function model(values: Record<string, unknown>): RegistryModel {
  return { get: (attribute: string) => values[attribute] };
}

describe('RegistryMaintenanceService', () => {
  it('expires download audit rows and removes only aged, unreferenced filesystem artifacts', async () => {
    const downloads = {
      find: vi.fn().mockResolvedValue([model({ id: 'download-1' })]),
      destroy: vi.fn().mockResolvedValue(undefined),
    } as unknown as RegistryRepository;
    const artifacts = {
      find: vi.fn().mockResolvedValue([
        model({
          id: 'orphan',
          digest: `sha256:${'a'.repeat(64)}`,
          storageKey: 'sha256/aa/bb/orphan.zip',
          createdAt: new Date('2026-07-27T00:00:00.000Z'),
        }),
        model({
          id: 'referenced',
          digest: `sha256:${'b'.repeat(64)}`,
          storageKey: 'sha256/aa/bb/referenced.zip',
          createdAt: new Date('2026-07-27T00:00:00.000Z'),
        }),
        model({
          id: 'recent',
          digest: `sha256:${'c'.repeat(64)}`,
          storageKey: 'sha256/aa/bb/recent.zip',
          createdAt: new Date('2026-07-28T11:59:00.000Z'),
        }),
      ]),
      findOne: vi.fn().mockImplementation(async ({ filterByTk }: { filterByTk: string }) =>
        filterByTk === 'orphan' || filterByTk === 'referenced'
          ? model({
              id: filterByTk,
              digest: `sha256:${filterByTk === 'orphan' ? 'a'.repeat(64) : 'b'.repeat(64)}`,
              storageKey: `sha256/aa/bb/${filterByTk}.zip`,
              createdAt: new Date('2026-07-27T00:00:00.000Z'),
            })
          : null,
      ),
      update: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
    } as unknown as RegistryRepository;
    const versions = {
      findOne: vi
        .fn()
        .mockImplementation(async ({ filter }: { filter: { artifactId: string } }) =>
          filter.artifactId === 'referenced' ? model({ id: 'version-1' }) : null,
        ),
    } as unknown as RegistryRepository;
    const database: RegistryDatabase = {
      getRepository(name: string): RegistryRepository {
        const repositories: Record<string, RegistryRepository> = {
          skillRegistryDownloads: downloads,
          skillRegistryArtifacts: artifacts,
          skillRegistryVersions: versions,
        };
        return repositories[name];
      },
    };
    const artifactStore = { remove: vi.fn().mockResolvedValue(undefined) };
    const service = new RegistryMaintenanceService(database, artifactStore as never);
    const now = new Date('2026-07-28T12:00:00.000Z');

    await service.pruneDownloadAudit(now);
    await expect(service.garbageCollectOrphanArtifacts(now)).resolves.toBe(1);
    expect(downloads.destroy).toHaveBeenCalledWith({ filter: { id: { $in: ['download-1'] } } });
    expect(artifactStore.remove).toHaveBeenCalledWith('sha256/aa/bb/orphan.zip');
    expect(artifacts.update).toHaveBeenCalledWith(
      expect.objectContaining({
        filterByTk: 'orphan',
        values: expect.objectContaining({
          verificationStatus: 'deleting',
          gcToken: expect.any(String),
        }),
      }),
    );
    expect(artifacts.destroy).toHaveBeenCalledWith({
      filter: {
        id: 'orphan',
        verificationStatus: 'deleting',
        gcToken: expect.any(String),
      },
    });
  });

  it('keeps the artifact row when a newer GC worker replaces the tombstone token', async () => {
    const digest = `sha256:${'e'.repeat(64)}`;
    let currentGcToken = '';
    let rowExists = true;
    const artifacts = {
      find: vi.fn().mockResolvedValue([
        model({
          id: 'orphan',
          digest,
          storageKey: 'sha256/ee/ee/orphan.zip',
          createdAt: new Date('2026-07-27T00:00:00.000Z'),
        }),
      ]),
      findOne: vi.fn().mockResolvedValue(
        model({
          id: 'orphan',
          digest,
          storageKey: 'sha256/ee/ee/orphan.zip',
          createdAt: new Date('2026-07-27T00:00:00.000Z'),
        }),
      ),
      update: vi.fn().mockImplementation(async ({ values }: { values: { gcToken?: string } }) => {
        currentGcToken = values.gcToken ?? currentGcToken;
      }),
      destroy: vi.fn().mockImplementation(async ({ filter }: { filter: { gcToken: string } }) => {
        if (filter.gcToken === currentGcToken) {
          rowExists = false;
        }
      }),
    } as unknown as RegistryRepository;
    const versions = { findOne: vi.fn().mockResolvedValue(null) } as unknown as RegistryRepository;
    const database: RegistryDatabase = {
      getRepository(name: string): RegistryRepository {
        return {
          skillRegistryArtifacts: artifacts,
          skillRegistryVersions: versions,
        }[name];
      },
    };
    const artifactStore = {
      remove: vi.fn().mockImplementation(async () => {
        currentGcToken = 'newer-worker-token';
      }),
    };
    const service = new RegistryMaintenanceService(database, artifactStore as never);

    await service.garbageCollectOrphanArtifacts(new Date('2026-07-28T12:00:00.000Z'));

    expect(rowExists).toBe(true);
    expect(artifacts.destroy).toHaveBeenCalledWith({
      filter: {
        id: 'orphan',
        verificationStatus: 'deleting',
        gcToken: expect.not.stringMatching(/^newer-worker-token$/),
      },
    });
  });

  it('skips an artifact while a publisher holds its digest lock', async () => {
    const digest = `sha256:${'d'.repeat(64)}`;
    const artifacts = {
      find: vi.fn().mockResolvedValue([
        model({
          id: 'orphan',
          digest,
          storageKey: 'sha256/dd/dd/orphan.zip',
          createdAt: new Date('2026-07-27T00:00:00.000Z'),
        }),
      ]),
      findOne: vi.fn(),
      destroy: vi.fn().mockResolvedValue(undefined),
    } as unknown as RegistryRepository;
    const versions = { findOne: vi.fn().mockResolvedValue(null) } as unknown as RegistryRepository;
    const database: RegistryDatabase = {
      getRepository(name: string): RegistryRepository {
        return {
          skillRegistryArtifacts: artifacts,
          skillRegistryVersions: versions,
        }[name];
      },
    };
    const artifactStore = { remove: vi.fn().mockResolvedValue(undefined) };
    const lockManager = {
      tryAcquire: vi.fn().mockImplementation(async (key: string) => {
        if (key === `skill-registry:artifact:${digest}`) {
          throw new Error('publisher owns digest lock');
        }
        return { runExclusive: vi.fn().mockImplementation((operation: () => Promise<unknown>) => operation()) };
      }),
    };
    const service = new RegistryMaintenanceService(database, artifactStore as never, lockManager);

    await expect(service.garbageCollectOrphanArtifacts(new Date('2026-07-28T12:00:00.000Z'))).resolves.toBe(0);
    expect(artifactStore.remove).not.toHaveBeenCalled();
    expect(artifacts.destroy).not.toHaveBeenCalled();
  });
});
