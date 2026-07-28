import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { FilesystemArtifactStore } from '../services/filesystem-artifact-store';
import { RegistryReadinessService } from '../services/registry-readiness-service';
import type { RegistryDatabase, RegistryRepository } from '../services/repository-types';

describe('RegistryReadinessService', () => {
  const originalRequired = process.env.SKILL_REGISTRY_REQUIRE_DISTRIBUTED_BACKENDS;
  const originalStore = process.env.SKILL_REGISTRY_RATE_LIMIT_STORE;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalClusterMode = process.env.CLUSTER_MODE;
  const originalStorageShared = process.env.SKILL_REGISTRY_STORAGE_SHARED;
  const originalLockAdapter = process.env.LOCK_ADAPTER_DEFAULT;
  let storageRoot = '';

  beforeEach(() => {
    storageRoot = mkdtempSync(join(tmpdir(), 'registry-readiness-'));
    delete process.env.SKILL_REGISTRY_REQUIRE_DISTRIBUTED_BACKENDS;
    delete process.env.SKILL_REGISTRY_RATE_LIMIT_STORE;
    delete process.env.NODE_ENV;
    delete process.env.CLUSTER_MODE;
    delete process.env.SKILL_REGISTRY_STORAGE_SHARED;
    delete process.env.LOCK_ADAPTER_DEFAULT;
  });

  afterEach(() => {
    rmSync(storageRoot, { recursive: true, force: true });
    if (originalRequired === undefined) {
      delete process.env.SKILL_REGISTRY_REQUIRE_DISTRIBUTED_BACKENDS;
    } else {
      process.env.SKILL_REGISTRY_REQUIRE_DISTRIBUTED_BACKENDS = originalRequired;
    }
    if (originalStore === undefined) {
      delete process.env.SKILL_REGISTRY_RATE_LIMIT_STORE;
    } else {
      process.env.SKILL_REGISTRY_RATE_LIMIT_STORE = originalStore;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (originalClusterMode === undefined) {
      delete process.env.CLUSTER_MODE;
    } else {
      process.env.CLUSTER_MODE = originalClusterMode;
    }
    if (originalStorageShared === undefined) {
      delete process.env.SKILL_REGISTRY_STORAGE_SHARED;
    } else {
      process.env.SKILL_REGISTRY_STORAGE_SHARED = originalStorageShared;
    }
    if (originalLockAdapter === undefined) {
      delete process.env.LOCK_ADAPTER_DEFAULT;
    } else {
      process.env.LOCK_ADAPTER_DEFAULT = originalLockAdapter;
    }
  });

  it('reports a healthy local deployment as degraded until a shared rate-limit store is configured', async () => {
    delete process.env.SKILL_REGISTRY_REQUIRE_DISTRIBUTED_BACKENDS;
    delete process.env.SKILL_REGISTRY_RATE_LIMIT_STORE;
    const database: RegistryDatabase = {
      getRepository: () => ({ findOne: vi.fn().mockResolvedValue(null) }) as unknown as RegistryRepository,
    };
    const readiness = new RegistryReadinessService(
      database,
      new FilesystemArtifactStore(storageRoot),
      { isSigningEnabled: () => false } as never,
      () => ({ scope: 'process-local' }) as never,
    );

    await expect(readiness.check()).resolves.toMatchObject({
      ready: true,
      status: 'degraded',
      checks: {
        rateLimitScope: 'process-local',
        distributedRateLimit: 'optional',
        artifactStorageScope: 'process-local',
        operationLocks: 'process-local',
        signing: 'unsigned',
      },
    });
  });

  it('refuses readiness when distributed backends are required but unavailable', async () => {
    process.env.SKILL_REGISTRY_REQUIRE_DISTRIBUTED_BACKENDS = 'true';
    delete process.env.SKILL_REGISTRY_RATE_LIMIT_STORE;
    const database: RegistryDatabase = {
      getRepository: () => ({ findOne: vi.fn().mockResolvedValue(null) }) as unknown as RegistryRepository,
    };
    const readiness = new RegistryReadinessService(
      database,
      new FilesystemArtifactStore(storageRoot),
      { isSigningEnabled: () => true } as never,
      () => undefined,
    );

    await expect(readiness.check()).resolves.toMatchObject({
      ready: false,
      status: 'unready',
      checks: {
        rateLimiter: 'unready',
        rateLimitScope: 'unavailable',
        distributedRateLimit: 'required',
        signing: 'enabled',
      },
    });
  });

  it('automatically requires a shared limiter for production cluster mode', async () => {
    delete process.env.SKILL_REGISTRY_REQUIRE_DISTRIBUTED_BACKENDS;
    process.env.NODE_ENV = 'production';
    process.env.CLUSTER_MODE = 'max';
    const database: RegistryDatabase = {
      getRepository: () => ({ findOne: vi.fn().mockResolvedValue(null) }) as unknown as RegistryRepository,
    };
    const readiness = new RegistryReadinessService(
      database,
      new FilesystemArtifactStore(storageRoot),
      { isSigningEnabled: () => false } as never,
      () => ({ scope: 'process-local' }) as never,
    );

    await expect(readiness.check()).resolves.toMatchObject({
      ready: false,
      status: 'unready',
      checks: { rateLimitScope: 'process-local', distributedRateLimit: 'required', signing: 'unsigned' },
    });
  });

  it('keeps a distributed registry unready when only the rate limiter is shared', async () => {
    process.env.SKILL_REGISTRY_REQUIRE_DISTRIBUTED_BACKENDS = 'true';
    const database: RegistryDatabase = {
      getRepository: () => ({ findOne: vi.fn().mockResolvedValue(null) }) as unknown as RegistryRepository,
    };
    const readiness = new RegistryReadinessService(
      database,
      new FilesystemArtifactStore(storageRoot),
      { isSigningEnabled: () => false } as never,
      () => ({ scope: 'shared' }) as never,
    );

    await expect(readiness.check()).resolves.toMatchObject({
      ready: false,
      status: 'unready',
      checks: {
        rateLimitScope: 'shared',
        artifactStorageScope: 'process-local',
        operationLocks: 'process-local',
      },
    });
  });

  it('accepts shared rate limiting, artifact storage, and operation locks when all are required', async () => {
    process.env.SKILL_REGISTRY_REQUIRE_DISTRIBUTED_BACKENDS = 'true';
    process.env.SKILL_REGISTRY_STORAGE_SHARED = 'true';
    process.env.LOCK_ADAPTER_DEFAULT = 'redis';
    const database: RegistryDatabase = {
      getRepository: () => ({ findOne: vi.fn().mockResolvedValue(null) }) as unknown as RegistryRepository,
    };
    const readiness = new RegistryReadinessService(
      database,
      new FilesystemArtifactStore(storageRoot),
      { isSigningEnabled: () => false } as never,
      () => ({ scope: 'shared' }) as never,
    );

    await expect(readiness.check()).resolves.toMatchObject({
      ready: true,
      status: 'ready',
      checks: {
        rateLimiter: 'ready',
        rateLimitScope: 'shared',
        artifactStorageScope: 'shared',
        operationLocks: 'shared',
        distributedRateLimit: 'required',
      },
    });
  });
});
