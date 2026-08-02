import type { RegistryModel } from './model-values';
import { getString } from './model-values';
import { buildArtifact } from './artifact-builder';
import { FilesystemArtifactStore } from './filesystem-artifact-store';
import { SignatureService } from './signature-service';
import type { RegistryDatabase } from './repository-types';
import { withTransaction } from './repository-types';
import type { RegistrySourceAccessContext, RegistrySourceProvider } from '../contracts/types';
import { RegistryError } from '../contracts/errors';
import { assertChannel, assertSemver } from './validation';
import { sourceDescriptor } from './source-sync-service';
import { validateProviderCandidate } from './candidate-validator';
import {
  artifactOperationLockKey,
  packageOperationLockKey,
  runRegistryOperation,
  sourceOperationLockKey,
  tryRunRegistryOperation,
  type RegistryOperationLockManager,
} from './operation-lock';

function modelId(model: RegistryModel): string {
  return getString(model, 'id');
}

function providerFor(providers: Map<string, RegistrySourceProvider>, type: string): RegistrySourceProvider {
  const provider = providers.get(type);
  if (!provider) {
    throw new RegistryError('SOURCE_PROVIDER_UNAVAILABLE', 424, `Source provider ${type} is unavailable.`);
  }
  return provider;
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && error.name === 'SequelizeUniqueConstraintError';
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

function publishLockTtlMs(): number {
  return positiveInteger(process.env.SKILL_REGISTRY_PUBLISH_LOCK_TTL_MS, 10 * 60 * 1000, 60 * 60 * 1000);
}

export class PublishService {
  constructor(
    private readonly database: RegistryDatabase,
    private readonly providers: Map<string, RegistrySourceProvider>,
    private readonly artifactStore: FilesystemArtifactStore,
    private readonly signatureService: SignatureService,
    private readonly lockManager?: RegistryOperationLockManager,
  ) {}

  private async findPublishedVersion(
    identity: {
      packageId: string;
      version: string;
      sourceItemId: string;
      sourceRevision: string;
      candidateDigest: string;
    },
    transaction?: unknown,
  ): Promise<RegistryModel | null> {
    const versions = this.database.getRepository('skillRegistryVersions');
    const sameVersion = await versions.findOne({
      filter: { packageId: identity.packageId, version: identity.version },
      transaction,
    });
    if (sameVersion) {
      if (getString(sameVersion, 'candidateDigest') === identity.candidateDigest) {
        if (getString(sameVersion, 'status') === 'published') {
          return sameVersion;
        }
        throw new RegistryError(
          'VERSION_IMMUTABLE',
          409,
          `Version ${identity.version} is ${getString(
            sameVersion,
            'status',
            'not published',
          )} and cannot be republished.`,
        );
      }
      throw new RegistryError(
        'VERSION_IMMUTABLE',
        409,
        `Version ${identity.version} already exists with different content.`,
      );
    }
    // Unique index (sourceItemId, sourceRevision, candidateDigest): identical content cannot be
    // republished under a second version number, so report the existing version instead of failing.
    const sameCandidate = await versions.findOne({
      filter: {
        sourceItemId: identity.sourceItemId,
        sourceRevision: identity.sourceRevision,
        candidateDigest: identity.candidateDigest,
      },
      transaction,
    });
    if (sameCandidate) {
      throw new RegistryError(
        'VERSION_IMMUTABLE',
        409,
        `This source revision is already published as version ${getString(sameCandidate, 'version')}.`,
      );
    }
    return null;
  }

  async publish(input: {
    sourceItemId: string | number;
    version: string;
    channel?: string;
    changelog?: string;
    publishedById?: string | number;
    access?: RegistrySourceAccessContext;
  }): Promise<RegistryModel> {
    const sourceItem = await this.database
      .getRepository('skillRegistrySourceItems')
      .findOne({ filterByTk: input.sourceItemId });
    if (!sourceItem) {
      throw new RegistryError('SOURCE_ITEM_NOT_FOUND', 404, 'Skill registry source item was not found.');
    }
    const sourceId = getString(sourceItem, 'sourceId');
    const attempted = await tryRunRegistryOperation(
      this.lockManager,
      sourceOperationLockKey(sourceId),
      publishLockTtlMs(),
      () => this.publishWithSourceLock(input, sourceId),
    );
    if (!attempted.acquired) {
      throw new RegistryError(
        'REGISTRY_OPERATION_BUSY',
        409,
        'The source is currently being synchronized or published. Retry the request.',
      );
    }
    return attempted.value;
  }

  private async publishWithSourceLock(
    input: {
      sourceItemId: string | number;
      version: string;
      channel?: string;
      changelog?: string;
      publishedById?: string | number;
      access?: RegistrySourceAccessContext;
    },
    expectedSourceId: string,
  ): Promise<RegistryModel> {
    const sourceItems = this.database.getRepository('skillRegistrySourceItems');
    const activeSync = await this.database
      .getRepository('skillRegistrySyncRuns')
      .findOne({ filter: { activeKey: expectedSourceId } });
    if (activeSync) {
      throw new RegistryError(
        'REGISTRY_OPERATION_BUSY',
        409,
        'The source is currently being synchronized. Retry the request after sync completes.',
      );
    }
    const sourceItem = await sourceItems.findOne({ filterByTk: input.sourceItemId });
    if (!sourceItem) {
      throw new RegistryError('SOURCE_ITEM_NOT_FOUND', 404, 'Skill registry source item was not found.');
    }
    if (getString(sourceItem, 'sourceId') !== expectedSourceId) {
      throw new RegistryError('SOURCE_REVISION_CHANGED', 409, 'Source item changed while publish was waiting.');
    }
    if (getString(sourceItem, 'state') !== 'ready' && getString(sourceItem, 'state') !== 'published') {
      throw new RegistryError('SOURCE_ITEM_NOT_READY', 409, 'Source item must be ready before it can be published.');
    }
    const packageId = getString(sourceItem, 'packageId');
    if (!packageId) {
      throw new RegistryError('PACKAGE_IDENTITY_COLLISION', 409, 'Source item has no resolved package identity.');
    }
    const sources = this.database.getRepository('skillRegistrySources');
    const source = await sources.findOne({ filterByTk: getString(sourceItem, 'sourceId') });
    if (!source) {
      throw new RegistryError('SOURCE_NOT_FOUND', 404, 'Source for this item was not found.');
    }
    const descriptor = sourceDescriptor(source);
    const provider = providerFor(this.providers, descriptor.providerType);
    try {
      const externalKey = getString(sourceItem, 'externalKey');
      const candidate = validateProviderCandidate({
        provider,
        source: descriptor,
        externalKey,
        candidate: await provider.getCandidate(descriptor, externalKey, input.access),
      });
      if (
        candidate.source.revision !== getString(sourceItem, 'sourceRevision') ||
        candidate.candidateDigest !== getString(sourceItem, 'candidateDigest')
      ) {
        throw new RegistryError(
          'SOURCE_REVISION_CHANGED',
          409,
          'Source changed after sync. Run sync and review the new candidate first.',
        );
      }
      const version = assertSemver(input.version);
      if (candidate.identity.suggestedVersion && candidate.identity.suggestedVersion !== version) {
        throw new RegistryError(
          'SOURCE_VERSION_MISMATCH',
          422,
          'Requested version does not match the source manifest version.',
        );
      }
      const channel = assertChannel(input.channel || 'stable');
      const packages = this.database.getRepository('skillRegistryPackages');
      const packageRecord = await packages.findOne({ filterByTk: packageId });
      if (!packageRecord) {
        throw new RegistryError('PACKAGE_NOT_FOUND', 404, 'Package for this source item was not found.');
      }
      const versions = this.database.getRepository('skillRegistryVersions');
      const publishedIdentity = {
        packageId,
        version,
        sourceItemId: modelId(sourceItem),
        sourceRevision: candidate.source.revision,
        candidateDigest: candidate.candidateDigest,
      };

      return await runRegistryOperation(
        this.lockManager,
        packageOperationLockKey(packageId),
        publishLockTtlMs(),
        async () => {
          const alreadyPublished = await this.findPublishedVersion(publishedIdentity);
          if (alreadyPublished) {
            return alreadyPublished;
          }

          const packageName = `${getString(packageRecord, 'namespace')}/${getString(packageRecord, 'slug')}`;
          const manifest = { ...candidate.manifest, name: packageName, version };
          const artifact = buildArtifact({ ...candidate, manifest });
          return runRegistryOperation(
            this.lockManager,
            artifactOperationLockKey(artifact.digest),
            publishLockTtlMs(),
            async () => {
              const artifacts = this.database.getRepository('skillRegistryArtifacts');
              const artifactBeforeWrite = await artifacts.findOne({ filter: { digest: artifact.digest } });
              if (
                artifactBeforeWrite &&
                (Boolean(getString(artifactBeforeWrite, 'gcToken')) ||
                  !this.artifactStore.isKeyForDigest(getString(artifactBeforeWrite, 'storageKey'), artifact.digest))
              ) {
                throw new RegistryError(
                  'ARTIFACT_DIGEST_MISMATCH',
                  409,
                  'Existing artifact storage is not safe to reuse while publishing.',
                );
              }
              // A new artifact row gets a unique, digest-bound storage generation.
              // A stale GC worker can then remove only the generation it claimed,
              // never a file published later for the same SHA-256 digest.
              const targetStorageKey = artifactBeforeWrite
                ? getString(artifactBeforeWrite, 'storageKey')
                : this.artifactStore.keyForDigestGeneration(artifact.digest);
              const storedArtifact = await this.artifactStore.putAt(
                targetStorageKey,
                artifact.digest,
                artifact.content,
              );
              let keepStoredArtifact = false;
              try {
                const signature = this.signatureService.signEnvelope({
                  packageName,
                  version,
                  manifestDigest: artifact.manifestDigest,
                  artifactDigest: artifact.digest,
                });

                const createVersion = () =>
                  withTransaction(this.database, async (transaction) => {
                    // Lock the source item and package rows before committing the version. If a
                    // sync slipped past an expired lease, it either completes first (and this
                    // re-check rejects the stale candidate) or waits and applies its new state
                    // after this publish commits.
                    const lockedSourceItem = await sourceItems.findOne({
                      filterByTk: input.sourceItemId,
                      transaction,
                      lock: true,
                    });
                    if (
                      !lockedSourceItem ||
                      getString(lockedSourceItem, 'sourceId') !== expectedSourceId ||
                      getString(lockedSourceItem, 'packageId') !== packageId ||
                      getString(lockedSourceItem, 'sourceRevision') !== candidate.source.revision ||
                      getString(lockedSourceItem, 'candidateDigest') !== candidate.candidateDigest ||
                      !['ready', 'published'].includes(getString(lockedSourceItem, 'state'))
                    ) {
                      throw new RegistryError(
                        'SOURCE_REVISION_CHANGED',
                        409,
                        'Source changed after sync. Run sync and review the new candidate first.',
                      );
                    }
                    const lockedPackage = await packages.findOne({ filterByTk: packageId, transaction, lock: true });
                    if (!lockedPackage) {
                      throw new RegistryError('PACKAGE_NOT_FOUND', 404, 'Package for this source item was not found.');
                    }
                    const lockedPackageName = `${getString(lockedPackage, 'namespace')}/${getString(
                      lockedPackage,
                      'slug',
                    )}`;
                    if (lockedPackageName !== packageName) {
                      throw new RegistryError(
                        'PACKAGE_IDENTITY_COLLISION',
                        409,
                        'Package identity changed while the version was being built.',
                      );
                    }
                    const racedBeforeCreate = await this.findPublishedVersion(publishedIdentity, transaction);
                    if (racedBeforeCreate) {
                      return racedBeforeCreate;
                    }

                    let artifactRecord = await artifacts.findOne({
                      filter: { digest: artifact.digest },
                      transaction,
                      lock: true,
                    });
                    if (
                      artifactRecord &&
                      (getString(artifactRecord, 'storageDriver') !== 'filesystem' ||
                        getString(artifactRecord, 'storageKey') !== storedArtifact.storageKey ||
                        getString(artifactRecord, 'format') !== 'zip' ||
                        getString(artifactRecord, 'contentType') !== 'application/zip' ||
                        getString(artifactRecord, 'manifestDigest') !== artifact.manifestDigest ||
                        !['verified', 'corrupt', 'deleting'].includes(
                          getString(artifactRecord, 'verificationStatus'),
                        ) ||
                        Boolean(getString(artifactRecord, 'gcToken')) ||
                        Number(artifactRecord.get('sizeBytes')) !== storedArtifact.sizeBytes ||
                        Number(artifactRecord.get('expandedSizeBytes')) !== artifact.expandedSizeBytes)
                    ) {
                      throw new RegistryError(
                        'ARTIFACT_DIGEST_MISMATCH',
                        409,
                        'Existing artifact metadata does not match the content-addressed bytes.',
                      );
                    }
                    if (!artifactRecord) {
                      artifactRecord = await artifacts.create({
                        transaction,
                        values: {
                          digest: artifact.digest,
                          storageDriver: 'filesystem',
                          storageKey: storedArtifact.storageKey,
                          format: 'zip',
                          contentType: 'application/zip',
                          sizeBytes: storedArtifact.sizeBytes,
                          expandedSizeBytes: artifact.expandedSizeBytes,
                          manifestDigest: artifact.manifestDigest,
                          verificationStatus: 'verified',
                        },
                      });
                    } else if (
                      getString(artifactRecord, 'verificationStatus') !== 'verified' ||
                      artifactRecord.get('gcCheckedAt')
                    ) {
                      // A failed/paused GC may leave a tombstoned row. `put`
                      // above has re-established and read-back verified the
                      // content-addressed bytes, so publishing may safely revive it.
                      await artifacts.update({
                        filterByTk: modelId(artifactRecord),
                        transaction,
                        values: { verificationStatus: 'verified', gcCheckedAt: null, gcToken: null },
                      });
                    }

                    const createdVersion = await versions.create({
                      transaction,
                      values: {
                        packageId,
                        sourceItemId: modelId(lockedSourceItem),
                        version,
                        channel,
                        status: 'published',
                        sourceRevision: candidate.source.revision,
                        candidateDigest: candidate.candidateDigest,
                        manifest,
                        manifestDigest: artifact.manifestDigest,
                        runtime: manifest.runtime.kind,
                        entrypoint: manifest.runtime.entrypoint,
                        permissions: manifest.permissions,
                        dependencies: manifest.dependencies,
                        compatibility: manifest.compatibility,
                        changelog: input.changelog || null,
                        artifactId: modelId(artifactRecord),
                        artifactDigest: artifact.digest,
                        registrySignature: signature,
                        signatureKeyId: signature ? this.signatureService.keyId : null,
                        validationReport: { artifact: 'verified' },
                        publishedById: input.publishedById ?? null,
                        publishedAt: new Date(),
                      },
                    });
                    const values: Record<string, unknown> = {
                      status: 'published',
                      publishedAt: lockedPackage.get('publishedAt') || new Date(),
                      displayName: manifest.displayName,
                      description: manifest.description,
                      tags: manifest.tags,
                      license: manifest.license || lockedPackage.get('license') || null,
                    };
                    if (channel === 'stable') {
                      values.latestStableVersionId = modelId(createdVersion);
                    }
                    await packages.update({ filterByTk: packageId, values, transaction });
                    await sourceItems.update({
                      filterByTk: modelId(lockedSourceItem),
                      values: { state: 'published' },
                      transaction,
                    });
                    return createdVersion;
                  });

                try {
                  const result = await createVersion();
                  keepStoredArtifact = true;
                  return result;
                } catch (error) {
                  if (!isUniqueConstraintError(error)) {
                    throw error;
                  }
                  // A concurrent publisher that did not use this process lock may have won the
                  // unique-index race. Re-read to preserve idempotent publish semantics.
                  const raced = await this.findPublishedVersion(publishedIdentity);
                  if (raced) {
                    keepStoredArtifact = true;
                    return raced;
                  }
                  throw new RegistryError(
                    'VERSION_IMMUTABLE',
                    409,
                    `Version ${version} conflicts with an existing version.`,
                  );
                }
              } finally {
                if (!keepStoredArtifact) {
                  const tracked = await artifacts.findOne({ filter: { digest: artifact.digest } });
                  if (!tracked || getString(tracked, 'storageKey') !== storedArtifact.storageKey) {
                    await this.artifactStore.remove(storedArtifact.storageKey).catch(() => undefined);
                  }
                }
              }
            },
          );
        },
      );
    } finally {
      await provider.releaseSource?.(descriptor);
    }
  }

  async yank(versionId: string | number, reason: string): Promise<void> {
    const versions = this.database.getRepository('skillRegistryVersions');
    const version = await versions.findOne({ filterByTk: versionId });
    if (!version) {
      throw new RegistryError('VERSION_NOT_FOUND', 404, 'Skill registry version was not found.');
    }
    if (getString(version, 'status') === 'yanked') {
      return;
    }
    if (getString(version, 'status') !== 'published') {
      throw new RegistryError('VERSION_NOT_PUBLISHED', 409, 'Only published versions can be yanked.');
    }
    const packageId = getString(version, 'packageId');
    await runRegistryOperation(this.lockManager, packageOperationLockKey(packageId), publishLockTtlMs(), () =>
      withTransaction(this.database, async (transaction) => {
        const lockedVersion = await versions.findOne({ filterByTk: versionId, transaction, lock: true });
        if (!lockedVersion) {
          throw new RegistryError('VERSION_NOT_FOUND', 404, 'Skill registry version was not found.');
        }
        if (getString(lockedVersion, 'status') === 'yanked') {
          return;
        }
        if (getString(lockedVersion, 'status') !== 'published') {
          throw new RegistryError('VERSION_NOT_PUBLISHED', 409, 'Only published versions can be yanked.');
        }
        await versions.update({
          filterByTk: versionId,
          transaction,
          values: {
            status: 'yanked',
            yankedAt: new Date(),
            yankReason: reason.trim() || 'Withdrawn by administrator.',
          },
        });
        const packages = this.database.getRepository('skillRegistryPackages');
        const packageRecord = await packages.findOne({ filterByTk: packageId, transaction, lock: true });
        if (!packageRecord) {
          return;
        }
        const remainingPublished = await versions.findOne({
          filter: { packageId, status: 'published' },
          sort: ['-publishedAt', '-id'],
          transaction,
        });
        const values: Record<string, unknown> = remainingPublished ? {} : { status: 'draft' };
        if (
          getString(lockedVersion, 'channel') === 'stable' &&
          getString(packageRecord, 'latestStableVersionId') === modelId(lockedVersion)
        ) {
          const replacement = await versions.findOne({
            filter: { packageId, channel: 'stable', status: 'published' },
            sort: ['-publishedAt', '-id'],
            transaction,
          });
          values.latestStableVersionId = replacement ? modelId(replacement) : null;
        }
        if (Object.keys(values).length > 0) {
          await packages.update({ filterByTk: packageId, transaction, values });
        }
      }),
    );
  }

  async unpublishSourceItem(
    sourceItemId: string | number,
    reason: string,
  ): Promise<{ sourceItemId: string; state: 'ready' | 'published'; yanked: number }> {
    const sourceItems = this.database.getRepository('skillRegistrySourceItems');
    const sourceItem = await sourceItems.findOne({ filterByTk: sourceItemId });
    if (!sourceItem) {
      throw new RegistryError('SOURCE_ITEM_NOT_FOUND', 404, 'Skill registry source item was not found.');
    }
    const sourceId = getString(sourceItem, 'sourceId');
    const attempted = await tryRunRegistryOperation(
      this.lockManager,
      sourceOperationLockKey(sourceId),
      publishLockTtlMs(),
      () => this.unpublishWithSourceLock(sourceItemId, sourceId, reason),
    );
    if (!attempted.acquired) {
      throw new RegistryError(
        'REGISTRY_OPERATION_BUSY',
        409,
        'The source is currently being synchronized, published, or unpublished. Retry the request.',
      );
    }
    return attempted.value;
  }

  private async unpublishWithSourceLock(
    sourceItemId: string | number,
    expectedSourceId: string,
    reason: string,
  ): Promise<{ sourceItemId: string; state: 'ready' | 'published'; yanked: number }> {
    const sourceItems = this.database.getRepository('skillRegistrySourceItems');
    const sourceItem = await sourceItems.findOne({ filterByTk: sourceItemId });
    if (!sourceItem) {
      throw new RegistryError('SOURCE_ITEM_NOT_FOUND', 404, 'Skill registry source item was not found.');
    }
    if (getString(sourceItem, 'sourceId') !== expectedSourceId) {
      throw new RegistryError('SOURCE_REVISION_CHANGED', 409, 'Source item changed while unpublish was waiting.');
    }
    if (getString(sourceItem, 'state') !== 'published') {
      throw new RegistryError('SOURCE_ITEM_NOT_PUBLISHED', 409, 'Only published candidates can be unpublished.');
    }
    const versions = this.database.getRepository('skillRegistryVersions');
    const publishedVersions = await versions.find({
      filter: { sourceItemId: modelId(sourceItem), status: 'published' },
      sort: ['-publishedAt', '-id'],
    });
    for (const version of publishedVersions) {
      await this.yank(modelId(version), reason);
    }
    const remaining = await versions.findOne({
      filter: { sourceItemId: modelId(sourceItem), status: 'published' },
    });
    if (!remaining) {
      await sourceItems.update({ filterByTk: modelId(sourceItem), values: { state: 'ready' } });
    }
    return {
      sourceItemId: modelId(sourceItem),
      state: remaining ? 'published' : 'ready',
      yanked: publishedVersions.length,
    };
  }
}
