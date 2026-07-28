import { randomUUID } from 'crypto';

import { getString } from './model-values';
import { FilesystemArtifactStore } from './filesystem-artifact-store';
import type { RegistryDatabase } from './repository-types';
import { withTransaction } from './repository-types';
import { artifactOperationLockKey, tryRunRegistryOperation, type RegistryOperationLockManager } from './operation-lock';

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

function downloadRetentionMs(): number {
  return positiveInteger(process.env.SKILL_REGISTRY_DOWNLOAD_RETENTION_DAYS, 90, 3650) * 24 * 60 * 60 * 1000;
}

function orphanGraceMs(): number {
  return positiveInteger(process.env.SKILL_REGISTRY_ORPHAN_ARTIFACT_GRACE_MINUTES, 60, 7 * 24 * 60) * 60 * 1000;
}

function maintenanceLockTtlMs(): number {
  return positiveInteger(process.env.SKILL_REGISTRY_MAINTENANCE_LOCK_TTL_MS, 10 * 60 * 1000, 60 * 60 * 1000);
}

function maintenanceBatchSize(): number {
  return positiveInteger(process.env.SKILL_REGISTRY_MAINTENANCE_BATCH_SIZE, 500, 5000);
}

function gcRecheckMs(): number {
  return positiveInteger(process.env.SKILL_REGISTRY_GC_RECHECK_MINUTES, 24 * 60, 30 * 24 * 60) * 60 * 1000;
}

export class RegistryMaintenanceService {
  constructor(
    private readonly database: RegistryDatabase,
    private readonly artifactStore: FilesystemArtifactStore,
    private readonly lockManager?: RegistryOperationLockManager,
  ) {}

  async pruneDownloadAudit(now = new Date()): Promise<void> {
    await tryRunRegistryOperation(
      this.lockManager,
      'skill-registry:maintenance:download-prune',
      maintenanceLockTtlMs(),
      async () => {
        const downloads = this.database.getRepository('skillRegistryDownloads');
        const expired = await downloads.find({
          filter: { createdAt: { $lt: new Date(now.getTime() - downloadRetentionMs()) } },
          fields: ['id'],
          sort: ['createdAt', 'id'],
          limit: maintenanceBatchSize(),
        });
        const ids = expired.map((record) => getString(record, 'id')).filter(Boolean);
        if (ids.length) {
          await downloads.destroy({ filter: { id: { $in: ids } } });
        }
      },
    );
  }

  async garbageCollectOrphanArtifacts(now = new Date()): Promise<number> {
    const attempted = await tryRunRegistryOperation(
      this.lockManager,
      'skill-registry:maintenance:artifact-gc',
      maintenanceLockTtlMs(),
      () => this.garbageCollectWithLock(now),
    );
    return attempted.acquired ? attempted.value : 0;
  }

  private async garbageCollectWithLock(now: Date): Promise<number> {
    const cutoff = now.getTime() - orphanGraceMs();
    const artifacts = this.database.getRepository('skillRegistryArtifacts');
    const versions = this.database.getRepository('skillRegistryVersions');
    const candidates = await artifacts.find({
      filter: {
        storageDriver: 'filesystem',
        createdAt: { $lt: new Date(cutoff) },
        $or: [
          { gcCheckedAt: null },
          { gcCheckedAt: { $lt: new Date(now.getTime() - gcRecheckMs()) } },
          { verificationStatus: 'deleting' },
        ],
      },
      sort: ['gcCheckedAt', 'createdAt', 'id'],
      limit: maintenanceBatchSize(),
    });
    let removedCount = 0;
    for (const artifact of candidates) {
      const createdAt = asDate(artifact.get('createdAt'));
      if (!createdAt || createdAt.getTime() > cutoff) {
        continue;
      }
      const artifactId = getString(artifact, 'id');
      if (!artifactId) {
        continue;
      }
      const digest = getString(artifact, 'digest');
      if (!digest) {
        continue;
      }
      const attempted = await tryRunRegistryOperation(
        this.lockManager,
        artifactOperationLockKey(digest),
        maintenanceLockTtlMs(),
        async () => {
          const gcToken = randomUUID();
          const storageKey = await withTransaction(this.database, async (transaction) => {
            const current = await artifacts.findOne({ filterByTk: artifactId, transaction, lock: true });
            const currentCreatedAt = current ? asDate(current.get('createdAt')) : null;
            if (!current || !currentCreatedAt || currentCreatedAt.getTime() > cutoff) {
              return null;
            }
            const referencedVersion = await versions.findOne({
              filter: { artifactId },
              transaction,
              lock: true,
            });
            if (referencedVersion) {
              await artifacts.update({
                filterByTk: artifactId,
                transaction,
                values: { gcCheckedAt: now },
              });
              return null;
            }
            const key = getString(current, 'storageKey');
            // Tombstone first, but retain the row. If file deletion fails or the
            // process crashes, the next GC pass can safely resume. Public reads
            // only accept `verified`, so they cannot serve a half-deleted file.
            await artifacts.update({
              filterByTk: artifactId,
              transaction,
              values: { verificationStatus: 'deleting', gcCheckedAt: now, gcToken },
            });
            return key;
          });
          if (!storageKey) {
            return false;
          }
          await this.artifactStore.remove(storageKey);
          // A GC worker whose distributed lock TTL expired must not delete a row
          // reclaimed by a newer worker. Only the current tombstone owner may finish.
          await artifacts.destroy({
            filter: { id: artifactId, verificationStatus: 'deleting', gcToken },
          });
          return true;
        },
      );
      if (attempted.acquired && attempted.value) {
        removedCount += 1;
      }
    }
    return removedCount;
  }
}
