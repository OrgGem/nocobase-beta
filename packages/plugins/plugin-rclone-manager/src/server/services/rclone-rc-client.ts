// SPDX-License-Identifier: Apache-2.0

import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import { SUPPORTS_ABOUT_BACKENDS } from '../../shared/constants';
import {
  extractRemoteName,
  extractWrapperTargets,
  isLocalFsTarget,
  isSyntacticLocalFs,
  WRAPPER_REMOTE_TYPES,
} from '../../shared/fs-guard';
import type {
  RcloneAboutUsage,
  RcloneAuthType,
  RcloneCoreStats,
  RcloneDiskInfo,
  RcloneJobStatusResponse,
  RcloneListItem,
  RcloneMountPoint,
  RcloneProviderInfo,
  RcloneRemoteSummary,
  RcloneServeItem,
  RcloneTransferredItem,
  RcloneVersionInfo,
} from '../../shared/types';
import { redactTextSecrets } from '../utils/secret-redactor';
import { createStreamingZip, MAX_ZIP32_BYTES, MAX_ZIP32_ENTRIES } from '../utils/streaming-zip';

export interface RcloneRcClientConfig {
  baseUrl: string;
  authType: RcloneAuthType;
  username?: string | null;
  password?: string | null;
  timeoutMs?: number;
}

export interface RcloneFsInfoResponse {
  Name?: string;
  Root?: string;
  String?: string;
  Features?: {
    About?: boolean;
    IsLocal?: boolean;
    BucketBased?: boolean;
    [key: string]: unknown;
  };
}

export interface RcloneStatResponse {
  item?: {
    Path?: string;
    Name?: string;
    Size?: number;
    MimeType?: string;
    IsDir?: boolean;
  } | null;
}

export class RcloneRcError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = 'RcloneRcError';
    this.status = status;
  }
}

export function assertValidRcBaseUrl(rawUrl: string): string {
  const trimmed = String(rawUrl ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!trimmed) {
    throw new RcloneRcError('Rclone RC base URL is required', 400);
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new RcloneRcError('Invalid Rclone RC base URL; expected http:// or https://', 400);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new RcloneRcError('Rclone RC base URL must use http:// or https://', 400);
  }
  if (parsed.username || parsed.password) {
    throw new RcloneRcError('Configure username and password in dedicated fields instead of the URL', 400);
  }
  return trimmed;
}

function encodePathSegments(remotePath: string): string {
  return remotePath
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function isDumpEntryLocal(
  remoteName: string,
  dumpRes: Readonly<Record<string, Record<string, unknown>>> | null | undefined,
  visiting = new Set<string>(),
): boolean {
  if (!dumpRes || visiting.has(remoteName)) {
    return false;
  }
  const entry = dumpRes[remoteName];
  if (!entry || typeof entry !== 'object') {
    return false;
  }
  visiting.add(remoteName);
  const entryType = String(entry.type ?? '').toLowerCase();
  if (entryType === 'local') {
    return true;
  }
  if (WRAPPER_REMOTE_TYPES.has(entryType)) {
    for (const target of extractWrapperTargets(entry)) {
      if (isSyntacticLocalFs(target)) {
        return true;
      }
      const nestedRemote = extractRemoteName(target);
      if (nestedRemote && isDumpEntryLocal(nestedRemote, dumpRes, visiting)) {
        return true;
      }
    }
  }
  return false;
}

function inferTypeFromFsInfo(fsInfo: RcloneFsInfoResponse | null): string {
  if (!fsInfo) return 'unknown';
  if (fsInfo.Features?.IsLocal) return 'local';
  const desc = String(fsInfo.String ?? '').toLowerCase();
  if (desc.startsWith('s3 ')) return 's3';
  if (desc.includes('google drive')) return 'drive';
  if (desc.includes('onedrive')) return 'onedrive';
  if (desc.includes('dropbox')) return 'dropbox';
  if (desc.includes('sftp')) return 'sftp';
  if (desc.includes('webdav')) return 'webdav';
  if (desc.includes('in memory')) return 'memory';
  const cleanName = String(fsInfo.Name ?? '')
    .replace(/\{.*\}$/, '')
    .trim();
  return cleanName || 'remote';
}

function parseByteRange(rangeHeader: string | undefined, totalSize: number): { start: number; end: number } | null {
  if (!rangeHeader || totalSize <= 0) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match) {
    return null;
  }
  const [, rawStart, rawEnd] = match;
  let start = rawStart ? Number.parseInt(rawStart, 10) : 0;
  let end = rawEnd ? Number.parseInt(rawEnd, 10) : totalSize - 1;
  if (!rawStart && rawEnd) {
    const suffixLen = Number.parseInt(rawEnd, 10);
    start = Math.max(0, totalSize - suffixLen);
    end = totalSize - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= totalSize || end < start) {
    return null;
  }
  end = Math.min(end, totalSize - 1);
  return { start, end };
}

export interface DownloadStreamHandle {
  stream: Readable;
  status: number;
  contentType: string;
  contentLength?: string;
  contentRange?: string;
  acceptRanges?: string;
  filename: string;
  cleanup: () => Promise<void>;
}

const GETFILE_CHUNK_BYTES = 1024 * 1024; // 1 MiB (safely within rclone's 2 MiB maxSize default)
const METADATA_CACHE_TTL_MS = 30_000;

export class RcloneRcClient {
  readonly baseUrl: string;
  private readonly authHeader?: string;
  private readonly defaultTimeoutMs: number;
  private readonly secretsToRedact: Array<string | null | undefined>;
  private remotesCache: { expiresAt: number; data: RcloneRemoteSummary[] } | null = null;
  private disksCache: { expiresAt: number; data: RcloneDiskInfo[] } | null = null;
  private readonly fsInfoCache = new Map<string, { expiresAt: number; info: RcloneFsInfoResponse }>();

  constructor(config: RcloneRcClientConfig) {
    this.baseUrl = assertValidRcBaseUrl(config.baseUrl);
    this.defaultTimeoutMs = config.timeoutMs ?? 20_000;
    this.secretsToRedact = [config.password];

    if (config.authType === 'basic' && config.username) {
      const encoded = Buffer.from(`${config.username}:${config.password ?? ''}`, 'utf8').toString('base64');
      this.authHeader = `Basic ${encoded}`;
      this.secretsToRedact.push(encoded);
    }
  }

  invalidateMetadataCache(): void {
    this.remotesCache = null;
    this.disksCache = null;
    this.fsInfoCache.clear();
  }

  private safeError(rawMessage: string, status = 502): RcloneRcError {
    return new RcloneRcError(redactTextSecrets(rawMessage, this.secretsToRedact), status);
  }

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...(extra ?? {}) };
    if (this.authHeader) {
      headers.Authorization = this.authHeader;
    }
    return headers;
  }

  async postJson<T = Record<string, unknown>>(
    rcPath: string,
    body?: Record<string, unknown>,
    options?: { timeoutMs?: number; allowErrorPayload?: boolean; signal?: AbortSignal },
  ): Promise<T> {
    const normalizedPath = rcPath.startsWith('/') ? rcPath : `/${rcPath}`;
    const url = `${this.baseUrl}${normalizedPath}`;
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options?.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: this.buildHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body ?? {}),
        signal,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw this.safeError(`Failed to reach rclone rcd (${normalizedPath}): ${msg}`, 502);
    }

    const text = await response.text();
    let parsed: unknown = {};
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        if (!response.ok) {
          throw this.safeError(text || `${response.status} ${response.statusText}`, response.status);
        }
      }
    }

    if (options?.allowErrorPayload && parsed && typeof parsed === 'object') {
      return parsed as T;
    }

    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      const errField = (parsed as { error?: unknown }).error;
      if (typeof errField === 'string' && errField.trim().length > 0) {
        throw this.safeError(errField, response.ok ? 400 : response.status);
      }
    }

    if (!response.ok) {
      throw this.safeError(`${response.status} ${response.statusText}`, response.status);
    }

    return parsed as T;
  }

  async postAsync(rcPath: string, body?: Record<string, unknown>): Promise<{ jobid: number }> {
    const data = await this.postJson<{ jobid?: number }>(rcPath, { ...(body ?? {}), _async: true });
    if (typeof data.jobid !== 'number' || !Number.isFinite(data.jobid)) {
      throw this.safeError(`Rclone async call ${rcPath} did not return a numeric jobid`, 502);
    }
    return { jobid: data.jobid };
  }

  async testConnection(): Promise<RcloneVersionInfo> {
    await this.postJson('/rc/noopauth', {}, { timeoutMs: 8_000 });
    return this.postJson<RcloneVersionInfo>('/core/version', {}, { timeoutMs: 8_000 });
  }

  async getVersion(): Promise<RcloneVersionInfo> {
    return this.postJson<RcloneVersionInfo>('/core/version', {}, { timeoutMs: 8_000 });
  }

  async getStats(group?: string): Promise<RcloneCoreStats> {
    return this.postJson<RcloneCoreStats>('/core/stats', group ? { group } : {}, { timeoutMs: 10_000 });
  }

  async getTransferred(group?: string): Promise<{ transferred: RcloneTransferredItem[] }> {
    return this.postJson<{ transferred: RcloneTransferredItem[] }>('/core/transferred', group ? { group } : {}, {
      timeoutMs: 10_000,
    });
  }

  async getJobStatus(jobid: number): Promise<RcloneJobStatusResponse | null> {
    const result = await this.postJson<Partial<RcloneJobStatusResponse> & { error?: string }>(
      '/job/status',
      { jobid },
      { timeoutMs: 10_000, allowErrorPayload: true },
    );
    if (typeof result.error === 'string' && result.error.toLowerCase().includes('job not found')) {
      return null;
    }
    if (typeof result.finished === 'boolean') {
      return {
        id: typeof result.id === 'number' ? result.id : jobid,
        finished: result.finished,
        success: Boolean(result.success),
        error: result.error ?? '',
        duration: result.duration ?? 0,
        startTime: result.startTime ?? '',
        endTime: result.endTime ?? '',
        group: result.group ?? `job/${jobid}`,
        output: result.output,
      };
    }
    throw this.safeError(
      typeof result.error === 'string' && result.error.trim()
        ? result.error
        : `Unexpected /job/status response for job #${jobid}`,
      502,
    );
  }

  async stopJob(jobid: number): Promise<void> {
    await this.postJson('/job/stop', { jobid });
  }

  async getFsInfo(fs: string): Promise<RcloneFsInfoResponse | null> {
    const key = String(fs ?? '').trim();
    if (!key) return null;
    const cached = this.fsInfoCache.get(key);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.info;
    }
    try {
      const info = await this.postJson<RcloneFsInfoResponse>('/operations/fsinfo', { fs: key }, { timeoutMs: 8_000 });
      this.fsInfoCache.set(key, { expiresAt: Date.now() + METADATA_CACHE_TTL_MS, info });
      return info;
    } catch {
      return null;
    }
  }

  /**
   * Authoritatively check whether `fs` resolves to a host local filesystem
   * (covering literal paths, Windows drives, `:local:`, `type=local` remotes,
   * AND `type=alias` or `RCLONE_CONFIG_*` env remotes backed by host paths).
   */
  async isFsLocal(fs: string, preloadedRemoteTypes?: Readonly<Record<string, string>>): Promise<boolean> {
    const trimmed = String(fs ?? '').trim();
    if (isLocalFsTarget(trimmed, preloadedRemoteTypes)) {
      return true;
    }
    const types = preloadedRemoteTypes ?? (await this.listRemoteTypes().catch(() => ({})));
    if (isLocalFsTarget(trimmed, types)) {
      return true;
    }
    const info = await this.getFsInfo(trimmed);
    return Boolean(info?.Features?.IsLocal);
  }

  /**
   * Return true when `fs` targets the root of an unrooted bucket-based remote
   * (e.g. `minio:` or `s3:` where `Features.BucketBased === true` and `Root === ""`).
   * Single-file operations targeting such roots without a `<bucket>/<key>` fail in S3.
   */
  async isUnrootedBucketFs(fs: string): Promise<boolean> {
    const trimmed = String(fs ?? '').trim();
    if (!trimmed || isSyntacticLocalFs(trimmed)) {
      return false;
    }
    const lastColon = trimmed.lastIndexOf(':');
    if (lastColon === -1) {
      return false;
    }
    const afterColon = trimmed.slice(lastColon + 1).replace(/^\/+/, '');
    if (afterColon.length > 0) {
      return false;
    }
    const info = await this.getFsInfo(trimmed);
    return Boolean(info?.Features?.BucketBased && !info?.Root);
  }

  async listProviders(): Promise<RcloneProviderInfo[]> {
    const res = await this.postJson<{ providers?: RcloneProviderInfo[] }>(
      '/config/providers',
      {},
      { timeoutMs: 15_000 },
    );
    return Array.isArray(res.providers) ? res.providers : [];
  }

  async inspectRemotes(): Promise<RcloneRemoteSummary[]> {
    if (this.remotesCache && Date.now() < this.remotesCache.expiresAt) {
      return this.remotesCache.data;
    }

    const [listRes, dumpRes] = await Promise.all([
      this.postJson<{ remotes?: string[] }>('/config/listremotes'),
      this.postJson<Record<string, Record<string, unknown>>>('/config/dump'),
    ]);
    const names = Array.isArray(listRes.remotes) ? [...listRes.remotes].sort((a, b) => a.localeCompare(b)) : [];

    const result = await Promise.all(
      names.map(async (name): Promise<RcloneRemoteSummary> => {
        const dumpEntry = dumpRes?.[name];
        const dumpType = typeof dumpEntry?.type === 'string' ? dumpEntry.type : '';
        const envDefined = !dumpEntry || typeof dumpEntry !== 'object' || !dumpType;
        const fsInfo = await this.getFsInfo(`${name}:`);
        const rawType = dumpType || inferTypeFromFsInfo(fsInfo);
        const isLocal =
          Boolean(fsInfo?.Features?.IsLocal) || rawType.toLowerCase() === 'local' || isDumpEntryLocal(name, dumpRes);
        const bucketBased = Boolean(fsInfo?.Features?.BucketBased && !fsInfo?.Root);
        const supportsAbout =
          typeof fsInfo?.Features?.About === 'boolean'
            ? fsInfo.Features.About
            : SUPPORTS_ABOUT_BACKENDS.has(rawType.toLowerCase());

        return {
          name,
          type: rawType,
          supportsAbout,
          isLocal,
          bucketBased,
          envDefined,
        };
      }),
    );

    this.remotesCache = { expiresAt: Date.now() + METADATA_CACHE_TTL_MS, data: result };
    return result;
  }

  async listRemoteTypes(): Promise<Record<string, string>> {
    const summaries = await this.inspectRemotes();
    const map: Record<string, string> = {};
    for (const item of summaries) {
      map[item.name] = item.isLocal ? 'local' : item.type;
    }
    return map;
  }

  async getRemoteRaw(name: string): Promise<Record<string, unknown>> {
    return this.postJson<Record<string, unknown>>('/config/get', { name });
  }

  async createRemote(
    name: string,
    type: string,
    parameters: Record<string, unknown>,
    opt?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const result = await this.postJson<Record<string, unknown>>(
      '/config/create',
      { name, type, parameters, ...(opt ? { opt } : {}) },
      { timeoutMs: 30_000 },
    );
    this.invalidateMetadataCache();
    return result;
  }

  async updateRemote(
    name: string,
    parameters: Record<string, unknown>,
    opt?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const result = await this.postJson<Record<string, unknown>>(
      '/config/update',
      { name, parameters, ...(opt ? { opt } : {}) },
      { timeoutMs: 30_000 },
    );
    this.invalidateMetadataCache();
    return result;
  }

  async deleteRemote(name: string): Promise<void> {
    await this.postJson('/config/delete', { name });
    this.invalidateMetadataCache();
  }

  async getAbout(fs: string, timeoutMs = 8_000): Promise<RcloneAboutUsage> {
    return this.postJson<RcloneAboutUsage>('/operations/about', { fs }, { timeoutMs });
  }

  async listDisks(): Promise<RcloneDiskInfo[]> {
    if (this.disksCache && Date.now() < this.disksCache.expiresAt) {
      return this.disksCache.data;
    }
    const res = await this.postJson<{ disks?: Array<string | RcloneDiskInfo> }>('/core/disks');
    if (!Array.isArray(res.disks)) {
      return [];
    }
    const seen = new Set<string>();
    const normalized: RcloneDiskInfo[] = [];
    for (const entry of res.disks) {
      const rawPath =
        typeof entry === 'string'
          ? entry.trim()
          : entry && typeof entry === 'object'
            ? String(entry.path ?? entry.fs ?? '').trim()
            : '';
      if (!rawPath) {
        continue;
      }
      const diskPath = /^[a-zA-Z]:$/.test(rawPath) ? `${rawPath}/` : rawPath;
      if (seen.has(diskPath)) {
        continue;
      }
      seen.add(diskPath);
      if (typeof entry === 'object' && entry !== null) {
        normalized.push({ ...entry, path: diskPath });
      } else {
        normalized.push({ path: diskPath });
      }
    }

    // Rclone `/core/disks` returns hardcoded XDG home folders (Desktop, Documents, etc.)
    // even inside headless/Docker environments where those folders do not exist on disk.
    const verified = await Promise.all(
      normalized.map(async (disk) => {
        const targetPath = disk.path ?? disk.fs ?? '';
        if (!targetPath) return null;
        try {
          await this.postJson('/operations/stat', { fs: targetPath, remote: '' }, { timeoutMs: 3_000 });
          return disk;
        } catch {
          return null;
        }
      }),
    );

    const result = verified.filter((disk): disk is RcloneDiskInfo => disk !== null);
    this.disksCache = { expiresAt: Date.now() + METADATA_CACHE_TTL_MS, data: result };
    return result;
  }

  async listFiles(
    fs: string,
    remote: string,
    opt?: { recurse?: boolean; filesOnly?: boolean },
  ): Promise<RcloneListItem[]> {
    const res = await this.postJson<{ list?: RcloneListItem[] }>(
      '/operations/list',
      opt ? { fs, remote, opt } : { fs, remote },
      { timeoutMs: 30_000 },
    );
    return Array.isArray(res.list) ? res.list : [];
  }

  async statItem(fs: string, remote: string): Promise<RcloneStatResponse['item']> {
    const res = await this.postJson<RcloneStatResponse>('/operations/stat', { fs, remote }, { timeoutMs: 15_000 });
    return res.item ?? null;
  }

  async getFileChunk(fs: string, remote: string, offset: number, count: number, signal?: AbortSignal): Promise<Buffer> {
    const res = await this.postJson<{ result?: string }>(
      '/operations/getfile',
      { fs, remote, offset, count, base64: true },
      { timeoutMs: 30_000, signal },
    );
    return Buffer.from(String(res.result ?? ''), 'base64');
  }

  async mkdir(fs: string, remote: string): Promise<void> {
    await this.postJson('/operations/mkdir', { fs, remote });
  }

  async deleteFile(fs: string, remote: string): Promise<void> {
    await this.postJson('/operations/deletefile', { fs, remote });
  }

  async purgeDir(fs: string, remote: string): Promise<void> {
    await this.postJson('/operations/purge', { fs, remote }, { timeoutMs: 60_000 });
  }

  async moveFileSync(srcFs: string, srcRemote: string, dstFs: string, dstRemote: string): Promise<void> {
    await this.postJson('/operations/movefile', { srcFs, srcRemote, dstFs, dstRemote }, { timeoutMs: 30_000 });
  }

  async moveDirSync(srcFs: string, dstFs: string): Promise<void> {
    await this.postJson(
      '/sync/move',
      { srcFs, dstFs, createEmptySrcDirs: true, deleteEmptySrcDirs: true },
      { timeoutMs: 60_000 },
    );
  }

  async listMountTypes(): Promise<string[]> {
    const res = await this.postJson<{ mountTypes?: string[] }>('/mount/types');
    return Array.isArray(res.mountTypes) ? res.mountTypes : [];
  }

  async listMounts(): Promise<RcloneMountPoint[]> {
    const res = await this.postJson<{ mountPoints?: RcloneMountPoint[] }>('/mount/listmounts');
    return Array.isArray(res.mountPoints) ? res.mountPoints : [];
  }

  async createMount(body: Record<string, unknown>): Promise<void> {
    await this.postJson('/mount/mount', body, { timeoutMs: 30_000 });
  }

  async unmount(mountPoint: string): Promise<void> {
    await this.postJson('/mount/unmount', { mountPoint });
  }

  async unmountAll(): Promise<void> {
    await this.postJson('/mount/unmountall');
  }

  async listServeTypes(): Promise<string[]> {
    const res = await this.postJson<{ types?: string[] }>('/serve/types');
    return Array.isArray(res.types) ? res.types : [];
  }

  async listServes(): Promise<RcloneServeItem[]> {
    const res = await this.postJson<{ list?: RcloneServeItem[] }>('/serve/list');
    return Array.isArray(res.list) ? res.list : [];
  }

  async startServe(body: Record<string, unknown>): Promise<{ id: string; addr: string }> {
    return this.postJson<{ id: string; addr: string }>('/serve/start', body, { timeoutMs: 20_000 });
  }

  async stopServe(id: string): Promise<void> {
    await this.postJson('/serve/stop', { id });
  }

  async stopAllServes(): Promise<void> {
    await this.postJson('/serve/stopall');
  }

  async getOptions(): Promise<Record<string, Record<string, unknown>>> {
    return this.postJson('/options/get');
  }

  async setOptions(body: Record<string, unknown>): Promise<void> {
    await this.postJson('/options/set', body);
  }

  async getConfigPaths(): Promise<{ config?: string; cache?: string; temp?: string }> {
    return this.postJson('/config/paths');
  }

  async readRawConfigFile(): Promise<{ path: string; content: string; configDisabled?: boolean }> {
    const paths = await this.getConfigPaths();
    const configPath = String(paths.config ?? '').trim();
    if (!configPath || configPath === '/dev/null' || configPath.toLowerCase() === 'nul') {
      return { path: configPath || '/dev/null', content: '', configDisabled: true };
    }

    const normalized = configPath.replace(/\\/g, '/');
    const lastSlash = normalized.lastIndexOf('/');
    const dirFs = lastSlash === -1 ? '.' : normalized.slice(0, lastSlash) || '/';
    const safeDirFs = /^[a-zA-Z]:$/.test(dirFs) ? `${dirFs}/` : dirFs;
    const filename = lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);

    try {
      const handle = await this.openDownloadStream(safeDirFs, filename, false);
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of handle.stream) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
        }
        return { path: configPath, content: Buffer.concat(chunks).toString('utf8'), configDisabled: false };
      } finally {
        await handle.cleanup();
      }
    } catch (error) {
      if (error instanceof RcloneRcError && error.status === 404) {
        return { path: configPath, content: '', configDisabled: false };
      }
      throw error;
    }
  }

  async writeRawConfigFile(content: string): Promise<{ path: string }> {
    const paths = await this.getConfigPaths();
    const configPath = String(paths.config ?? '').trim();
    if (!configPath || configPath === '/dev/null' || configPath.toLowerCase() === 'nul') {
      throw this.safeError('Config file persistence is disabled on this rclone daemon (RCLONE_CONFIG=/dev/null)', 400);
    }
    const normalized = configPath.replace(/\\/g, '/').replace(/\/+$/, '');
    const lastSlash = normalized.lastIndexOf('/');
    const dirFs = lastSlash === -1 ? '.' : normalized.slice(0, lastSlash) || '/';
    const safeDirFs = /^[a-zA-Z]:$/.test(dirFs) ? `${dirFs}/` : dirFs;
    const filename = lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);
    if (!filename) {
      throw this.safeError('Active config path does not include a filename', 400);
    }
    await this.uploadTextFile(safeDirFs, '', filename, content);
    this.invalidateMetadataCache();
    return { path: configPath };
  }

  async uploadTextFile(fs: string, remote: string, filename: string, content: string): Promise<void> {
    const uploadUrl = new URL(`${this.baseUrl}/operations/uploadfile`);
    uploadUrl.searchParams.set('fs', fs);
    uploadUrl.searchParams.set('remote', remote);

    const formData = new FormData();
    formData.append('file', new Blob([content], { type: 'text/plain' }), filename);

    let response: Response;
    try {
      response = await fetch(uploadUrl.toString(), {
        method: 'POST',
        headers: this.buildHeaders(),
        body: formData,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw this.safeError(`Upload to rclone failed: ${msg}`, 502);
    }

    if (!response.ok) {
      const text = await response.text();
      throw this.safeError(text || `${response.status} ${response.statusText}`, response.status);
    }
  }

  async uploadMultipartStream(
    fs: string,
    remote: string,
    reqStream: Readable,
    contentType: string,
    contentLength?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const uploadUrl = new URL(`${this.baseUrl}/operations/uploadfile`);
    uploadUrl.searchParams.set('fs', fs);
    uploadUrl.searchParams.set('remote', remote);

    const headers = this.buildHeaders({ 'Content-Type': contentType });
    if (contentLength) {
      headers['Content-Length'] = contentLength;
    }

    const requestInit: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      headers,
      body: Readable.toWeb(reqStream) as unknown as BodyInit,
      duplex: 'half',
      ...(signal ? { signal } : {}),
    };

    let response: Response;
    try {
      response = await fetch(uploadUrl.toString(), requestInit);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw this.safeError(`Streaming upload to rclone failed: ${msg}`, 502);
    }

    const text = await response.text();
    if (!response.ok) {
      throw this.safeError(text || `${response.status} ${response.statusText}`, response.status);
    }
  }

  async openDownloadStream(
    fs: string,
    remote: string,
    isDir: boolean,
    rangeHeader?: string,
    signal?: AbortSignal,
  ): Promise<DownloadStreamHandle> {
    const cleanRemote = remote.replace(/^\/+/, '');
    const leafName =
      cleanRemote.split('/').filter(Boolean).pop() ||
      fs
        .replace(/:.*$/, '')
        .replace(/[/\\]+$/, '')
        .split(/[/\\]/)
        .pop() ||
      'download';

    // 1. Prefer direct `--rc-serve` endpoint for single files when enabled
    if (!isDir) {
      const encodedFs = `[${encodeURIComponent(fs)}]`;
      const encodedRemote = encodePathSegments(cleanRemote);
      const rcServeUrl = encodedRemote
        ? `${this.baseUrl}/${encodedFs}/${encodedRemote}`
        : `${this.baseUrl}/${encodedFs}`;

      try {
        const reqHeaders = this.buildHeaders(rangeHeader ? { Range: rangeHeader } : undefined);
        const directRes = await fetch(rcServeUrl, { method: 'GET', headers: reqHeaders, signal });
        if (directRes.ok || directRes.status === 206) {
          if (!directRes.body) {
            throw this.safeError('Empty response body from rclone --rc-serve', 502);
          }
          const webStream = directRes.body;
          const stream = Readable.fromWeb(webStream as unknown as NodeWebReadableStream);
          return {
            stream,
            status: directRes.status,
            contentType: directRes.headers.get('content-type') || 'application/octet-stream',
            contentLength: directRes.headers.get('content-length') || undefined,
            contentRange: directRes.headers.get('content-range') || undefined,
            acceptRanges: directRes.headers.get('accept-ranges') || undefined,
            filename: leafName,
            cleanup: async () => {
              stream.destroy();
              await webStream.cancel().catch(() => {});
            },
          };
        }
        directRes.body?.cancel().catch(() => {});
      } catch (err) {
        if (signal?.aborted) {
          throw err;
        }
        // Fall through to `/operations/getfile` chunked RC streaming
      }

      // 2. Chunked `/operations/getfile` streaming over the main RC port (works through Docker/K8s without --rc-serve or extra ports!)
      const stat = await this.statItem(fs, cleanRemote);
      if (!stat || stat.IsDir) {
        throw this.safeError(`File not found: ${cleanRemote}`, 404);
      }
      const totalSize = Math.max(0, Number(stat.Size ?? 0));
      const parsedRange = parseByteRange(rangeHeader, totalSize);
      const startOffset = parsedRange ? parsedRange.start : 0;
      const endOffset = parsedRange ? parsedRange.end : Math.max(0, totalSize - 1);
      const lengthToRead = totalSize === 0 ? 0 : endOffset - startOffset + 1;

      const generateChunks = async function* (self: RcloneRcClient) {
        let offset = startOffset;
        let remaining = lengthToRead;
        while (remaining > 0) {
          if (signal?.aborted) {
            break;
          }
          const step = Math.min(GETFILE_CHUNK_BYTES, remaining);
          const chunk = await self.getFileChunk(fs, cleanRemote, offset, step, signal);
          if (chunk.length === 0) {
            break;
          }
          yield chunk;
          offset += chunk.length;
          remaining -= chunk.length;
        }
      };

      const chunkStream = Readable.from(generateChunks(this));
      return {
        stream: chunkStream,
        status: parsedRange ? 206 : 200,
        contentType: stat.MimeType || 'application/octet-stream',
        contentLength: String(lengthToRead),
        contentRange: parsedRange ? `bytes ${startOffset}-${endOffset}/${totalSize}` : undefined,
        acceptRanges: 'bytes',
        filename: stat.Name || leafName,
        cleanup: async () => {
          chunkStream.destroy();
        },
      };
    }

    // 3. Directory ZIP streamed directly over the main RC port (zero extra Docker ports needed!)
    const files = await this.listFiles(fs, cleanRemote, { recurse: true, filesOnly: true });
    const fileItems = files.filter((item) => !item.IsDir);
    if (fileItems.length > MAX_ZIP32_ENTRIES) {
      throw this.safeError(
        `Directory exceeds ${MAX_ZIP32_ENTRIES} files limit for browser ZIP download; use a Workflow Sync/Copy job instead`,
        413,
      );
    }
    const estimatedZipBytes = fileItems.reduce((acc, item) => acc + Math.max(0, Number(item.Size ?? 0)) + 96, 22);
    if (estimatedZipBytes > MAX_ZIP32_BYTES || fileItems.some((item) => Number(item.Size ?? 0) > MAX_ZIP32_BYTES)) {
      throw this.safeError(
        'Directory exceeds 4 GiB limit for browser ZIP download; use a Workflow Sync/Copy job instead',
        413,
      );
    }

    const prefixWithSlash = cleanRemote ? `${cleanRemote.replace(/\/+$/, '')}/` : '';
    const entries = fileItems.map((item) => {
      const fullRemotePath = item.Path || (cleanRemote ? `${cleanRemote}/${item.Name}` : item.Name);
      const relName =
        prefixWithSlash && fullRemotePath.startsWith(prefixWithSlash)
          ? fullRemotePath.slice(prefixWithSlash.length)
          : fullRemotePath;
      return {
        name: relName || item.Name,
        modTime: item.ModTime ? new Date(item.ModTime) : undefined,
        openStream: async () => {
          const fileHandle = await this.openDownloadStream(fs, fullRemotePath, false, undefined, signal);
          return fileHandle.stream;
        },
      };
    });

    const zipStream = createStreamingZip(entries, signal);
    return {
      stream: zipStream,
      status: 200,
      contentType: 'application/zip',
      filename: `${leafName}.zip`,
      cleanup: async () => {
        zipStream.destroy();
      },
    };
  }
}
