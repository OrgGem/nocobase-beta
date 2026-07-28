import { randomUUID } from 'crypto';

import type { Context } from '@nocobase/actions';

import { RegistryError, toRegistryError } from './contracts/errors';
import { isRecord } from './contracts/types';
import { canonicalJson, sha256 } from './services/canonical-json';
import { CatalogService } from './services/catalog-service';
import { AgentInstallationBridge } from './services/agent-installation-bridge';
import { FilesystemArtifactStore } from './services/filesystem-artifact-store';
import { getString, type RegistryModel } from './services/model-values';
import {
  packageIdentityLockKey,
  runRegistryOperation,
  sourceOperationLockKey,
  tryRunRegistryOperation,
  type RegistryOperationLockManager,
} from './services/operation-lock';
import { PublishService } from './services/publish-service';
import { decodePublicCursor, encodePublicCursor, type PublicCursorScope } from './services/public-cursor';
import type { RegistryDatabase } from './services/repository-types';
import { incrementDownloadCount, withTransaction } from './services/repository-types';
import { PublicRateLimiter } from './services/public-rate-limiter';
import { RegistryReadinessService } from './services/registry-readiness-service';
import { SignatureService } from './services/signature-service';
import { SourceSyncService } from './services/source-sync-service';
import {
  assertChannel,
  assertSemver,
  containsControlCharacters,
  isValidChannel,
  isValidPublicPackageName,
  isValidSemver,
  normalizeIdentity,
  PUBLIC_INPUT_LIMITS,
} from './services/validation';

type ActionContext = Context & {
  method?: string;
  res?: {
    once(event: string, listener: (...args: unknown[]) => void): unknown;
    setTimeout?(milliseconds: number, callback: () => void): unknown;
    destroy?(error?: Error): unknown;
  };
  set(name: string, value: string): void;
  state: Record<string, unknown>;
  status: number;
  withoutDataWrapping?: boolean;
};

const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;
const ARTIFACT_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

function params(ctx: Context): Record<string, unknown> {
  const value = ctx.action.params as unknown;
  return isRecord(value) ? value : {};
}

function values(ctx: Context): Record<string, unknown> {
  const value = params(ctx).values;
  return isRecord(value) ? value : params(ctx);
}

function stringParam(ctx: Context, name: string): string | undefined {
  const value = values(ctx)[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function boundedStringParam(ctx: Context, name: string, maximum: number): string | undefined {
  const value = stringParam(ctx, name);
  if (value && (value.length > maximum || containsControlCharacters(value))) {
    throw new RegistryError('INVALID_REQUEST', 400, `${name} must be at most ${maximum} characters.`);
  }
  return value;
}

function publicStringParam(ctx: Context, name: string, maximum: number): string | undefined {
  const value = values(ctx)[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new RegistryError('INVALID_REQUEST', 400, `${name} must be a string.`);
  }
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length > maximum || containsControlCharacters(normalized)) {
    throw new RegistryError('INVALID_REQUEST', 400, `${name} must be at most ${maximum} characters.`);
  }
  return normalized;
}

function publicPackageParam(ctx: Context): string {
  const rawValue = values(ctx).package;
  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    throw new RegistryError('INVALID_REQUEST', 400, 'package is required.');
  }
  const value = rawValue.trim();
  if (containsControlCharacters(value) || !isValidPublicPackageName(value)) {
    // Keep malformed and private package identities indistinguishable from a missing
    // published package, matching CatalogService's public 404 contract.
    throw new RegistryError('PACKAGE_NOT_FOUND', 404, 'Package was not found.');
  }
  return value;
}

function publicVersionParam(ctx: Context): string | undefined {
  const rawValue = values(ctx).version;
  if (rawValue === undefined || rawValue === '') {
    return undefined;
  }
  if (typeof rawValue !== 'string') {
    throw new RegistryError('INVALID_REQUEST', 400, 'version must be a string.');
  }
  const value = rawValue.trim();
  if (!value) {
    return undefined;
  }
  if (containsControlCharacters(value) || !isValidSemver(value)) {
    throw new RegistryError('VERSION_NOT_FOUND', 404, 'Published package version was not found.');
  }
  return value;
}

function publicRuntimeParam(ctx: Context): 'python' | 'node' | undefined {
  const value = publicStringParam(ctx, 'runtime', 20);
  if (value === undefined) {
    return undefined;
  }
  if (value !== 'python' && value !== 'node') {
    throw new RegistryError('INVALID_REQUEST', 400, 'runtime must be python or node.');
  }
  return value;
}

function publicChannelParam(ctx: Context): string {
  const channel = publicStringParam(ctx, 'channel', PUBLIC_INPUT_LIMITS.channel) || 'stable';
  if (!isValidChannel(channel)) {
    throw new RegistryError('INVALID_REQUEST', 400, 'channel must use lowercase letters, digits and hyphens.');
  }
  return channel;
}

function cursorParam(ctx: Context): string | undefined {
  const value = values(ctx).cursor;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !value.trim()) {
    throw new RegistryError('INVALID_CURSOR', 400, 'Invalid cursor.');
  }
  return value.trim();
}

function pageLimit(ctx: Context): number {
  const value = values(ctx).limit;
  if (value === undefined) {
    return DEFAULT_PAGE_LIMIT;
  }
  const normalized = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : value;
  if (typeof normalized !== 'string' || !/^[1-9]\d*$/.test(normalized)) {
    throw new RegistryError('INVALID_LIMIT', 400, `limit must be an integer between 1 and ${MAX_PAGE_LIMIT}.`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_PAGE_LIMIT) {
    throw new RegistryError('INVALID_LIMIT', 400, `limit must be an integer between 1 and ${MAX_PAGE_LIMIT}.`);
  }
  return parsed;
}

function currentUserId(ctx: Context): string | undefined {
  const user = (ctx.auth as unknown as { user?: { id?: string | number } }).user;
  return user?.id === undefined ? undefined : String(user.id);
}

function modelId(model: RegistryModel): string {
  return getString(model, 'id');
}

function versionResponse(version: RegistryModel) {
  return {
    version: getString(version, 'version'),
    channel: getString(version, 'channel'),
    runtime: getString(version, 'runtime'),
    entrypoint: getString(version, 'entrypoint'),
    manifest: version.get('manifest'),
    artifactDigest: getString(version, 'artifactDigest'),
    registrySignature: getString(version, 'registrySignature') || null,
    signatureKeyId: getString(version, 'signatureKeyId') || null,
    changelog: getString(version, 'changelog') || null,
    publishedAt: version.get('publishedAt'),
  };
}

function versionSummaryResponse(version: RegistryModel) {
  return {
    version: getString(version, 'version'),
    channel: getString(version, 'channel'),
    runtime: getString(version, 'runtime'),
    entrypoint: getString(version, 'entrypoint'),
    manifestDigest: getString(version, 'manifestDigest'),
    artifactDigest: getString(version, 'artifactDigest'),
    registrySignature: getString(version, 'registrySignature') || null,
    signatureKeyId: getString(version, 'signatureKeyId') || null,
    publishedAt: version.get('publishedAt'),
  };
}

function etag(value: unknown): string {
  return `"${sha256(canonicalJson(value)).slice('sha256:'.length)}"`;
}

function matchesIfNoneMatch(value: string, entityTag: string): boolean {
  return value
    .split(',')
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === '*' || candidate === entityTag || candidate === `W/${entityTag}`);
}

function artifactSize(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function adminOperationLockTtlMs(): number {
  const value = process.env.SKILL_REGISTRY_SYNC_LOCK_TTL_MS?.trim();
  if (!value || !/^[1-9]\d*$/.test(value)) {
    return 10 * 60 * 1000;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= 60 * 60 * 1000 ? parsed : 10 * 60 * 1000;
}

async function quarantineArtifact(database: RegistryDatabase, artifact: RegistryModel, ctx: Context): Promise<void> {
  try {
    await database.getRepository('skillRegistryArtifacts').update({
      filterByTk: modelId(artifact),
      values: { verificationStatus: 'corrupt' },
    });
  } catch (error) {
    ctx.logger?.warn('[skill-registry] failed to quarantine an invalid artifact', error);
  }
}

async function runAction(ctx: Context, next: () => Promise<void>, handler: () => Promise<void>): Promise<void> {
  try {
    await handler();
    await next();
  } catch (error) {
    throw toRegistryError(error);
  }
}

export function createPublicActions(input: {
  database: RegistryDatabase;
  catalog: CatalogService;
  artifactStore: FilesystemArtifactStore;
  rateLimiter: () => PublicRateLimiter | undefined;
  signatureService: SignatureService;
}) {
  return {
    list: async (ctx: Context, next: () => Promise<void>) =>
      runAction(ctx, next, async () => {
        const limit = pageLimit(ctx);
        const q = publicStringParam(ctx, 'q', PUBLIC_INPUT_LIMITS.q);
        const tag = publicStringParam(ctx, 'tag', PUBLIC_INPUT_LIMITS.tag);
        const runtime = publicRuntimeParam(ctx);
        const channel = publicChannelParam(ctx);
        const cursorScope: PublicCursorScope = {
          endpoint: 'catalog',
          query: { q: q || null, tag: tag || null, runtime: runtime || null, channel },
        };
        const after = decodePublicCursor(cursorParam(ctx), cursorScope);
        const result = await input.catalog.list({
          q,
          tag,
          runtime,
          channel,
          limit,
          after,
        });
        const response = {
          data: result.rows,
          meta: { nextCursor: result.nextAnchor ? encodePublicCursor(cursorScope, result.nextAnchor) : null },
        };
        const actionContext = ctx as ActionContext;
        const entityTag = etag(response);
        actionContext.set('ETag', entityTag);
        actionContext.set('Cache-Control', 'public, max-age=60');
        if (matchesIfNoneMatch(ctx.get('if-none-match'), entityTag)) {
          actionContext.status = 304;
          actionContext.body = null;
          return;
        }
        actionContext.body = {
          rows: result.rows,
          nextCursor: response.meta.nextCursor,
        };
      }),
    get: async (ctx: Context, next: () => Promise<void>) =>
      runAction(ctx, next, async () => {
        const packageName = publicPackageParam(ctx);
        const channel = publicChannelParam(ctx);
        const packageRecord = await input.catalog.getPackage(packageName);
        const latest = await input.catalog.findLatestVersion(modelId(packageRecord), channel);
        const response = {
          name: `${getString(packageRecord, 'namespace')}/${getString(packageRecord, 'slug')}`,
          displayName: getString(packageRecord, 'displayName'),
          description: getString(packageRecord, 'description'),
          license: getString(packageRecord, 'license') || null,
          tags: packageRecord.get('tags'),
          // Public metadata stays small and predictable. The complete manifest
          // remains inside the downloaded, digest-verified ZIP artifact.
          latest: latest ? versionSummaryResponse(latest) : null,
        };
        const actionContext = ctx as ActionContext;
        const entityTag = etag(response);
        actionContext.set('ETag', entityTag);
        actionContext.set('Cache-Control', 'public, max-age=60');
        if (matchesIfNoneMatch(ctx.get('if-none-match'), entityTag)) {
          actionContext.status = 304;
          actionContext.body = null;
          return;
        }
        actionContext.body = response;
      }),
    versions: async (ctx: Context, next: () => Promise<void>) =>
      runAction(ctx, next, async () => {
        const packageName = publicPackageParam(ctx);
        const limit = pageLimit(ctx);
        const channel = publicChannelParam(ctx);
        const cursorScope: PublicCursorScope = {
          endpoint: 'versions',
          query: { package: packageName, channel },
        };
        const after = decodePublicCursor(cursorParam(ctx), cursorScope);
        const packageRecord = await input.catalog.getPackage(packageName);
        const versions = await input.catalog.listVersions(packageRecord, channel, limit, after);
        const response = {
          // Version history is deliberately a bounded summary. Returning up to
          // 100 full 10 MiB manifests would let one anonymous request allocate
          // roughly 1 GiB. Full manifests remain inside downloadable artifacts.
          data: versions.rows.map(versionSummaryResponse),
          meta: { nextCursor: versions.nextAnchor ? encodePublicCursor(cursorScope, versions.nextAnchor) : null },
        };
        const actionContext = ctx as ActionContext;
        const entityTag = etag(response);
        actionContext.set('ETag', entityTag);
        actionContext.set('Cache-Control', 'public, max-age=60');
        if (matchesIfNoneMatch(ctx.get('if-none-match'), entityTag)) {
          actionContext.status = 304;
          actionContext.body = null;
          return;
        }
        actionContext.body = {
          rows: response.data,
          nextCursor: response.meta.nextCursor,
        };
      }),
    download: async (ctx: Context, next: () => Promise<void>) =>
      runAction(ctx, next, async () => {
        const packageName = publicPackageParam(ctx);
        const version = publicVersionParam(ctx);
        const channel = publicChannelParam(ctx);
        const { packageRecord, versionRecord } = await input.catalog.resolveVersion(packageName, version, channel);
        const artifactId = getString(versionRecord, 'artifactId');
        const artifact = artifactId
          ? await input.database.getRepository('skillRegistryArtifacts').findOne({ filterByTk: artifactId })
          : null;
        if (!artifact || getString(artifact, 'verificationStatus') !== 'verified') {
          throw new RegistryError('ARTIFACT_UNAVAILABLE', 404, 'Artifact is unavailable.');
        }
        const digest = getString(versionRecord, 'artifactDigest');
        const artifactRecordDigest = getString(artifact, 'digest');
        const manifestDigest = getString(versionRecord, 'manifestDigest');
        const artifactManifestDigest = getString(artifact, 'manifestDigest');
        const storageKey = getString(artifact, 'storageKey');
        const expectedSizeBytes = artifactSize(artifact.get('sizeBytes'));
        const digestBoundStorageKey =
          ARTIFACT_DIGEST_PATTERN.test(digest) && input.artifactStore.isKeyForDigest(storageKey, digest);
        if (
          !ARTIFACT_DIGEST_PATTERN.test(digest) ||
          artifactRecordDigest !== digest ||
          !manifestDigest ||
          artifactManifestDigest !== manifestDigest ||
          getString(artifact, 'storageDriver') !== 'filesystem' ||
          getString(artifact, 'format') !== 'zip' ||
          getString(artifact, 'contentType') !== 'application/zip' ||
          expectedSizeBytes === undefined ||
          !digestBoundStorageKey
        ) {
          if (artifact) {
            await quarantineArtifact(input.database, artifact, ctx);
          }
          throw new RegistryError('ARTIFACT_UNAVAILABLE', 404, 'Artifact is unavailable.');
        }
        const rawDigest = digest.slice('sha256:'.length);
        const actionContext = ctx as ActionContext;
        const entityTag = `"sha256-${rawDigest}"`;
        actionContext.set('ETag', entityTag);
        actionContext.set('Digest', `sha-256=${Buffer.from(rawDigest, 'hex').toString('base64')}`);
        actionContext.set('X-Skill-Version', getString(versionRecord, 'version'));
        actionContext.set('X-Artifact-Sha256', rawDigest);
        actionContext.set('Content-Type', 'application/zip');
        // A yanked version must stop being downloadable immediately. Long-lived
        // immutable CDN caching would keep serving an already-yanked artifact.
        actionContext.set('Cache-Control', 'public, max-age=0, must-revalidate');
        const filename = `${packageName.replace('/', '-')}-${getString(versionRecord, 'version')}.zip`;
        actionContext.set('Content-Disposition', `attachment; filename="${filename}"`);
        if (matchesIfNoneMatch(ctx.get('if-none-match'), entityTag)) {
          actionContext.status = 304;
          actionContext.body = null;
          return;
        }
        const clientIp =
          typeof actionContext.state.skillRegistryClientIp === 'string'
            ? actionContext.state.skillRegistryClientIp
            : 'unknown';
        const rateLimiter = input.rateLimiter();
        let lease:
          | {
              responseTimeoutMs: number;
              release(): Promise<void>;
            }
          | undefined;
        if (rateLimiter && typeof rateLimiter.acquireDownloadLease === 'function') {
          lease = await rateLimiter.acquireDownloadLease(clientIp);
        }
        let artifactStream: Awaited<ReturnType<FilesystemArtifactStore['openVerified']>>['stream'];
        try {
          const verifiedArtifact = await input.artifactStore.openVerified(storageKey, digest, expectedSizeBytes);
          artifactStream = verifiedArtifact.stream;
          actionContext.set('Content-Length', String(verifiedArtifact.sizeBytes));
          actionContext.withoutDataWrapping = true;
          actionContext.body = artifactStream;
        } catch (error) {
          if (lease) {
            await lease.release().catch(() => undefined);
          }
          if (error instanceof RegistryError && error.code === 'ARTIFACT_DIGEST_MISMATCH') {
            await quarantineArtifact(input.database, artifact, ctx);
            throw new RegistryError('ARTIFACT_UNAVAILABLE', 404, 'Artifact is unavailable.');
          }
          throw new RegistryError('ARTIFACT_STORAGE_UNAVAILABLE', 503, 'Artifact storage is temporarily unavailable.');
        }
        const response = actionContext.res;
        if (!response) {
          artifactStream.destroy();
          await lease?.release().catch(() => undefined);
          return;
        }
        let settled = false;
        let absoluteTimeout: ReturnType<typeof setTimeout> | undefined;
        const clearAbsoluteTimeout = () => {
          if (absoluteTimeout) {
            clearTimeout(absoluteTimeout);
            absoluteTimeout = undefined;
          }
        };
        const releaseLease = () => {
          if (settled) {
            return;
          }
          settled = true;
          clearAbsoluteTimeout();
          lease?.release().catch((error) => {
            ctx.logger?.warn('[skill-registry] download lease release failed', error);
          });
        };
        const abortDownload = (error?: unknown) => {
          if (!artifactStream.destroyed) {
            artifactStream.destroy(error instanceof Error ? error : undefined);
          }
          releaseLease();
        };
        const recordCompletedDownload = async () => {
          await input.database.getRepository('skillRegistryDownloads').create({
            values: {
              packageId: modelId(packageRecord),
              versionId: modelId(versionRecord),
              requestId: randomUUID(),
              clientIpHash: rateLimiter ? rateLimiter.hashIp(clientIp) : 'unavailable',
              userAgentHash: rateLimiter ? rateLimiter.hashIp(ctx.get('user-agent') || '') : null,
              outcome: 'streamed',
              bytesServed: expectedSizeBytes,
            },
          });
          await incrementDownloadCount(input.database, modelId(packageRecord));
        };
        response.once('finish', () => {
          releaseLease();
          // Only a fully flushed GET is a completed download. Audit failures happen after the
          // response lifecycle and therefore cannot replace an already-served artifact with 500.
          recordCompletedDownload().catch((error) => {
            ctx.logger?.warn('[skill-registry] download audit failed', error);
          });
        });
        response.once('close', abortDownload);
        response.once('error', abortDownload);
        artifactStream.once('error', (error) => {
          releaseLease();
          response.destroy?.(error);
        });
        // `ServerResponse.setTimeout()` is an inactivity timeout and can be
        // reset by a slow client. Keep an absolute wall-clock deadline so an
        // anonymous stream cannot hold a lease forever.
        const responseTimeoutMs = lease?.responseTimeoutMs || 5 * 60 * 1000;
        absoluteTimeout = setTimeout(() => {
          abortDownload(new RegistryError('DOWNLOAD_TIMEOUT', 504, 'Artifact download exceeded its timeout.'));
          response.destroy?.();
        }, responseTimeoutMs);
      }),
    metadata: async (ctx: Context, next: () => Promise<void>) =>
      runAction(ctx, next, async () => {
        const actionContext = ctx as ActionContext;
        const signingKeys = input.signatureService.publicKeyRing();
        const signingKeyId = input.signatureService.keyId === 'unconfigured' ? null : input.signatureService.keyId;
        actionContext.set('Cache-Control', 'public, max-age=300');
        actionContext.body = {
          contractVersion: 'registry.skill.nocobase.io/v1',
          artifactFormat: 'zip',
          supportedRuntimes: ['python', 'node'],
          signingKeyId,
          signingPublicKey: signingKeyId ? signingKeys[signingKeyId] || null : null,
          signingKeys,
        };
      }),
  };
}

export function createAdminActions(input: {
  sync: SourceSyncService;
  publish: PublishService;
  database: RegistryDatabase;
  installationBridge: AgentInstallationBridge;
  lockManager?: RegistryOperationLockManager;
}) {
  return {
    discover: async (ctx: Context, next: () => Promise<void>) =>
      runAction(ctx, next, async () => {
        const sourceId = boundedStringParam(ctx, 'sourceId', 128);
        if (!sourceId) {
          throw new RegistryError('INVALID_REQUEST', 400, 'sourceId is required.');
        }
        (ctx as ActionContext).body = await input.sync.discover(sourceId);
      }),
    sync: async (ctx: Context, next: () => Promise<void>) =>
      runAction(ctx, next, async () => {
        const sourceId = boundedStringParam(ctx, 'sourceId', 128);
        if (!sourceId) {
          throw new RegistryError('INVALID_REQUEST', 400, 'sourceId is required.');
        }
        const run = await input.sync.sync(sourceId, 'manual', currentUserId(ctx));
        (ctx as ActionContext).body = { runId: modelId(run), status: getString(run, 'status') };
      }),
    retry: async (ctx: Context, next: () => Promise<void>) =>
      runAction(ctx, next, async () => {
        const syncRunId = boundedStringParam(ctx, 'syncRunId', 128);
        if (!syncRunId) {
          throw new RegistryError('INVALID_REQUEST', 400, 'syncRunId is required.');
        }
        const previous = await input.database.getRepository('skillRegistrySyncRuns').findOne({ filterByTk: syncRunId });
        if (!previous) {
          throw new RegistryError('SYNC_RUN_NOT_FOUND', 404, 'Sync run was not found.');
        }
        const run = await input.sync.sync(getString(previous, 'sourceId'), 'retry', currentUserId(ctx));
        (ctx as ActionContext).body = { runId: modelId(run), status: getString(run, 'status') };
      }),
    resolve: async (ctx: Context, next: () => Promise<void>) =>
      runAction(ctx, next, async () => {
        const sourceItemId = boundedStringParam(ctx, 'sourceItemId', 128);
        const namespace = boundedStringParam(ctx, 'namespace', 80);
        const slug = boundedStringParam(ctx, 'slug', 120);
        if (!sourceItemId || !namespace || !slug) {
          throw new RegistryError('INVALID_REQUEST', 400, 'sourceItemId, namespace, and slug are required.');
        }
        const sourceItems = input.database.getRepository('skillRegistrySourceItems');
        const sourceItem = await sourceItems.findOne({ filterByTk: sourceItemId });
        if (!sourceItem) {
          throw new RegistryError('SOURCE_ITEM_NOT_FOUND', 404, 'Skill registry source item was not found.');
        }
        const identity = {
          namespace: normalizeIdentity(namespace, 'namespace'),
          slug: normalizeIdentity(slug, 'slug'),
        };
        const sourceId = getString(sourceItem, 'sourceId');
        if (!sourceId) {
          throw new RegistryError('SOURCE_REVISION_CHANGED', 409, 'Source item no longer has a valid source.');
        }
        const sourceAttempt = await tryRunRegistryOperation(
          input.lockManager,
          sourceOperationLockKey(sourceId),
          adminOperationLockTtlMs(),
          () =>
            runRegistryOperation(
              input.lockManager,
              packageIdentityLockKey(identity.namespace, identity.slug),
              adminOperationLockTtlMs(),
              async () => {
                const activeSync = await input.database
                  .getRepository('skillRegistrySyncRuns')
                  .findOne({ filter: { activeKey: sourceId } });
                if (activeSync) {
                  throw new RegistryError(
                    'REGISTRY_OPERATION_BUSY',
                    409,
                    'The source is currently being synchronized. Retry the request after sync completes.',
                  );
                }
                return withTransaction(input.database, async (transaction) => {
                  const lockedSourceItem = await sourceItems.findOne({
                    filterByTk: sourceItemId,
                    transaction,
                    lock: true,
                  });
                  if (!lockedSourceItem || getString(lockedSourceItem, 'sourceId') !== sourceId) {
                    throw new RegistryError(
                      'SOURCE_REVISION_CHANGED',
                      409,
                      'Source item changed while its identity was being resolved.',
                    );
                  }
                  const packages = input.database.getRepository('skillRegistryPackages');
                  let packageRecord = await packages.findOne({ filter: identity, transaction, lock: true });
                  if (!packageRecord) {
                    packageRecord = await packages.create({
                      transaction,
                      values: {
                        ...identity,
                        displayName: getString(lockedSourceItem, 'displayName'),
                        description: '',
                        tags: [],
                        visibility: 'public',
                        status: 'draft',
                        defaultChannel: 'stable',
                        createdById: currentUserId(ctx) || null,
                        updatedById: currentUserId(ctx) || null,
                      },
                    });
                  }
                  const packageId = modelId(packageRecord);
                  const existingOwner = await sourceItems.findOne({
                    filter: { packageId, id: { $ne: modelId(lockedSourceItem) } },
                    transaction,
                    lock: true,
                  });
                  if (existingOwner) {
                    throw new RegistryError(
                      'PACKAGE_IDENTITY_COLLISION',
                      409,
                      'The target package identity is already owned by another source item.',
                    );
                  }
                  await sourceItems.update({
                    filterByTk: modelId(lockedSourceItem),
                    transaction,
                    values: {
                      packageId,
                      state: 'ready',
                      conflictCode: null,
                      conflictDetail: null,
                    },
                  });
                  return { sourceItemId: modelId(lockedSourceItem), packageId, state: 'ready' as const };
                });
              },
            ),
        );
        if (!sourceAttempt.acquired) {
          throw new RegistryError(
            'REGISTRY_OPERATION_BUSY',
            409,
            'The source is currently being synchronized or published. Retry the request.',
          );
        }
        (ctx as ActionContext).body = {
          sourceItemId: sourceAttempt.value.sourceItemId,
          packageId: sourceAttempt.value.packageId,
          state: sourceAttempt.value.state,
        };
      }),
    publish: async (ctx: Context, next: () => Promise<void>) =>
      runAction(ctx, next, async () => {
        const sourceItemId = boundedStringParam(ctx, 'sourceItemId', 128);
        const rawVersion = boundedStringParam(ctx, 'version', PUBLIC_INPUT_LIMITS.version);
        if (!sourceItemId || !rawVersion) {
          throw new RegistryError('INVALID_REQUEST', 400, 'sourceItemId and version are required.');
        }
        const version = assertSemver(rawVersion);
        const rawChannel = boundedStringParam(ctx, 'channel', PUBLIC_INPUT_LIMITS.channel);
        const created = await input.publish.publish({
          sourceItemId,
          version,
          channel: rawChannel ? assertChannel(rawChannel) : undefined,
          changelog: boundedStringParam(ctx, 'changelog', 20_000),
          publishedById: currentUserId(ctx),
        });
        (ctx as ActionContext).body = versionResponse(created);
      }),
    yank: async (ctx: Context, next: () => Promise<void>) =>
      runAction(ctx, next, async () => {
        const versionId = boundedStringParam(ctx, 'versionId', 128);
        if (!versionId) {
          throw new RegistryError('INVALID_REQUEST', 400, 'versionId is required.');
        }
        await input.publish.yank(versionId, boundedStringParam(ctx, 'reason', 2_000) || 'Withdrawn by administrator.');
        (ctx as ActionContext).body = { status: 'yanked' };
      }),
    verify: async (ctx: Context, next: () => Promise<void>) =>
      runAction(ctx, next, async () => {
        const versionId = boundedStringParam(ctx, 'versionId', 128);
        if (!versionId) {
          throw new RegistryError('INVALID_REQUEST', 400, 'versionId is required.');
        }
        (ctx as ActionContext).body = await input.installationBridge.verify(versionId);
      }),
    install: async (ctx: Context, next: () => Promise<void>) =>
      runAction(ctx, next, async () => {
        const versionId = boundedStringParam(ctx, 'versionId', 128);
        if (!versionId) {
          throw new RegistryError('INVALID_REQUEST', 400, 'versionId is required.');
        }
        const updatePolicy = boundedStringParam(ctx, 'updatePolicy', 20) === 'channel' ? 'channel' : 'pinned';
        const installation = await input.installationBridge.install(versionId, updatePolicy, currentUserId(ctx));
        (ctx as ActionContext).body = installation;
      }),
    rollback: async (ctx: Context, next: () => Promise<void>) =>
      runAction(ctx, next, async () => {
        const installationId = boundedStringParam(ctx, 'installationId', 128);
        if (!installationId) {
          throw new RegistryError('INVALID_REQUEST', 400, 'installationId is required.');
        }
        const installation = await input.installationBridge.rollback(installationId, currentUserId(ctx));
        (ctx as ActionContext).body = installation;
      }),
  };
}

export function createHealthActions(readiness: RegistryReadinessService) {
  return {
    readiness: async (ctx: Context, next: () => Promise<void>) => {
      const report = await readiness.check();
      const actionContext = ctx as ActionContext;
      actionContext.status = report.ready ? 200 : 503;
      actionContext.body = report;
      await next();
    },
  };
}
