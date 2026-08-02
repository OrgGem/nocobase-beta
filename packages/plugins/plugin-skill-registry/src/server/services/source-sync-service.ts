import { randomUUID } from 'crypto';

import type { RegistrySourceAccessContext, RegistrySourceDescriptor, RegistrySourceProvider } from '../contracts/types';
import { asJsonValue } from '../contracts/types';
import { RegistryError, toRegistryError } from '../contracts/errors';
import { getJson, getString, type RegistryModel } from './model-values';
import { validateDiscoveredExternalKeys, validateProviderCandidate } from './candidate-validator';
import {
  packageIdentityLockKey,
  runRegistryOperation,
  sourceOperationLockKey,
  tryRunRegistryOperation,
  type RegistryOperationLockManager,
} from './operation-lock';
import type { RegistryDatabase } from './repository-types';
import { withTransaction } from './repository-types';

type TriggerType = 'manual' | 'schedule' | 'webhook' | 'retry';

export const SCHEDULED_SYNC_ACCESS: RegistrySourceAccessContext = {
  kind: 'system',
  reason: 'scheduled-sync',
};

export type SourceDiscoveryItem = {
  externalKey: string;
  status: 'ready' | 'blocked' | 'error';
  sourceRevision?: string;
  candidateDigest?: string;
  displayName?: string;
  errorCode?: string;
};

export type SourceDiscoveryPreview = {
  sourceId: string;
  resolvedRevision: string | null;
  candidates: SourceDiscoveryItem[];
};

const EMPTY_DIGEST = `sha256:${'0'.repeat(64)}`;
const SCHEDULED_GIT_ACCESS_REQUIRED = 'SOURCE_REPOSITORY_ACCESS_REAUTHORIZATION_REQUIRED';

function modelId(model: RegistryModel): string {
  return getString(model, 'id');
}

export function sourceDescriptor(source: RegistryModel): RegistrySourceDescriptor {
  const providerType = getString(source, 'providerType');
  if (providerType !== 'skill-hub' && providerType !== 'git-manager') {
    throw new RegistryError('INVALID_MANIFEST', 422, `Unsupported source provider ${providerType}.`);
  }
  return {
    id: modelId(source),
    providerType,
    namespace: getString(source, 'namespace'),
    providerConfig: asJsonValue(getJson(source, 'providerConfig'), {}),
  };
}

function providerFor(
  providers: Map<string, RegistrySourceProvider>,
  source: RegistrySourceDescriptor,
): RegistrySourceProvider {
  const provider = providers.get(source.providerType);
  if (!provider) {
    throw new RegistryError(
      'SOURCE_PROVIDER_UNAVAILABLE',
      424,
      `Source provider ${source.providerType} is unavailable.`,
    );
  }
  return provider;
}

function packageName(namespace: string, slug: string): string {
  return `${namespace}/${slug}`;
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function lockTtlMs(): number {
  return positiveInteger(process.env.SKILL_REGISTRY_SYNC_LOCK_TTL_MS, 10 * 60 * 1000, 60 * 60 * 1000);
}

function stuckRunAgeMs(): number {
  return positiveInteger(process.env.SKILL_REGISTRY_STUCK_RUN_MINUTES, 60, 24 * 60) * 60 * 1000;
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && error.name === 'SequelizeUniqueConstraintError';
}

export class SourceSyncService {
  constructor(
    private readonly database: RegistryDatabase,
    private readonly providers: Map<string, RegistrySourceProvider>,
    private readonly lockManager?: RegistryOperationLockManager,
  ) {}

  async sync(
    sourceId: string | number,
    triggerType: TriggerType,
    requestedById?: string | number,
    access?: RegistrySourceAccessContext,
  ): Promise<RegistryModel> {
    const sourceRepository = this.database.getRepository('skillRegistrySources');
    const source = await sourceRepository.findOne({ filterByTk: sourceId });
    if (!source) {
      throw new RegistryError('SOURCE_NOT_FOUND', 404, 'Skill registry source was not found.');
    }
    return this.withSourceLock(source, () => this.syncSource(source, triggerType, requestedById, access));
  }

  async discover(sourceId: string | number, access?: RegistrySourceAccessContext): Promise<SourceDiscoveryPreview> {
    const source = await this.database.getRepository('skillRegistrySources').findOne({ filterByTk: sourceId });
    if (!source) {
      throw new RegistryError('SOURCE_NOT_FOUND', 404, 'Skill registry source was not found.');
    }
    return this.withSourceLock(source, () => this.discoverSource(source, access));
  }

  async recoverStuckRuns(maxAgeMs = stuckRunAgeMs()): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeMs);
    const runRepository = this.database.getRepository('skillRegistrySyncRuns');
    const sourceRepository = this.database.getRepository('skillRegistrySources');
    const runningRuns = await runRepository.find({ filter: { status: 'running' } });
    let recoveredCount = 0;
    for (const run of runningRuns) {
      const lastActivityAt = asDate(run.get('heartbeatAt')) || asDate(run.get('startedAt'));
      if (!lastActivityAt || lastActivityAt >= cutoff) {
        continue;
      }
      const sourceId = getString(run, 'sourceId');
      const source = sourceId ? await sourceRepository.findOne({ filterByTk: sourceId }) : null;
      const recover = async () => {
        const recovered = await withTransaction(this.database, async (transaction) => {
          const current = await runRepository.findOne({
            filterByTk: modelId(run),
            transaction,
            lock: true,
          });
          const currentActivityAt = current
            ? asDate(current.get('heartbeatAt')) || asDate(current.get('startedAt'))
            : null;
          if (
            !current ||
            getString(current, 'status') !== 'running' ||
            !currentActivityAt ||
            currentActivityAt >= cutoff
          ) {
            return false;
          }
          const message = 'Sync run exceeded the recovery timeout and was marked as failed.';
          await runRepository.update({
            filterByTk: modelId(current),
            transaction,
            values: {
              status: 'failed',
              activeKey: null,
              fencingToken: null,
              heartbeatAt: new Date(),
              errorCode: 'SYNC_STUCK_RECOVERED',
              errorMessage: message,
              finishedAt: new Date(),
            },
          });
          if (sourceId) {
            await sourceRepository.update({
              filterByTk: sourceId,
              transaction,
              values: {
                status: 'error',
                lastErrorCode: 'SYNC_STUCK_RECOVERED',
                lastErrorMessage: message,
              },
            });
          }
          return true;
        });
        if (recovered) {
          recoveredCount += 1;
        }
      };

      if (!source) {
        await recover();
        continue;
      }
      const attempted = await tryRunRegistryOperation(
        this.lockManager,
        sourceOperationLockKey(sourceId),
        lockTtlMs(),
        recover,
      );
      if (!attempted.acquired) {
        continue;
      }
    }
    return recoveredCount;
  }

  async syncDueSources(now = new Date()): Promise<{ syncedCount: number; skippedCount: number; errorCount: number }> {
    const sources = await this.database
      .getRepository('skillRegistrySources')
      .find({ filter: { enabled: true, syncPolicy: 'interval' } });
    const result = { syncedCount: 0, skippedCount: 0, errorCount: 0 };
    for (const source of sources) {
      const intervalMinutes = Number(source.get('syncIntervalMinutes'));
      if (!Number.isInteger(intervalMinutes) || intervalMinutes <= 0) {
        result.skippedCount += 1;
        continue;
      }
      const lastSyncedAt = asDate(source.get('lastSyncedAt'));
      if (lastSyncedAt && now.getTime() - lastSyncedAt.getTime() < intervalMinutes * 60 * 1000) {
        result.skippedCount += 1;
        continue;
      }
      if (getString(source, 'providerType') === 'git-manager' && !asDate(source.get('providerAccessAuthorizedAt'))) {
        // Older sources have no durable proof that their Git binding was set by
        // a repository-authorized user. Do not elevate them to the system actor
        // until an administrator saves the source (or runs a user-scoped sync).
        await this.database.getRepository('skillRegistrySources').update({
          filterByTk: modelId(source),
          values: {
            status: 'error',
            lastErrorCode: SCHEDULED_GIT_ACCESS_REQUIRED,
            lastErrorMessage:
              'Re-save this Git Manager source with a user who can read the repository before scheduled sync can run.',
          },
        });
        result.errorCount += 1;
        continue;
      }
      try {
        await this.sync(modelId(source), 'schedule', undefined, SCHEDULED_SYNC_ACCESS);
        result.syncedCount += 1;
      } catch (error) {
        if (error instanceof RegistryError && error.code === 'SYNC_ALREADY_RUNNING') {
          result.skippedCount += 1;
          continue;
        }
        result.errorCount += 1;
      }
    }
    return result;
  }

  private async withOwnedRun<T>(
    runId: string,
    sourceId: string,
    fencingToken: string,
    operation: (transaction: unknown) => Promise<T>,
  ): Promise<T> {
    const runRepository = this.database.getRepository('skillRegistrySyncRuns');
    return withTransaction(this.database, async (transaction) => {
      const owned = await runRepository.findOne({
        filter: { id: runId, sourceId, status: 'running', activeKey: sourceId, fencingToken },
        transaction,
        lock: true,
      });
      if (!owned) {
        throw new RegistryError('SYNC_RUN_FENCED', 409, 'This sync run no longer owns the source lease.');
      }
      await runRepository.update({
        filterByTk: runId,
        transaction,
        values: { heartbeatAt: new Date() },
      });
      return operation(transaction);
    });
  }

  private async heartbeatRun(runId: string, sourceId: string, fencingToken: string): Promise<void> {
    await this.withOwnedRun(runId, sourceId, fencingToken, async () => undefined);
  }

  private async finalizeOwnedRun(
    runId: string,
    sourceId: string,
    fencingToken: string,
    sourceValues: Record<string, unknown>,
    runValues: Record<string, unknown>,
  ): Promise<RegistryModel | null> {
    const sourceRepository = this.database.getRepository('skillRegistrySources');
    const runRepository = this.database.getRepository('skillRegistrySyncRuns');
    return withTransaction(this.database, async (transaction) => {
      const owned = await runRepository.findOne({
        filter: { id: runId, sourceId, status: 'running', activeKey: sourceId, fencingToken },
        transaction,
        lock: true,
      });
      if (!owned) {
        return null;
      }
      await sourceRepository.update({ filterByTk: sourceId, transaction, values: sourceValues });
      await runRepository.update({
        filterByTk: runId,
        transaction,
        values: {
          ...runValues,
          activeKey: null,
          fencingToken: null,
          heartbeatAt: new Date(),
        },
      });
      return runRepository.findOne({ filterByTk: runId, transaction });
    });
  }

  private async syncSource(
    source: RegistryModel,
    triggerType: TriggerType,
    requestedById?: string | number,
    access?: RegistrySourceAccessContext,
  ): Promise<RegistryModel> {
    const sourceRepository = this.database.getRepository('skillRegistrySources');
    const normalizedSourceId = modelId(source);
    const runRepository = this.database.getRepository('skillRegistrySyncRuns');
    const fencingToken = randomUUID();
    const startedAt = new Date();
    let run: RegistryModel;
    try {
      run = await withTransaction(this.database, async (transaction) => {
        const created = await runRepository.create({
          transaction,
          values: {
            sourceId: normalizedSourceId,
            activeKey: normalizedSourceId,
            fencingToken,
            heartbeatAt: startedAt,
            triggerType,
            status: 'running',
            requestedById: requestedById ?? null,
            startedAt,
          },
        });
        await sourceRepository.update({
          filterByTk: normalizedSourceId,
          transaction,
          values: {
            status: 'syncing',
            lastErrorCode: null,
            lastErrorMessage: null,
          },
        });
        return created;
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new RegistryError('SYNC_ALREADY_RUNNING', 409, 'A sync is already running for this source.');
      }
      throw error;
    }

    const runId = modelId(run);
    let descriptor: RegistrySourceDescriptor | undefined;
    let provider: RegistrySourceProvider | undefined;
    try {
      descriptor = sourceDescriptor(source);
      provider = providerFor(this.providers, descriptor);
      await this.heartbeatRun(runId, normalizedSourceId, fencingToken);
      const externalKeys = validateDiscoveredExternalKeys(await provider.discover(descriptor, access));
      await this.heartbeatRun(runId, normalizedSourceId, fencingToken);
      const counters = {
        discoveredCount: externalKeys.length,
        changedCount: 0,
        conflictCount: 0,
        blockedCount: 0,
        errorCount: 0,
      };
      const details: Array<Record<string, string>> = [];
      let resolvedRevision: string | null = null;

      for (const externalKey of externalKeys) {
        await this.heartbeatRun(runId, normalizedSourceId, fencingToken);
        let candidate: Awaited<ReturnType<RegistrySourceProvider['getCandidate']>> | undefined;
        try {
          candidate = validateProviderCandidate({
            provider,
            source: descriptor,
            externalKey,
            candidate: await provider.getCandidate(descriptor, externalKey, access),
          });
          resolvedRevision ||= candidate.source.revision;
          const result = await this.withOwnedRun(runId, normalizedSourceId, fencingToken, (transaction) =>
            this.upsertCandidate(source, candidate, transaction),
          );
          if (result === 'changed') {
            counters.changedCount += 1;
          }
          if (result === 'conflict') {
            counters.conflictCount += 1;
          }
          details.push({ externalKey, status: result });
        } catch (error) {
          if (candidate && isUniqueConstraintError(error)) {
            const conflictingCandidate = candidate;
            await this.withOwnedRun(runId, normalizedSourceId, fencingToken, (transaction) =>
              this.upsertIdentityConflict(source, conflictingCandidate, transaction),
            );
            counters.conflictCount += 1;
            details.push({ externalKey, status: 'conflict', code: 'PACKAGE_IDENTITY_COLLISION' });
            continue;
          }
          const registryError = toRegistryError(error);
          if (registryError.code === 'SYNC_RUN_FENCED') {
            throw registryError;
          }
          if (registryError.code === 'NON_PORTABLE_SKILL') {
            counters.blockedCount += 1;
            await this.withOwnedRun(runId, normalizedSourceId, fencingToken, (transaction) =>
              this.upsertBlockedItem(source, externalKey, registryError, transaction),
            );
            details.push({ externalKey, status: 'blocked', code: registryError.code });
          } else {
            counters.errorCount += 1;
            details.push({ externalKey, status: 'error', code: registryError.code });
          }
        }
      }

      await this.withOwnedRun(runId, normalizedSourceId, fencingToken, (transaction) =>
        this.markMissingItems(normalizedSourceId, new Set(externalKeys), transaction),
      );
      const providerAccessAuthorization =
        descriptor.providerType === 'git-manager' && access?.kind === 'user' && access.userId !== undefined
          ? {
              providerAccessAuthorizedAt: new Date(),
              providerAccessAuthorizedById: String(access.userId),
            }
          : {};
      const completed = await this.finalizeOwnedRun(
        runId,
        normalizedSourceId,
        fencingToken,
        {
          status: counters.errorCount > 0 ? 'error' : 'ready',
          lastResolvedRevision: resolvedRevision,
          lastSyncedAt: new Date(),
          lastErrorCode: null,
          lastErrorMessage: null,
          ...providerAccessAuthorization,
        },
        {
          status: counters.errorCount > 0 ? 'partial' : 'succeeded',
          resolvedRevision,
          ...counters,
          details: details.slice(0, 100),
          finishedAt: new Date(),
        },
      );
      if (!completed) {
        throw new RegistryError('SYNC_RUN_FENCED', 409, 'This sync run was recovered or superseded before completion.');
      }
      return completed;
    } catch (error) {
      const registryError = toRegistryError(error);
      await this.finalizeOwnedRun(
        runId,
        normalizedSourceId,
        fencingToken,
        {
          status: registryError.code === 'SOURCE_PROVIDER_UNAVAILABLE' ? 'unavailable' : 'error',
          lastErrorCode: registryError.code,
          lastErrorMessage: registryError.message,
        },
        {
          status: 'failed',
          errorCode: registryError.code,
          errorMessage: registryError.message,
          finishedAt: new Date(),
        },
      );
      throw registryError;
    } finally {
      if (descriptor) {
        await provider?.releaseSource?.(descriptor);
      }
    }
  }

  private async discoverSource(
    source: RegistryModel,
    access?: RegistrySourceAccessContext,
  ): Promise<SourceDiscoveryPreview> {
    const descriptor = sourceDescriptor(source);
    const provider = providerFor(this.providers, descriptor);
    try {
      const externalKeys = validateDiscoveredExternalKeys(await provider.discover(descriptor, access));
      const candidates: SourceDiscoveryItem[] = [];
      let resolvedRevision: string | null = null;
      for (const externalKey of externalKeys) {
        try {
          const candidate = validateProviderCandidate({
            provider,
            source: descriptor,
            externalKey,
            candidate: await provider.getCandidate(descriptor, externalKey, access),
          });
          resolvedRevision ||= candidate.source.revision;
          candidates.push({
            externalKey,
            status: 'ready',
            sourceRevision: candidate.source.revision,
            candidateDigest: candidate.candidateDigest,
            displayName: candidate.manifest.displayName,
          });
        } catch (error) {
          const registryError = toRegistryError(error);
          candidates.push({
            externalKey,
            status: registryError.code === 'NON_PORTABLE_SKILL' ? 'blocked' : 'error',
            errorCode: registryError.code,
          });
        }
      }
      return {
        sourceId: modelId(source),
        resolvedRevision,
        candidates,
      };
    } finally {
      await provider.releaseSource?.(descriptor);
    }
  }

  private async withSourceLock<T>(source: RegistryModel, operation: () => Promise<T>): Promise<T> {
    const sourceId = modelId(source);
    const attempted = await tryRunRegistryOperation(
      this.lockManager,
      sourceOperationLockKey(sourceId),
      lockTtlMs(),
      operation,
    );
    if (!attempted.acquired) {
      throw new RegistryError('SYNC_ALREADY_RUNNING', 409, 'A sync is already running for this source.');
    }
    return attempted.value;
  }

  private async upsertCandidate(
    source: RegistryModel,
    candidate: Awaited<ReturnType<RegistrySourceProvider['getCandidate']>>,
    transaction: unknown,
  ): Promise<'unchanged' | 'changed' | 'conflict'> {
    return runRegistryOperation(
      this.lockManager,
      packageIdentityLockKey(candidate.identity.namespace, candidate.identity.slug),
      lockTtlMs(),
      () => this.upsertCandidateWithIdentityLock(source, candidate, transaction),
    );
  }

  private async upsertCandidateWithIdentityLock(
    source: RegistryModel,
    candidate: Awaited<ReturnType<RegistrySourceProvider['getCandidate']>>,
    transaction: unknown,
  ): Promise<'unchanged' | 'changed' | 'conflict'> {
    const sourceItems = this.database.getRepository('skillRegistrySourceItems');
    const packages = this.database.getRepository('skillRegistryPackages');
    const sourceId = modelId(source);
    const existing = await sourceItems.findOne({
      filter: { sourceId, externalKey: candidate.source.externalKey },
      transaction,
    });
    if (
      existing &&
      getString(existing, 'sourceRevision') === candidate.source.revision &&
      getString(existing, 'candidateDigest') === candidate.candidateDigest
    ) {
      await sourceItems.update({
        filterByTk: modelId(existing),
        transaction,
        values: {
          lastSeenAt: new Date(),
          state: getString(existing, 'state') === 'missing' ? 'ready' : getString(existing, 'state'),
        },
      });
      return 'unchanged';
    }

    const identity = { namespace: candidate.identity.namespace, slug: candidate.identity.slug };
    const existingPackageId = existing ? getString(existing, 'packageId') : '';
    // An identity already mapped on the item (auto-mapped or set by skillRegistryAdmin:resolve) stays
    // authoritative, so a later sync does not recompute it from the manifest and undo the resolution.
    let targetPackage = existingPackageId
      ? await packages.findOne({ filterByTk: existingPackageId, transaction })
      : null;
    if (!targetPackage) {
      targetPackage = await packages.findOne({ filter: identity, transaction });
    }
    if (!targetPackage) {
      targetPackage = await packages.create({
        transaction,
        values: {
          ...identity,
          displayName: candidate.manifest.displayName,
          description: candidate.manifest.description,
          license: candidate.manifest.license || null,
          tags: candidate.manifest.tags,
          visibility: 'public',
          status: 'draft',
          defaultChannel: 'stable',
          createdById: source.get('createdById') || null,
          updatedById: source.get('updatedById') || null,
        },
      });
    }

    const targetPackageId = modelId(targetPackage);
    const mappedItems = await sourceItems.find({ filter: { packageId: targetPackageId }, transaction });
    const hasAnotherSource = mappedItems.some((item) => getString(item, 'sourceId') !== sourceId);
    if (hasAnotherSource && !existingPackageId) {
      const values = {
        packageId: existingPackageId || null,
        displayName: candidate.manifest.displayName,
        sourceRevision: candidate.source.revision,
        candidateDigest: candidate.candidateDigest,
        candidateManifest: candidate.manifest,
        state: 'conflict',
        conflictCode: 'PACKAGE_IDENTITY_COLLISION',
        conflictDetail: {
          package: packageName(getString(targetPackage, 'namespace'), getString(targetPackage, 'slug')),
        },
        lastSeenAt: new Date(),
      };
      if (existing) {
        await sourceItems.update({ filterByTk: modelId(existing), values, transaction });
      } else {
        await sourceItems.create({
          values: { sourceId, externalKey: candidate.source.externalKey, ...values },
          transaction,
        });
      }
      return 'conflict';
    }

    const values = {
      packageId: targetPackageId,
      displayName: candidate.manifest.displayName,
      sourceRevision: candidate.source.revision,
      candidateDigest: candidate.candidateDigest,
      candidateManifest: candidate.manifest,
      state: 'ready',
      conflictCode: null,
      conflictDetail: null,
      lastSeenAt: new Date(),
    };
    if (existing) {
      await sourceItems.update({ filterByTk: modelId(existing), values, transaction });
    } else {
      await sourceItems.create({
        values: { sourceId, externalKey: candidate.source.externalKey, ...values },
        transaction,
      });
    }
    return 'changed';
  }

  private async upsertIdentityConflict(
    source: RegistryModel,
    candidate: Awaited<ReturnType<RegistrySourceProvider['getCandidate']>>,
    transaction: unknown,
  ): Promise<void> {
    const sourceItems = this.database.getRepository('skillRegistrySourceItems');
    const sourceId = modelId(source);
    const externalKey = candidate.source.externalKey;
    const existing = await sourceItems.findOne({ filter: { sourceId, externalKey }, transaction });
    const values = {
      packageId: null,
      displayName: candidate.manifest.displayName,
      sourceRevision: candidate.source.revision,
      candidateDigest: candidate.candidateDigest,
      candidateManifest: candidate.manifest,
      state: 'conflict',
      conflictCode: 'PACKAGE_IDENTITY_COLLISION',
      conflictDetail: { package: packageName(candidate.identity.namespace, candidate.identity.slug) },
      lastSeenAt: new Date(),
    };
    if (existing) {
      await sourceItems.update({ filterByTk: modelId(existing), values, transaction });
      return;
    }
    await sourceItems.create({ values: { sourceId, externalKey, ...values }, transaction });
  }

  private async upsertBlockedItem(
    source: RegistryModel,
    externalKey: string,
    error: RegistryError,
    transaction: unknown,
  ): Promise<void> {
    const sourceItems = this.database.getRepository('skillRegistrySourceItems');
    const sourceId = modelId(source);
    const existing = await sourceItems.findOne({ filter: { sourceId, externalKey }, transaction });
    const values = {
      displayName: externalKey,
      sourceRevision: existing ? getString(existing, 'sourceRevision', 'unavailable') : 'unavailable',
      candidateDigest: existing ? getString(existing, 'candidateDigest', EMPTY_DIGEST) : EMPTY_DIGEST,
      candidateManifest: {},
      state: 'blocked',
      conflictCode: error.code,
      conflictDetail: { message: error.message },
      lastSeenAt: new Date(),
    };
    if (existing) {
      await sourceItems.update({ filterByTk: modelId(existing), values, transaction });
    } else {
      await sourceItems.create({ values: { sourceId, externalKey, ...values }, transaction });
    }
  }

  private async markMissingItems(sourceId: string, discoveredKeys: Set<string>, transaction: unknown): Promise<void> {
    const sourceItems = this.database.getRepository('skillRegistrySourceItems');
    const items = await sourceItems.find({ filter: { sourceId }, transaction });
    for (const item of items) {
      if (!discoveredKeys.has(getString(item, 'externalKey'))) {
        await sourceItems.update({ filterByTk: modelId(item), values: { state: 'missing' }, transaction });
      }
    }
  }
}
