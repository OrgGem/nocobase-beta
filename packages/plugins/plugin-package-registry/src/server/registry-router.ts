import { createHash } from 'crypto';
import { createReadStream, statSync } from 'fs';
import { copyFile, mkdir, rename, unlink, writeFile } from 'fs/promises';
import path from 'path';

type AnyContext = any;
type AnyNext = () => Promise<void>;
type RegistryPlugin = {
  app: any;
  db: any;
};

const API_PREFIX = '/api/package-registry/npm';
const DEFAULT_REGISTRY_NAME = 'default';
const SAFE_PACKAGE_RE = /^(?:@[a-zA-Z0-9_.~-]+\/)?[a-zA-Z0-9_.~-]+$/;
const SAFE_TARBALL_RE = /^[a-zA-Z0-9_.+~-]+\.tgz$/;
const PROXY_CACHE_TTL_MS = 10 * 60 * 1000;
const PROXY_DOWNLOAD_TIMEOUT_MS = Number(process.env.PACKAGE_REGISTRY_PROXY_TIMEOUT_MS || 5 * 60 * 1000);
const cacheLocks = new Map<string, Promise<unknown>>();

type PublishValues = {
  registry?: string;
  registryName?: string;
  name?: string;
  packageName?: string;
  version?: string;
  description?: string;
  metadata?: Record<string, any>;
  tarballPath?: string;
  filePath?: string;
  tarballBase64?: string;
  contentBase64?: string;
  filename?: string;
};

export function createPackageRegistryActions(plugin: RegistryPlugin) {
  return {
    publish: async (ctx: AnyContext, next: AnyNext) => {
      const values = (ctx.action?.params?.values || ctx.request?.body || {}) as PublishValues;
      ctx.body = await publishPackage(plugin, values);
      await next();
    },
    metadata: async (ctx: AnyContext, next: AnyNext) => {
      const values = ctx.action?.params?.values || {};
      const packageName = normalizePackageName(values.name || values.packageName || ctx.action?.params?.filterByTk);
      ctx.body = await getNpmMetadata(plugin, packageName, values.registry || values.registryName);
      await next();
    },
    list: async (ctx: AnyContext, next: AnyNext) => {
      const repo = plugin.db.getRepository('packages');
      const packages = await repo.find({ sort: ['name'] });
      ctx.body = packages.map(toJSON);
      await next();
    },
  };
}

export function createPackageRegistryRouter(plugin: RegistryPlugin) {
  return async (ctx: AnyContext, next: AnyNext) => {
    if (!isRegistryPath(ctx.path)) {
      return next();
    }

    ctx.withoutDataWrapping = true;

    if (ctx.method === 'OPTIONS') {
      ctx.status = 204;
      return;
    }

    if (ctx.method !== 'GET') {
      ctx.status = 405;
      ctx.body = { error: 'Method not allowed' };
      return;
    }

    try {
      const subPath = ctx.path.slice(API_PREFIX.length);
      const tarballMarker = '/-/';

      if (subPath.includes(tarballMarker)) {
        const [rawPackageName, rawFilename] = subPath.split(tarballMarker);
        const route = parsePackageRoute(rawPackageName, ctx.query?.registry);
        await sendTarball(plugin, ctx, route.registryName, route.packageName, normalizeTarballName(rawFilename));
        return;
      }

      const route = parsePackageRoute(subPath, ctx.query?.registry);
      ctx.body = await getNpmMetadata(plugin, route.packageName, route.registryName);
    } catch (error) {
      const status = error?.status || 500;
      ctx.status = status;
      ctx.body = { error: error instanceof Error ? error.message : String(error) };
    }
  };
}

async function publishPackage(plugin: RegistryPlugin, values: PublishValues) {
  const packageName = normalizePackageName(values.packageName || values.name);
  const version = normalizeVersion(values.version);
  const registryName = normalizeRegistryName(values.registryName || values.registry || DEFAULT_REGISTRY_NAME);
  const filename = normalizeTarballName(values.filename || `${packageName.split('/').pop()}-${version}.tgz`);
  const metadata = values.metadata || {};

  const registry = await findOrCreateRegistry(plugin, registryName);
  const pkg = await findOrCreatePackage(plugin, registry, packageName, values.description || metadata.description || '');

  const storagePath = getTarballStoragePath(registryName, packageName, version, filename);
  await mkdir(path.dirname(storagePath), { recursive: true });

  const sourcePath = values.tarballPath || values.filePath;
  if (sourcePath) {
    const resolvedSourcePath = path.resolve(process.cwd(), sourcePath);
    assertTarballPath(resolvedSourcePath);
    await copyFile(resolvedSourcePath, storagePath);
  } else {
    const base64 = values.tarballBase64 || values.contentBase64;
    if (!base64) {
      throw badRequest('tarballPath, filePath, tarballBase64, or contentBase64 is required');
    }
    await writeFile(storagePath, Buffer.from(base64, 'base64'));
  }

  assertTarballPath(storagePath);
  const stat = statSync(storagePath);
  const checksums = await getChecksums(storagePath);
  const versionRecord = await findOrCreateVersion(plugin, pkg, version, metadata);
  const asset = await replaceVersionAsset(plugin, versionRecord, {
    filename,
    path: toStorageRelativePath(storagePath),
    size: stat.size,
    checksumSha1: checksums.sha1,
    checksumMd5: checksums.md5,
    checksumSha256: checksums.sha256,
  });

  return {
    package: toJSON(pkg),
    version: toJSON(versionRecord),
    asset: toJSON(asset),
    npm: await getNpmMetadata(plugin, packageName, registryName),
  };
}

async function getNpmMetadata(plugin: RegistryPlugin, packageName: string, registryName = DEFAULT_REGISTRY_NAME) {
  registryName = normalizeRegistryName(registryName);
  const registry = await findRegistry(plugin, registryName);
  if (!registry) {
    throw notFound(`Registry not found: ${registryName}`);
  }

  let pkg = await findPackage(plugin, packageName, registry);
  if (!pkg) {
    if (isProxyRegistry(registry)) {
      await cachePackageMetadataFromUpstream(plugin, registry, packageName);
      pkg = await findPackage(plugin, packageName, registry);
    }
    if (!pkg) {
      throw notFound(`Package not found: ${packageName}`);
    }
  }

  const versionRepo = plugin.db.getRepository('packageVersions');
  const assetRepo = plugin.db.getRepository('packageAssets');
  const packageId = getValue(pkg, 'id');
  let versions = await versionRepo.find({ filter: { packageId } });
  if (!versions.length && isProxyRegistry(registry)) {
    await cachePackageMetadataFromUpstream(plugin, registry, packageName, true);
    versions = await versionRepo.find({ filter: { packageId } });
  }
  const sortedVersions = versions.map(toJSON).sort((a, b) => compareVersions(b.version, a.version));
  const latest = sortedVersions[0]?.version;
  const npmVersions: Record<string, any> = {};

  for (const version of sortedVersions) {
    const asset = await assetRepo.findOne({ filter: { versionId: version.id } });
    const assetData = asset ? toJSON(asset) : {};
    const metadata = version.metadata || {};
    const filename = assetData.filename || `${packageName.split('/').pop()}-${version.version}.tgz`;
    npmVersions[version.version] = {
      ...metadata,
      name: packageName,
      version: version.version,
      description: getValue(pkg, 'description') || '',
      dist: {
        ...(metadata.dist || {}),
        tarball: formatLocalTarballUrl(registryName, packageName, filename),
        shasum: assetData.checksumSha1 || metadata.dist?.shasum,
        integrity: assetData.checksumSha256
          ? `sha256-${Buffer.from(assetData.checksumSha256, 'hex').toString('base64')}`
          : metadata.dist?.integrity,
      },
    };
  }

  return {
    name: packageName,
    description: getValue(pkg, 'description') || '',
    'dist-tags': {
      latest,
    },
    versions: npmVersions,
  };
}

async function sendTarball(
  plugin: RegistryPlugin,
  ctx: AnyContext,
  registryName: string,
  packageName: string,
  filename: string,
) {
  const registry = await findRegistry(plugin, normalizeRegistryName(registryName));
  if (!registry) {
    throw notFound(`Registry not found: ${registryName}`);
  }

  const version = getVersionFromTarballName(packageName, filename);
  let pkg = await findPackage(plugin, packageName, registry);
  if (!pkg) {
    if (isProxyRegistry(registry)) {
      await cachePackageMetadataFromUpstream(plugin, registry, packageName);
      pkg = await findPackage(plugin, packageName, registry);
    }
    if (!pkg) {
      throw notFound(`Package not found: ${packageName}`);
    }
  }

  let versionRecord = await plugin.db.getRepository('packageVersions').findOne({
    filter: {
      packageId: getValue(pkg, 'id'),
      version,
    },
  });
  if (!versionRecord) {
    if (isProxyRegistry(registry)) {
      await cachePackageMetadataFromUpstream(plugin, registry, packageName, true);
      versionRecord = await plugin.db.getRepository('packageVersions').findOne({
        filter: {
          packageId: getValue(pkg, 'id'),
          version,
        },
      });
    }
    if (!versionRecord) {
      throw notFound(`Package version not found: ${packageName}@${version}`);
    }
  }

  let asset = await plugin.db.getRepository('packageAssets').findOne({
    filter: {
      versionId: getValue(versionRecord, 'id'),
      filename,
    },
  });
  if (!asset) {
    if (isProxyRegistry(registry)) {
      await cacheTarballFromUpstream(plugin, registry, packageName, version, filename);
      asset = await plugin.db.getRepository('packageAssets').findOne({
        filter: {
          versionId: getValue(versionRecord, 'id'),
          filename,
        },
      });
    }
    if (!asset) {
      throw notFound(`Package asset not found: ${filename}`);
    }
  }

  const filePath = resolveStorageRelativePath(getValue(asset, 'path'));
  const stat = statSync(filePath);
  if (!stat.isFile()) {
    throw notFound(`Package asset file not found: ${filename}`);
  }

  ctx.type = 'application/octet-stream';
  ctx.attachment(filename);
  ctx.set('Content-Length', String(stat.size));
  ctx.set('Cache-Control', 'private, max-age=3600');
  ctx.body = createReadStream(filePath);
}

async function findRegistry(plugin: RegistryPlugin, registryName: string) {
  return plugin.db.getRepository('packageRegistries').findOne({ filter: { name: registryName } });
}

async function findOrCreateRegistry(plugin: RegistryPlugin, registryName: string) {
  const repo = plugin.db.getRepository('packageRegistries');
  let registry = await repo.findOne({ filter: { name: registryName } });
  if (!registry) {
    registry = await repo.create({
      values: {
        name: registryName,
        title: registryName,
        format: 'npm',
        type: 'hosted',
      },
    });
  }
  return registry;
}

async function cachePackageMetadataFromUpstream(
  plugin: RegistryPlugin,
  registry: any,
  packageName: string,
  forceRefresh = false,
) {
  await withCacheLock(plugin, `metadata:${getValue(registry, 'id')}:${packageName}`, async () => {
    const existing = await findPackage(plugin, packageName, registry);
    if (existing && !forceRefresh) {
      const versionCount = await plugin.db.getRepository('packageVersions').count({
        filter: { packageId: getValue(existing, 'id') },
      });
      if (versionCount > 0) {
        return;
      }
    }

    const upstream = normalizeUpstreamUrl(getValue(registry, 'upstreamUrl'));
    const metadata = await fetchUpstreamMetadata(upstream, packageName);
    const versions = metadata.versions || {};
    const versionNames = Object.keys(versions);
    if (!versionNames.length) {
      throw notFound(`Upstream package has no versions: ${packageName}`);
    }

    const pkg = await findOrCreatePackage(plugin, registry, packageName, metadata.description || '');
    for (const version of versionNames) {
      normalizeVersion(version);
      await findOrCreateVersion(plugin, pkg, version, versions[version] || {});
    }
  });
}

async function cacheTarballFromUpstream(
  plugin: RegistryPlugin,
  registry: any,
  packageName: string,
  version: string,
  filename: string,
) {
  await withCacheLock(plugin, `tarball:${getValue(registry, 'id')}:${packageName}:${version}`, async () => {
    const pkg = await findPackage(plugin, packageName, registry);
    if (!pkg) {
      await cachePackageMetadataFromUpstream(plugin, registry, packageName);
    }

    const latestPackage = await findPackage(plugin, packageName, registry);
    if (!latestPackage) {
      throw notFound(`Package not found after upstream sync: ${packageName}`);
    }

    let versionRecord = await plugin.db.getRepository('packageVersions').findOne({
      filter: {
        packageId: getValue(latestPackage, 'id'),
        version,
      },
    });
    if (!versionRecord) {
      await cachePackageMetadataFromUpstream(plugin, registry, packageName);
      versionRecord = await plugin.db.getRepository('packageVersions').findOne({
        filter: {
          packageId: getValue(latestPackage, 'id'),
          version,
        },
      });
    }
    if (!versionRecord) {
      throw notFound(`Upstream package version not found: ${packageName}@${version}`);
    }

    const existingAsset = await plugin.db.getRepository('packageAssets').findOne({
      filter: {
        versionId: getValue(versionRecord, 'id'),
        filename,
      },
    });
    if (existingAsset) {
      return;
    }

    const metadata = getValue(versionRecord, 'metadata') || {};
    const upstream = normalizeUpstreamUrl(getValue(registry, 'upstreamUrl'));
    const tarballUrl = normalizeTarballUrl(metadata.dist?.tarball || buildUpstreamTarballUrl(upstream, packageName, version));
    const storagePath = getTarballStoragePath(getValue(registry, 'name'), packageName, version, filename);
    await mkdir(path.dirname(storagePath), { recursive: true });
    await downloadToFile(tarballUrl, storagePath);

    assertTarballPath(storagePath);
    const stat = statSync(storagePath);
    const checksums = await getChecksums(storagePath);
    await replaceVersionAsset(plugin, versionRecord, {
      filename,
      path: toStorageRelativePath(storagePath),
      size: stat.size,
      checksumSha1: checksums.sha1,
      checksumMd5: checksums.md5,
      checksumSha256: checksums.sha256,
    });
  });
}

async function findPackage(plugin: RegistryPlugin, packageName: string, registry?: any) {
  const filter: Record<string, any> = { name: packageName };
  if (registry) {
    filter.registryId = getValue(registry, 'id');
  }
  return plugin.db.getRepository('packages').findOne({ filter });
}

async function findOrCreatePackage(plugin: RegistryPlugin, registry: any, packageName: string, description: string) {
  const repo = plugin.db.getRepository('packages');
  let pkg = await repo.findOne({ filter: { registryId: getValue(registry, 'id'), name: packageName } });
  if (!pkg) {
    pkg = await repo.create({
      values: {
        name: packageName,
        description,
        registryId: getValue(registry, 'id'),
      },
    });
  } else if (description && description !== getValue(pkg, 'description')) {
    await repo.update({
      filterByTk: getValue(pkg, 'id'),
      values: { description },
    });
  }
  return pkg;
}

async function findOrCreateVersion(plugin: RegistryPlugin, pkg: any, version: string, metadata: Record<string, any>) {
  const repo = plugin.db.getRepository('packageVersions');
  let versionRecord = await repo.findOne({ filter: { packageId: getValue(pkg, 'id'), version } });
  if (!versionRecord) {
    versionRecord = await repo.create({
      values: {
        version,
        packageId: getValue(pkg, 'id'),
        metadata,
      },
    });
  } else {
    await repo.update({
      filterByTk: getValue(versionRecord, 'id'),
      values: { metadata },
    });
  }
  return versionRecord;
}

async function replaceVersionAsset(plugin: RegistryPlugin, versionRecord: any, values: Record<string, any>) {
  const repo = plugin.db.getRepository('packageAssets');
  const versionId = getValue(versionRecord, 'id');
  await repo.destroy({ filter: { versionId } });
  return repo.create({
    values: {
      ...values,
      versionId,
    },
  });
}

function isRegistryPath(pathname: string) {
  return pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`);
}

function parsePackageRoute(rawPath: string, registryQuery?: unknown) {
  const cleanedPath = String(rawPath || '').replace(/^\/+/, '').replace(/\/+$/, '');
  const segments = cleanedPath.split('/').filter(Boolean);

  if (segments.length >= 2 && !segments[0].startsWith('@')) {
    return {
      registryName: normalizeRegistryName(segments[0]),
      packageName: normalizePackageName(segments.slice(1).join('/')),
    };
  }

  return {
    registryName: normalizeRegistryName(registryQuery || DEFAULT_REGISTRY_NAME),
    packageName: normalizePackageName(cleanedPath),
  };
}

function normalizePackageName(value: unknown) {
  const packageName = decodePathPart(value).replace(/^\/+/, '').replace(/\/+$/, '');
  if (!packageName || !SAFE_PACKAGE_RE.test(packageName)) {
    throw badRequest(`Invalid package name: ${String(value || '')}`);
  }
  if (packageName.includes('..') || packageName.includes('\\')) {
    throw badRequest(`Invalid package name: ${packageName}`);
  }
  return packageName;
}

function normalizeVersion(value: unknown) {
  const version = String(value || '').trim();
  if (!version || !/^[a-zA-Z0-9_.+~-]+$/.test(version)) {
    throw badRequest(`Invalid package version: ${String(value || '')}`);
  }
  return version;
}

function normalizeRegistryName(value: unknown) {
  const registryName = String(value || DEFAULT_REGISTRY_NAME).trim();
  if (!/^[a-zA-Z0-9_.-]+$/.test(registryName)) {
    throw badRequest(`Invalid registry name: ${registryName}`);
  }
  return registryName;
}

function normalizeTarballName(value: unknown) {
  const filename = decodePathPart(value).replace(/^\/+/, '');
  if (!SAFE_TARBALL_RE.test(filename) || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    throw badRequest(`Invalid tarball filename: ${String(value || '')}`);
  }
  return filename;
}

function decodePathPart(value: unknown) {
  try {
    return decodeURIComponent(String(value || '').trim());
  } catch {
    throw badRequest(`Invalid encoded path: ${String(value || '')}`);
  }
}

function getVersionFromTarballName(packageName: string, filename: string) {
  const baseName = packageName.split('/').pop();
  const prefix = `${baseName}-`;
  if (!filename.startsWith(prefix) || !filename.endsWith('.tgz')) {
    throw badRequest(`Tarball filename does not match package ${packageName}`);
  }
  return normalizeVersion(filename.slice(prefix.length, -'.tgz'.length));
}

function getTarballStoragePath(registryName: string, packageName: string, version: string, filename: string) {
  return path.join(getStorageRoot(), registryName, ...packageName.split('/'), version, filename);
}

function getStorageRoot() {
  return path.resolve(process.cwd(), 'storage', 'package-registry', 'npm');
}

function toStorageRelativePath(filePath: string) {
  return path.relative(path.resolve(process.cwd(), 'storage'), filePath).replace(/\\/g, '/');
}

function resolveStorageRelativePath(relativePath: string) {
  const storageRoot = path.resolve(process.cwd(), 'storage');
  const resolved = path.resolve(storageRoot, relativePath);
  if (!resolved.startsWith(`${storageRoot}${path.sep}`)) {
    throw badRequest('Invalid package asset path');
  }
  return resolved;
}

function assertTarballPath(filePath: string) {
  const stat = statSync(filePath);
  if (!stat.isFile() || path.extname(filePath) !== '.tgz') {
    throw badRequest('Package asset must be a .tgz file');
  }
}

function isProxyRegistry(registry: any) {
  return getValue(registry, 'type') === 'proxy' && Boolean(getValue(registry, 'upstreamUrl'));
}

function normalizeUpstreamUrl(value: unknown) {
  const raw = String(value || '').trim();
  if (!raw || /\s/.test(raw)) {
    throw badRequest('Proxy registry upstreamUrl is required and must not contain whitespace');
  }

  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw badRequest('Proxy registry upstreamUrl must use http or https');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

function normalizeTarballUrl(value: unknown) {
  const raw = String(value || '').trim();
  if (!raw || /\s/.test(raw)) {
    throw badRequest('Invalid upstream tarball URL');
  }
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw badRequest('Upstream tarball URL must use http or https');
  }
  return url.toString();
}

function buildUpstreamMetadataUrl(upstreamUrl: string, packageName: string) {
  return `${upstreamUrl}/${encodeURIComponent(packageName)}`;
}

function buildUpstreamTarballUrl(upstreamUrl: string, packageName: string, version: string) {
  return `${upstreamUrl}/${packageName}/-/${packageName.split('/').pop()}-${version}.tgz`;
}

function formatLocalTarballUrl(registryName: string, packageName: string, filename: string) {
  const registryPrefix = registryName === DEFAULT_REGISTRY_NAME ? '' : `/${registryName}`;
  return `${API_PREFIX}${registryPrefix}/${packageName}/-/${filename}`;
}

async function fetchUpstreamMetadata(upstreamUrl: string, packageName: string) {
  const response = await fetchWithTimeout(buildUpstreamMetadataUrl(upstreamUrl, packageName), {
    headers: { 'User-Agent': 'NocoBase-package-registry/1.0' },
  });
  if (response.status === 404) {
    throw notFound(`Upstream package not found: ${packageName}`);
  }
  if (!response.ok) {
    throw Object.assign(new Error(`Upstream metadata request failed: HTTP ${response.status}`), { status: 502 });
  }
  return response.json();
}

async function downloadToFile(url: string, destination: string) {
  const tempPath = `${destination}.${process.pid}.${Date.now()}.tmp`;
  const response = await fetchWithTimeout(url, {
    headers: { 'User-Agent': 'NocoBase-package-registry/1.0' },
  });
  if (response.status === 404) {
    throw notFound(`Upstream tarball not found: ${url}`);
  }
  if (!response.ok) {
    throw Object.assign(new Error(`Upstream tarball request failed: HTTP ${response.status}`), { status: 502 });
  }

  try {
    await writeFile(tempPath, Buffer.from(await response.arrayBuffer()));
    await rename(tempPath, destination);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

async function fetchWithTimeout(url: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROXY_DOWNLOAD_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw Object.assign(new Error(`Upstream request failed: ${message}`), { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}

async function withCacheLock<T>(plugin: RegistryPlugin, key: string, fn: () => Promise<T>): Promise<T> {
  const lockKey = `package-registry:${key}`;
  const lockManager = plugin.app?.lockManager;
  if (lockManager?.runExclusive) {
    return lockManager.runExclusive(lockKey, fn, PROXY_CACHE_TTL_MS);
  }

  const existing = cacheLocks.get(lockKey);
  if (existing) {
    await existing;
    return fn();
  }

  const pending = fn().finally(() => cacheLocks.delete(lockKey));
  cacheLocks.set(lockKey, pending);
  return pending;
}

async function getChecksums(filePath: string) {
  const hashes = {
    sha1: createHash('sha1'),
    md5: createHash('md5'),
    sha256: createHash('sha256'),
  };

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => {
      hashes.sha1.update(chunk);
      hashes.md5.update(chunk);
      hashes.sha256.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', resolve);
  });

  return {
    sha1: hashes.sha1.digest('hex'),
    md5: hashes.md5.digest('hex'),
    sha256: hashes.sha256.digest('hex'),
  };
}

function compareVersions(a: string, b: string) {
  const aParts = String(a).split(/[.+~-]/);
  const bParts = String(b).split(/[.+~-]/);
  const max = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < max; i += 1) {
    const left = aParts[i] || '0';
    const right = bParts[i] || '0';
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    const result =
      Number.isFinite(leftNumber) && Number.isFinite(rightNumber)
        ? leftNumber - rightNumber
        : left.localeCompare(right);
    if (result !== 0) {
      return result;
    }
  }
  return 0;
}

function getValue(record: any, key: string) {
  if (!record) return undefined;
  if (typeof record.get === 'function') return record.get(key);
  return record[key];
}

function toJSON(record: any) {
  if (!record) return record;
  if (typeof record.toJSON === 'function') return record.toJSON();
  return record;
}

function badRequest(message: string) {
  return Object.assign(new Error(message), { status: 400 });
}

function notFound(message: string) {
  return Object.assign(new Error(message), { status: 404 });
}
