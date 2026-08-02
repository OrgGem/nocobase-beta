import type { Context, Next } from '@nocobase/actions';
import { MANIFEST_ACCEPT } from '../../shared/media-types';
import type { RegistrySettingsInput } from '../../shared/types';
import { RegistryClient, RegistryRequestError } from '../services/registry-client';
import {
  archiveFormat,
  contentDispositionFilename,
  createImageArchiveStream,
  uploadImageArchive,
} from '../services/image-archive';
import {
  getPublicSettings,
  getRegistryConnection,
  getSafeSettings,
  RegistryConfigurationError,
  updateRegistrySettings,
} from '../services/settings';

const PLUGIN_NAMESPACE = 'plugin-docker-registry-ui';
const ARCHIVE_ERROR_MESSAGES: Record<string, string> = {
  ARCHIVE_REPOSITORY_AMBIGUOUS: 'Archive contains multiple repository references. Choose one manually.',
  ARCHIVE_TAG_AMBIGUOUS: 'Archive contains multiple tag references. Choose one manually.',
  ARCHIVE_REPOSITORY_REQUIRED: 'Archive does not contain a destination repository. Enter one manually.',
  ARCHIVE_TAG_REQUIRED: 'Archive does not contain a destination tag. Enter one manually.',
  DOCKER_ARCHIVE_MULTIPLE_IMAGES: 'Docker archive contains multiple images. Upload one image archive at a time.',
  OCI_ARCHIVE_MULTIPLE_IMAGES: 'OCI archive contains multiple root images. Upload one image archive at a time.',
  INVALID_REPOSITORY: 'A valid repository name is required',
  INVALID_TAG: 'A valid tag is required',
};

function input(ctx: Context): Record<string, unknown> {
  const values = (ctx.action.params as { values?: unknown } | undefined)?.values;
  if (typeof values === 'object' && values !== null && !Array.isArray(values)) {
    const record = values as Record<string, unknown>;
    if (typeof record.values === 'object' && record.values !== null && !Array.isArray(record.values)) {
      return record.values as Record<string, unknown>;
    }
    return record;
  }
  if (typeof ctx.request.body === 'object' && ctx.request.body !== null && !Array.isArray(ctx.request.body)) {
    const body = ctx.request.body as Record<string, unknown>;
    if (typeof body.values === 'object' && body.values !== null && !Array.isArray(body.values)) {
      return body.values as Record<string, unknown>;
    }
    return body;
  }
  return {};
}

function stringInput(ctx: Context, key: string): string | undefined {
  const params = ctx.action.params as Record<string, unknown> | undefined;
  const value = input(ctx)[key] ?? params?.[key] ?? ctx.query[key];
  return typeof value === 'string' && value ? value : undefined;
}

function booleanInput(ctx: Context, key: string): boolean {
  const params = ctx.action.params as Record<string, unknown> | undefined;
  const value = input(ctx)[key] ?? params?.[key] ?? ctx.query[key];
  return value === true || value === 'true';
}

function sendRegistryError(ctx: Context, error: unknown): never {
  if (error instanceof RegistryConfigurationError) {
    ctx.throw(400, error.message, { code: 'INVALID_REGISTRY_CONFIGURATION' });
  }
  if (error instanceof RegistryRequestError) {
    const message = ARCHIVE_ERROR_MESSAGES[error.code] ?? error.message;
    ctx.throw(error.status && error.status >= 400 ? error.status : 502, ctx.t(message, { ns: PLUGIN_NAMESPACE }), {
      code: error.code,
    });
  }
  throw error;
}

async function client(ctx: Context, overrides?: RegistrySettingsInput): Promise<RegistryClient> {
  return new RegistryClient(await getRegistryConnection(ctx, overrides));
}

function repositoryInput(ctx: Context): string {
  const repository = stringInput(ctx, 'repository');
  if (!repository || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/i.test(repository)) {
    ctx.throw(400, 'A valid repository name is required');
  }
  return repository;
}

function referenceInput(ctx: Context, key: 'reference' | 'tag'): string {
  const reference = stringInput(ctx, key);
  if (!reference || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(reference)) {
    ctx.throw(400, `A valid ${key} is required`);
  }
  return reference;
}

function optionalRepositoryInput(ctx: Context): string | undefined {
  const repository = stringInput(ctx, 'repository');
  if (repository && !/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/i.test(repository)) {
    ctx.throw(400, ctx.t('A valid repository name is required', { ns: PLUGIN_NAMESPACE }));
  }
  return repository;
}

function optionalTagInput(ctx: Context): string | undefined {
  const tag = stringInput(ctx, 'tag');
  if (tag && !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) {
    ctx.throw(400, ctx.t('A valid tag is required', { ns: PLUGIN_NAMESPACE }));
  }
  return tag;
}

export async function getSettings(ctx: Context, next: Next) {
  ctx.body = await getSafeSettings(ctx);
  await next();
}

export async function getPublicConfiguration(ctx: Context, next: Next) {
  ctx.body = await getPublicSettings(ctx);
  await next();
}

export async function updateSettings(ctx: Context, next: Next) {
  try {
    ctx.body = await updateRegistrySettings(ctx);
  } catch (error) {
    sendRegistryError(ctx, error);
  }
  await next();
}

export async function testConnection(ctx: Context, next: Next) {
  try {
    const registry = await client(ctx);
    const health = await registry.health();
    ctx.body = {
      ...health,
      manifestAccept: MANIFEST_ACCEPT.split(', '),
    };
  } catch (error) {
    sendRegistryError(ctx, error);
  }
  await next();
}

export async function testConnectionDraft(ctx: Context, next: Next) {
  try {
    const registry = await client(ctx, input(ctx) as RegistrySettingsInput);
    const health = await registry.health();
    ctx.body = {
      ...health,
      manifestAccept: MANIFEST_ACCEPT.split(', '),
    };
  } catch (error) {
    sendRegistryError(ctx, error);
  }
  await next();
}

export async function listRepositories(ctx: Context, next: Next) {
  try {
    const registry = await client(ctx);
    ctx.body = await registry.listRepositories(stringInput(ctx, 'cursor'), stringInput(ctx, 'search'));
  } catch (error) {
    sendRegistryError(ctx, error);
  }
  await next();
}

export async function listTags(ctx: Context, next: Next) {
  const repository = stringInput(ctx, 'repository');
  if (!repository) ctx.throw(400, 'Repository is required');
  try {
    const registry = await client(ctx);
    const result = await registry.listTags(repository, stringInput(ctx, 'cursor'), stringInput(ctx, 'search'));
    ctx.body = {
      ...result,
      summaries: await registry.getTagSummaries(repository, result.items),
    };
  } catch (error) {
    sendRegistryError(ctx, error);
  }
  await next();
}

export async function getImageDetails(ctx: Context, next: Next) {
  const repository = stringInput(ctx, 'repository');
  const reference = stringInput(ctx, 'reference');
  if (!repository || !reference) ctx.throw(400, 'Repository and reference are required');
  try {
    const details = await (await client(ctx)).getImageDetails(repository, reference);
    const settings = await getSafeSettings(ctx);
    ctx.body = settings.rawManifestEnabled ? details : { ...details, raw: undefined };
  } catch (error) {
    sendRegistryError(ctx, error);
  }
  await next();
}

export async function getDeleteImpact(ctx: Context, next: Next) {
  const repository = stringInput(ctx, 'repository');
  const tag = stringInput(ctx, 'tag');
  if (!repository || !tag) ctx.throw(400, 'Repository and tag are required');
  const settings = await getSafeSettings(ctx);
  if (!settings.deleteEnabled) ctx.throw(403, 'Delete is disabled in Docker Registry settings');
  try {
    ctx.body = await (await client(ctx)).getDeleteImpact(repository, tag);
  } catch (error) {
    sendRegistryError(ctx, error);
  }
  await next();
}

export async function deleteTag(ctx: Context, next: Next) {
  const repository = stringInput(ctx, 'repository');
  const tag = stringInput(ctx, 'tag');
  if (!repository || !tag) ctx.throw(400, 'Repository and tag are required');
  const settings = await getSafeSettings(ctx);
  if (!settings.deleteEnabled) ctx.throw(403, 'Delete is disabled in Docker Registry settings');
  try {
    ctx.body = await (
      await client(ctx)
    ).deleteTag(repository, tag, stringInput(ctx, 'expectedDigest'), booleanInput(ctx, 'confirmSharedDigest'));
  } catch (error) {
    sendRegistryError(ctx, error);
  }
  await next();
}

export async function getRepositoryDeleteImpact(ctx: Context, next: Next) {
  const repository = repositoryInput(ctx);
  const settings = await getSafeSettings(ctx);
  if (!settings.deleteEnabled) ctx.throw(403, 'Delete is disabled in Docker Registry settings');
  try {
    ctx.body = await (await client(ctx)).getRepositoryDeleteImpact(repository);
  } catch (error) {
    sendRegistryError(ctx, error);
  }
  await next();
}

export async function deleteRepositoryContents(ctx: Context, next: Next) {
  const repository = repositoryInput(ctx);
  const settings = await getSafeSettings(ctx);
  if (!settings.deleteEnabled) ctx.throw(403, 'Delete is disabled in Docker Registry settings');
  try {
    ctx.body = await (
      await client(ctx)
    ).deleteRepositoryContents(
      repository,
      stringInput(ctx, 'expectedSignature'),
      booleanInput(ctx, 'confirmRepository'),
    );
  } catch (error) {
    sendRegistryError(ctx, error);
  }
  await next();
}

export async function downloadImage(ctx: Context, next: Next) {
  const repository = repositoryInput(ctx);
  const reference = referenceInput(ctx, 'reference');
  try {
    const format = archiveFormat(stringInput(ctx, 'format'));
    const settings = await getSafeSettings(ctx);
    const archive = await createImageArchiveStream({
      client: await client(ctx),
      repository,
      reference,
      format,
      publicRegistryHost: settings.publicRegistryHost,
      maxBytes: settings.maxTransferSizeMb * 1024 * 1024,
    });
    ctx.set('Content-Type', 'application/x-tar');
    ctx.set('Content-Disposition', `attachment; filename="${contentDispositionFilename(archive.filename)}"`);
    ctx.set('Cache-Control', 'private, no-store');
    ctx.set('X-Content-Type-Options', 'nosniff');
    ctx.withoutDataWrapping = true;
    ctx.body = archive.stream;
  } catch (error) {
    sendRegistryError(ctx, error);
  }
  await next();
}

export async function uploadImage(ctx: Context, next: Next) {
  const repository = optionalRepositoryInput(ctx);
  const tag = optionalTagInput(ctx);
  try {
    const format = archiveFormat(stringInput(ctx, 'format'));
    const settings = await getSafeSettings(ctx);
    const maxBytes = settings.maxTransferSizeMb * 1024 * 1024;
    const contentLength = Number(ctx.request.headers['content-length'] ?? 0);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      ctx.throw(413, 'Upload exceeds the configured transfer size limit', { code: 'TRANSFER_TOO_LARGE' });
    }
    ctx.body = await uploadImageArchive({
      input: ctx.req,
      client: await client(ctx),
      repository,
      tag,
      format,
      maxBytes,
      chunkSize: settings.uploadChunkSizeMb * 1024 * 1024,
      timeoutMs: settings.transferTimeoutMs,
    });
  } catch (error) {
    sendRegistryError(ctx, error);
  }
  await next();
}
