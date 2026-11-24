// SPDX-License-Identifier: Apache-2.0

import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import { SUPPORTS_ABOUT_BACKENDS } from '../../shared/constants';
import {
  extractRemoteName,
  extractWrapperTargets,
  isSyntacticLocalFs,
  WRAPPER_REMOTE_TYPES,
} from '../../shared/fs-guard';
import type {
  RcloneAboutUsage,
  RcloneAuthType,
  RcloneCoreStats,
  RcloneDiskInfo,
  RcloneFsLocality,
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

function classifyDumpEntry(
  remoteName: string,
  dumpRes: Readonly<Record<string, Record<string, unknown>>> | null | undefined,
  visiting = new Set<string>(),
): RcloneFsLocality {
  if (!dumpRes || visiting.has(remoteName)) {
    return 'unknown';
  }
  const entry = dumpRes[remoteName];
  if (!entry || typeof entry !== 'object') {
    return 'unknown';
  }
  const entryType = String(entry.type ?? '')
    .trim()
    .toLowerCase();
  if (!entryType) {
    return 'unknown';
  }
  if (entryType === 'local') {
    return 'local';
  }
  if (WRAPPER_REMOTE_TYPES.has(entryType)) {
    const targets = extractWrapperTargets(entry);
    if (targets.length === 0) {
      return 'unknown';
    }
    visiting.add(remoteName);
    let hasUnknown = false;
    for (const target of targets) {
      if (isSyntacticLocalFs(target)) {
        return 'local';
      }
      const nestedRemote = extractRemoteName(target);
      if (!nestedRemote) {
        hasUnknown = true;
        continue;
      }
      const nestedLocality = classifyDumpEntry(nestedRemote, dumpRes, new Set(visiting));
      if (nestedLocality === 'local') {
        return 'local';
      }
      if (nestedLocality === 'unknown') {
        hasUnknown = true;
      }
    }
    return hasUnknown ? 'unknown' : 'remote';
  }
  return 'remote';
}

function inferVerifiedCloudBackendFromFsInfo(fsInfo: RcloneFsInfoResponse | null): string | null {
  if (!fsInfo || fsInfo.Features?.IsLocal !== false) {
    return null;
  }
  const desc = String(fsInfo.String ?? '')
    .trim()
    .toLowerCase();
  if (!desc) {
    return null;
  }
  // Composite/wrapper backends must never be classified as cloud from fsinfo alone because Rclone ANDs boolean features across upstreams.
  if (
    desc.startsWith('combine root') ||
    desc.startsWith('union root') ||
    desc.startsWith('encrypted drive') ||
    desc.startsWith('chunked ') ||
    desc.startsWith('compressed ') ||
    desc.startsWith('hasher::') ||
    desc.startsWith('local file system')
  ) {
    return null;
  }
  if (desc.startsWith('s3 ')) return 's3';
  if (desc.includes('google drive')) return 'drive';
  if (desc.startsWith('gcs ') || desc.includes('google cloud storage')) return 'google cloud storage';
  if (desc.includes('onedrive')) return 'onedrive';
  if (desc.includes('dropbox')) return 'dropbox';
  if (desc.startsWith('sftp ') || desc.startsWith('sftp://')) return 'sftp';
  if (desc.startsWith('webdav ')) return 'webdav';
  if (desc.startsWith('azure container')) return 'azureblob';
  if (desc.startsWith('b2 ')) return 'b2';
  if (desc.startsWith('box root')) return 'box';
  if (desc.startsWith('ftp://')) return 'ftp';
  if (desc.startsWith('swift ')) return 'swift';
  if (desc.startsWith('in memory')) return 'memory';
  return null;
}

function inferTypeFromFsInfo(fsInfo: RcloneFsInfoResponse | null): string {
  if (!fsInfo) return 'unknown';
  if (fsInfo.Features?.IsLocal) return 'local';
  const verifiedCloud = inferVerifiedCloudBackendFromFsInfo(fsInfo);
  if (verifiedCloud) return verifiedCloud;
  const desc = String(fsInfo.String ?? '')
    .trim()
    .toLowerCase();
  if (desc.startsWith('combine root')) return 'combine';
  if (desc.startsWith('union root')) return 'union';
  if (desc.startsWith('encrypted drive')) return 'crypt';
  if (desc.startsWith('chunked ')) return 'chunker';
  if (desc.startsWith('compressed ')) return 'compress';
  if (desc.startsWith('hasher::')) return 'hasher';
  return 'unknown';
}

export interface RcloneJobIdentity {
  executeId?: string | null;
  group?: string | null;
}

function normalizeJobIdentity(identity?: string | RcloneJobIdentity | null): { executeId: string; group: string } {
  if (typeof identity === 'string') {
    return { executeId: identity.trim(), group: '' };
  }
  if (identity && typeof identity === 'object') {
    return {
      executeId: typeof identity.executeId === 'string' ? identity.executeId.trim() : '',
      group: typeof identity.group === 'string' ? identity.group.trim() : '',
    };
  }
  return { executeId: '', group: '' };
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

  async postAsync(
    rcPath: string,
    body?: Record<string, unknown>,
    options?: { group?: string },
  ): Promise<{ jobid: number; executeId?: string; group?: string }> {
    const customGroup =
      options?.group?.trim() || (typeof body?._group === 'string' ? body._group.trim() : '') || undefined;
    const data = await this.postJson<{ jobid?: number; executeId?: unknown }>(rcPath, {
      ...(body ?? {}),
      ...(customGroup ? { _group: customGroup } : {}),
      _async: true,
    });
    if (typeof data.jobid !== 'number' || !Number.isFinite(data.jobid)) {
      throw this.safeError(`Rclone async call ${rcPath} did not return a numeric jobid`, 502);
    }
    const executeId = typeof data.executeId === 'string' && data.executeId.trim() ? data.executeId.trim() : undefined;
    return {
      jobid: data.jobid,
      ...(executeId ? { executeId } : {}),
      ...(customGroup ? { group: customGroup } : {}),
    };
  }

  async getJobList(): Promise<{
    executeId?: string;
    jobids: number[];
    runningIds?: number[];
    finishedIds?: number[];
  }> {
    const res = await this.postJson<{
      executeId?: unknown;
      jobids?: unknown;
      runningIds?: unknown;
      finishedIds?: unknown;
    }>('/job/list', {}, { timeoutMs: 10_000 });
    const executeId = typeof res.executeId === 'string' && res.executeId.trim() ? res.executeId.trim() : undefined;
    return {
      ...(executeId ? { executeId } : {}),
      jobids: Array.isArray(res.jobids) ? res.jobids.map(Number).filter(Number.isFinite) : [],
      runningIds: Array.isArray(res.runningIds) ? res.runningIds.map(Number).filter(Number.isFinite) : undefined,
      finishedIds: Array.isArray(res.finishedIds) ? res.finishedIds.map(Number).filter(Number.isFinite) : undefined,
    };
  }

  async getStatsGroups(): Promise<string[] | null> {
    try {
      const res = await this.postJson<{ groups?: unknown }>('/core/group-list', {}, { timeoutMs: 10_000 });
      return Array.isArray(res.groups) ? res.groups.map((item) => String(item ?? '')) : [];
    } catch (err) {
      if (err instanceof RcloneRcError && err.status === 404) {
        return null;
      }
      throw err;
    }
  }

  async findJobByGroup(group: string): Promise<{ job: RcloneJobStatusResponse; executeId?: string } | null> {
    const targetGroup = String(group ?? '').trim();
    if (!targetGroup) {
      return null;
    }
    const list = await this.getJobList();
    const sortedIds = [...list.jobids].sort((a, b) => b - a);
    for (const jid of sortedIds) {
      const res = await this.postJson<Partial<RcloneJobStatusResponse> & { error?: string }>(
        '/job/status',
        { jobid: jid },
        { timeoutMs: 10_000, allowErrorPayload: true },
      );
      if (typeof res.finished === 'boolean' && String(res.group ?? '').trim() === targetGroup) {
        const statusExec =
          typeof res.executeId === 'string' && res.executeId.trim() ? res.executeId.trim() : list.executeId;
        return {
          job: {
            id: typeof res.id === 'number' ? res.id : jid,
            ...(statusExec ? { executeId: statusExec } : {}),
            finished: res.finished,
            success: Boolean(res.success),
            error: res.error ?? '',
            duration: res.duration ?? 0,
            startTime: res.startTime ?? '',
            endTime: res.endTime ?? '',
            group: targetGroup,
            output: res.output,
          },
          ...(statusExec ? { executeId: statusExec } : {}),
        };
      }
    }
    return null;
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

  async getJobStatus(
    jobid: number,
    identity?: string | RcloneJobIdentity | null,
  ): Promise<RcloneJobStatusResponse | null> {
    const { executeId: expectedExec, group: expectedGroup } = normalizeJobIdentity(identity);
    if (!expectedExec && !expectedGroup) {
      throw this.safeError(
        `Unverified rclone job identity for job #${jobid} (missing executeId and group); refusing to accept status`,
        409,
      );
    }

    let verifiedByList = false;
    if (expectedExec) {
      try {
        const list = await this.getJobList();
        if (list.executeId) {
          if (list.executeId !== expectedExec) {
            return null;
          }
          verifiedByList = true;
        }
      } catch (err) {
        if (!(err instanceof RcloneRcError && err.status === 404)) {
          throw err;
        }
      }
    }

    const result = await this.postJson<Partial<RcloneJobStatusResponse> & { error?: string }>(
      '/job/status',
      { jobid },
      { timeoutMs: 10_000, allowErrorPayload: true },
    );
    if (typeof result.error === 'string' && result.error.toLowerCase().includes('job not found')) {
      return null;
    }
    if (typeof result.finished === 'boolean') {
      const statusExecuteId =
        typeof result.executeId === 'string' && result.executeId.trim() ? result.executeId.trim() : undefined;
      const statusGroup = typeof result.group === 'string' && result.group.trim() ? result.group.trim() : undefined;
      if (expectedExec) {
        if (statusExecuteId && statusExecuteId !== expectedExec) {
          return null;
        }
        if (!verifiedByList && !statusExecuteId && !(expectedGroup && statusGroup === expectedGroup)) {
          throw this.safeError(`Unable to verify rclone daemon executeId for job #${jobid}`, 502);
        }
      }
      if (expectedGroup) {
        if (statusGroup && statusGroup !== expectedGroup) {
          return null;
        }
        if (!statusGroup && !verifiedByList && !statusExecuteId) {
          throw this.safeError(`Unable to verify rclone job group for job #${jobid}`, 502);
        }
      }
      const resolvedExecuteId = statusExecuteId ?? (verifiedByList ? expectedExec : undefined);
      return {
        id: typeof result.id === 'number' ? result.id : jobid,
        ...(resolvedExecuteId ? { executeId: resolvedExecuteId } : {}),
        finished: result.finished,
        success: Boolean(result.success),
        error: result.error ?? '',
        duration: result.duration ?? 0,
        startTime: result.startTime ?? '',
        endTime: result.endTime ?? '',
        group: statusGroup ?? (expectedGroup || `job/${jobid}`),
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

  async stopJobGroup(group: string): Promise<void> {
    const trimmed = String(group ?? '').trim();
    if (!trimmed) {
      throw this.safeError('Rclone job group is required to stop group', 400);
    }
    await this.postJson('/job/stopgroup', { group: trimmed });
  }

  async stopJob(jobid: number, identity?: string | RcloneJobIdentity | null): Promise<void> {
    const { executeId: expectedExec, group: expectedGroup } = normalizeJobIdentity(identity);
    if (expectedGroup) {
      await this.stopJobGroup(expectedGroup);
      return;
    }
    if (!expectedExec) {
      throw this.safeError(
        `Unverified rclone job identity for job #${jobid} (missing executeId and group); refusing to stop by bare jobid`,
        409,
      );
    }

    let verified = false;
    try {
      const list = await this.getJobList();
      if (list.executeId) {
        if (list.executeId !== expectedExec) {
          throw this.safeError(
            `Rclone daemon restarted (executeId mismatch); refusing to stop job #${jobid} on new daemon instance`,
            409,
          );
        }
        verified = true;
      }
    } catch (err) {
      if (err instanceof RcloneRcError && err.status === 409) {
        throw err;
      }
      if (!(err instanceof RcloneRcError && err.status === 404)) {
        throw err;
      }
    }
    if (!verified) {
      const status = await this.postJson<Partial<RcloneJobStatusResponse> & { error?: string }>(
        '/job/status',
        { jobid },
        { timeoutMs: 10_000, allowErrorPayload: true },
      );
      const statusExec = typeof status.executeId === 'string' ? status.executeId.trim() : '';
      if (!statusExec) {
        throw this.safeError(`Unable to verify rclone daemon executeId before stopping job #${jobid}`, 502);
      }
      if (statusExec !== expectedExec) {
        throw this.safeError(
          `Rclone daemon restarted (executeId mismatch); refusing to stop job #${jobid} on new daemon instance`,
          409,
        );
      }
    }
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
   * Classify whether `fs` targets a host local filesystem (`local`), a verified
   * non-local cloud backend (`remote`), or cannot be determined due to missing/failed
   * daemon metadata (`unknown`).
   */
  async classifyFsLocality(
    fs: string,
    preloadedRemoteTypes?: Readonly<Record<string, string>>,
  ): Promise<RcloneFsLocality> {
    const trimmed = String(fs ?? '').trim();
    if (isSyntacticLocalFs(trimmed)) {
      return 'local';
    }
    const remoteName = extractRemoteName(trimmed);
    if (!remoteName) {
      return 'remote';
    }
    if (preloadedRemoteTypes) {
      const preloaded = preloadedRemoteTypes[remoteName]?.toLowerCase();
      if (preloaded === 'local') {
        return 'local';
      }
      if (preloaded && preloaded !== 'unknown') {
        return 'remote';
      }
    }

    let summaries: RcloneRemoteSummary[] | null = null;
    try {
      summaries = await this.inspectRemotes();
    } catch {
      summaries = null;
    }

    if (summaries) {
      const match = summaries.find((item) => item.name === remoteName);
      if (match) {
        return match.locality ?? (match.isLocal ? 'local' : 'remote');
      }
      const info = await this.getFsInfo(trimmed);
      if (!info) {
        return 'unknown';
      }
      if (info.Features?.IsLocal) {
        return 'local';
      }
      return inferVerifiedCloudBackendFromFsInfo(info) ? 'remote' : 'unknown';
    }

    const info = await this.getFsInfo(trimmed);
    if (info?.Features?.IsLocal) {
      return 'local';
    }
    return 'unknown';
  }

  /**
   * Authoritatively check whether `fs` resolves to a host local filesystem
   * (covering literal paths, Windows drives, `:local:`, `type=local` remotes,
   * AND `type=alias` or `RCLONE_CONFIG_*` env remotes backed by host paths).
   * Throws when daemon metadata is unavailable so indeterminate remotes fail closed.
   */
  async isFsLocal(fs: string, preloadedRemoteTypes?: Readonly<Record<string, string>>): Promise<boolean> {
    const locality = await this.classifyFsLocality(fs, preloadedRemoteTypes);
    if (locality === 'unknown') {
      throw this.safeError(
        `Unable to classify remote backend for "${String(
          fs ?? '',
        ).trim()}"; refusing operation until remote metadata is available`,
        502,
      );
    }
    return locality === 'local';
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

  async listRemoteNames(): Promise<string[]> {
    const res = await this.postJson<{ remotes?: string[] }>('/config/listremotes');
    return Array.isArray(res.remotes) ? res.remotes : [];
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
        const dumpLocality = classifyDumpEntry(name, dumpRes);
        const fsInfo = await this.getFsInfo(`${name}:`);
        const rawType = dumpType || inferTypeFromFsInfo(fsInfo);

        let locality: RcloneFsLocality;
        if (Boolean(fsInfo?.Features?.IsLocal) || dumpLocality === 'local' || rawType.toLowerCase() === 'local') {
          locality = 'local';
        } else if (dumpLocality === 'remote') {
          locality = 'remote';
        } else if (envDefined && inferVerifiedCloudBackendFromFsInfo(fsInfo) !== null) {
          locality = 'remote';
        } else {
          locality = 'unknown';
        }

        const isLocal = locality === 'local';
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
          locality,
          bucketBased,
          envDefined,
        };
      }),
    );

    if (result.every((item) => item.locality !== 'unknown')) {
      this.remotesCache = { expiresAt: Date.now() + METADATA_CACHE_TTL_MS, data: result };
    }
    return result;
  }

  async listRemoteTypes(): Promise<Record<string, string>> {
    const summaries = await this.inspectRemotes();
    const map: Record<string, string> = {};
    for (const item of summaries) {
      if (item.locality === 'unknown') {
        map[item.name] = 'unknown';
      } else {
        map[item.name] = item.isLocal ? 'local' : item.type;
      }
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
      if (error instanceof RcloneRcError) {
        throw error;
      }
      if (signal?.aborted && signal.reason instanceof RcloneRcError) {
        throw signal.reason;
      }
      const msg = error instanceof Error ? error.message : String(error);
      throw this.safeError(`Streaming upload to rclone failed: ${msg}`, 502);
    }

    if (signal?.aborted && signal.reason instanceof RcloneRcError) {
      throw signal.reason;
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
