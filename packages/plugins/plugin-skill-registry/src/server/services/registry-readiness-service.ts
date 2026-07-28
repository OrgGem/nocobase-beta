import { FilesystemArtifactStore } from './filesystem-artifact-store';
import type { PublicRateLimiter, PublicRateLimitScope } from './public-rate-limiter';
import type { RegistryDatabase } from './repository-types';
import { SignatureService } from './signature-service';

export interface RegistryReadinessReport {
  ready: boolean;
  status: 'ready' | 'degraded' | 'unready';
  checks: {
    database: 'ready' | 'unready';
    artifactStorage: 'ready' | 'unready';
    artifactStorageScope: 'shared' | 'process-local';
    operationLocks: 'shared' | 'process-local';
    rateLimiter: 'ready' | 'unready';
    rateLimitScope: PublicRateLimitScope | 'unavailable';
    distributedRateLimit: 'required' | 'optional';
    signing: 'enabled' | 'unsigned';
  };
}

export function requiresDistributedBackends(): boolean {
  if (process.env.SKILL_REGISTRY_REQUIRE_DISTRIBUTED_BACKENDS?.toLowerCase() === 'true') {
    return true;
  }
  if (process.env.NODE_ENV !== 'production') {
    return false;
  }
  const clusterMode = process.env.CLUSTER_MODE?.trim().toLowerCase();
  if (!clusterMode || clusterMode === '0' || clusterMode === '1') {
    return false;
  }
  return true;
}

export function artifactStorageScope(): 'shared' | 'process-local' {
  return process.env.SKILL_REGISTRY_STORAGE_SHARED?.trim().toLowerCase() === 'true' ? 'shared' : 'process-local';
}

export function operationLockScope(): 'shared' | 'process-local' {
  const adapter = process.env.LOCK_ADAPTER_DEFAULT?.trim().toLowerCase();
  return adapter && adapter !== 'local' ? 'shared' : 'process-local';
}

export function distributedTopologyReady(rateLimitScope: PublicRateLimitScope | 'unavailable'): boolean {
  return (
    !requiresDistributedBackends() ||
    (rateLimitScope === 'shared' && artifactStorageScope() === 'shared' && operationLockScope() === 'shared')
  );
}

export class RegistryReadinessService {
  constructor(
    private readonly database: RegistryDatabase,
    private readonly artifactStore: FilesystemArtifactStore,
    private readonly signatureService: SignatureService,
    private readonly getRateLimiter: () => PublicRateLimiter | undefined,
  ) {}

  async check(): Promise<RegistryReadinessReport> {
    let databaseReady = true;
    let storageReady = true;
    try {
      await this.database.getRepository('skillRegistryPackages').findOne({ filter: {} });
    } catch {
      databaseReady = false;
    }
    try {
      await this.artifactStore.ensureReady();
    } catch {
      storageReady = false;
    }
    const rateLimiter = this.getRateLimiter();
    const rateLimiterReady = Boolean(rateLimiter);
    const rateLimitScope = rateLimiter?.scope || 'unavailable';
    const storageScope = artifactStorageScope();
    const lockScope = operationLockScope();
    const distributedRateLimitRequired = requiresDistributedBackends();
    const ready = databaseReady && storageReady && rateLimiterReady && distributedTopologyReady(rateLimitScope);
    const degraded = ready && (rateLimitScope !== 'shared' || storageScope !== 'shared' || lockScope !== 'shared');
    return {
      ready,
      status: ready ? (degraded ? 'degraded' : 'ready') : 'unready',
      checks: {
        database: databaseReady ? 'ready' : 'unready',
        artifactStorage: storageReady ? 'ready' : 'unready',
        artifactStorageScope: storageScope,
        operationLocks: lockScope,
        rateLimiter: rateLimiterReady ? 'ready' : 'unready',
        rateLimitScope,
        distributedRateLimit: distributedRateLimitRequired ? 'required' : 'optional',
        signing: this.signatureService.isSigningEnabled() ? 'enabled' : 'unsigned',
      },
    };
  }
}
