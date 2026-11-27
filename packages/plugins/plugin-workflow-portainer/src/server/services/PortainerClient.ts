/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS } from '../../shared/constants';
import type {
  ID,
  PortainerContainerStats,
  PortainerContainerSummary,
  PortainerDeploymentRecord,
  PortainerEndpointSummary,
  PortainerEnvPair,
  PortainerStackDetail,
  PortainerStackSummary,
} from '../../shared/types';

export interface PortainerClientOptions {
  baseUrl: string;
  apiKey?: string;
  allowInsecureTls?: boolean;
  timeoutMs?: number;
}

export class PortainerApiError extends Error {
  status?: number;
  code?: string;
  details?: unknown;

  constructor(message: string, options?: { status?: number; code?: string; details?: unknown }) {
    super(message);
    this.name = 'PortainerApiError';
    this.status = options?.status;
    this.code = options?.code;
    this.details = options?.details;
  }
}

export interface RawPortainerGitAuth {
  Username?: string;
  Password?: string;
  GitCredentialID?: number;
}

export interface RawPortainerGitConfig {
  URL?: string;
  ReferenceName?: string;
  ConfigFilePath?: string;
  ConfigHash?: string;
  Authentication?: RawPortainerGitAuth | null;
}

export interface RawPortainerDeploymentStatus {
  Status?: number;
  Time?: number;
  Message?: string;
}

export interface RawPortainerStack {
  Id: number;
  Name: string;
  EndpointId: number;
  Type?: number;
  Status?: number;
  EntryPoint?: string;
  ProjectPath?: string;
  CreationDate?: number;
  CreatedBy?: string;
  UpdateDate?: number;
  UpdatedBy?: string;
  Env?: Array<{ name?: string; value?: string }> | null;
  GitConfig?: RawPortainerGitConfig | null;
  DeploymentStatus?: RawPortainerDeploymentStatus[] | null;
}

interface RawDockerPort {
  IP?: string;
  PrivatePort?: number;
  PublicPort?: number;
  Type?: string;
}

interface RawDockerContainer {
  Id?: string;
  Names?: string[];
  Image?: string;
  State?: string;
  Status?: string;
  Created?: number;
  Labels?: Record<string, string>;
  Ports?: RawDockerPort[];
  NetworkSettings?: {
    Networks?: Record<string, { IPAddress?: string }>;
  };
}

export interface RawDockerStats {
  cpu_stats?: {
    cpu_usage?: {
      total_usage?: number;
      percpu_usage?: number[];
    };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: {
    cpu_usage?: {
      total_usage?: number;
    };
    system_cpu_usage?: number;
  };
  memory_stats?: {
    usage?: number;
    limit?: number;
    stats?: {
      inactive_file?: number;
      total_inactive_file?: number;
    };
  };
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
  blkio_stats?: {
    io_service_bytes_recursive?: Array<{ op?: string; value?: number }>;
  };
  pids_stats?: {
    current?: number;
  };
}

export function assertValidPortainerUrl(rawUrl: string): URL {
  const trimmed = String(rawUrl ?? '').trim();
  if (!trimmed) {
    throw new PortainerApiError('Portainer base URL is required', { code: 'INVALID_URL' });
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new PortainerApiError('Portainer base URL is invalid', { code: 'INVALID_URL' });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new PortainerApiError('Portainer base URL must use http or https', { code: 'INVALID_URL' });
  }
  if (parsed.username || parsed.password) {
    throw new PortainerApiError('Portainer base URL must not embed credentials', { code: 'INVALID_URL' });
  }
  return parsed;
}

export function assertPositiveInt(value: ID | null | undefined, label: string): number {
  const num = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isSafeInteger(num) || num <= 0) {
    throw new PortainerApiError(`${label} must be a positive integer`, { code: 'INVALID_PARAM' });
  }
  return num;
}

export function assertValidWebhookId(rawWebhookId: string | null | undefined): string {
  const trimmed = String(rawWebhookId ?? '').trim();
  if (!trimmed || !/^[A-Za-z0-9_-]{8,128}$/.test(trimmed)) {
    throw new PortainerApiError('Webhook token must be 8-128 alphanumeric, dash, or underscore characters', {
      code: 'INVALID_WEBHOOK',
    });
  }
  return trimmed;
}

export function assertValidContainerId(rawContainerId: string | null | undefined): string {
  const trimmed = String(rawContainerId ?? '').trim();
  if (!trimmed || !/^[a-fA-F0-9]{12,64}$/.test(trimmed)) {
    throw new PortainerApiError('Container ID must be a 12-64 character hexadecimal identifier', {
      code: 'INVALID_PARAM',
    });
  }
  return trimmed;
}

export function computeDockerContainerStats(raw: RawDockerStats | null | undefined): PortainerContainerStats {
  const cpuTotal = Number(raw?.cpu_stats?.cpu_usage?.total_usage ?? 0);
  const preCpuTotal = Number(raw?.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const sysCpu = Number(raw?.cpu_stats?.system_cpu_usage ?? 0);
  const preSysCpu = Number(raw?.precpu_stats?.system_cpu_usage ?? 0);
  const cpuDelta = cpuTotal - preCpuTotal;
  const sysDelta = sysCpu - preSysCpu;
  const perCpu = raw?.cpu_stats?.cpu_usage?.percpu_usage;
  const onlineCpus = Number(raw?.cpu_stats?.online_cpus ?? 0) || (Array.isArray(perCpu) ? perCpu.length : 0) || 1;
  const cpuPercent =
    cpuDelta > 0 && sysDelta > 0
      ? Math.round(((cpuDelta / sysDelta) * onlineCpus * 100 + Number.EPSILON) * 100) / 100
      : 0;

  const rawMemUsage = Number(raw?.memory_stats?.usage ?? 0);
  const inactiveFile = Number(
    raw?.memory_stats?.stats?.inactive_file ?? raw?.memory_stats?.stats?.total_inactive_file ?? 0,
  );
  const memUsageBytes = Math.max(0, rawMemUsage - inactiveFile);
  const memLimitBytes = Math.max(0, Number(raw?.memory_stats?.limit ?? 0));
  const memPercent =
    memLimitBytes > 0 ? Math.round(((memUsageBytes / memLimitBytes) * 100 + Number.EPSILON) * 100) / 100 : 0;

  let netRxBytes = 0;
  let netTxBytes = 0;
  if (raw?.networks && typeof raw.networks === 'object') {
    for (const iface of Object.values(raw.networks)) {
      netRxBytes += Math.max(0, Number(iface?.rx_bytes ?? 0));
      netTxBytes += Math.max(0, Number(iface?.tx_bytes ?? 0));
    }
  }

  let blockReadBytes = 0;
  let blockWriteBytes = 0;
  const ioEntries = raw?.blkio_stats?.io_service_bytes_recursive;
  if (Array.isArray(ioEntries)) {
    for (const entry of ioEntries) {
      const op = String(entry?.op ?? '').toLowerCase();
      const val = Math.max(0, Number(entry?.value ?? 0));
      if (op === 'read') {
        blockReadBytes += val;
      } else if (op === 'write') {
        blockWriteBytes += val;
      }
    }
  }

  const pids = Math.max(0, Number(raw?.pids_stats?.current ?? 0));

  return {
    cpuPercent,
    memUsageBytes,
    memLimitBytes,
    memPercent,
    netRxBytes,
    netTxBytes,
    blockReadBytes,
    blockWriteBytes,
    pids,
  };
}

/**
 * Strip Docker Engine's 8-byte multiplexed stdout/stderr frame headers when present (`Tty: false`),
 * falling back cleanly to plain UTF-8 text (`Tty: true`).
 */
export function demuxDockerLogBuffer(buf: Buffer): string {
  if (!buf || buf.length === 0) {
    return '';
  }
  const looksMultiplexed =
    buf.length >= 8 && (buf[0] === 0 || buf[0] === 1 || buf[0] === 2) && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;

  if (!looksMultiplexed) {
    return buf.toString('utf8');
  }

  const parts: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const streamType = buf[offset];
    if (
      (streamType !== 0 && streamType !== 1 && streamType !== 2) ||
      buf[offset + 1] !== 0 ||
      buf[offset + 2] !== 0 ||
      buf[offset + 3] !== 0
    ) {
      parts.push(buf.subarray(offset));
      break;
    }
    const frameLen = buf.readUInt32BE(offset + 4);
    const payloadStart = offset + 8;
    const payloadEnd = Math.min(buf.length, payloadStart + frameLen);
    parts.push(buf.subarray(payloadStart, payloadEnd));
    offset = payloadEnd;
  }

  return Buffer.concat(parts).toString('utf8');
}

export function clampTimeoutMs(timeoutMs?: number | null, fallback = DEFAULT_TIMEOUT_MS): number {
  const num = Number(timeoutMs);
  if (!Number.isFinite(num) || num <= 0) {
    return fallback;
  }
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(num)));
}

function normalizeEnvArray(raw?: Array<{ name?: string; value?: string }> | null): PortainerEnvPair[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const pairs: PortainerEnvPair[] = [];
  for (const item of raw) {
    const name = String(item?.name ?? '').trim();
    if (!name) {
      continue;
    }
    pairs.push({ name, value: String(item?.value ?? '') });
  }
  return pairs;
}

export function toStackSummary(stack: RawPortainerStack): PortainerStackSummary {
  const env = normalizeEnvArray(stack.Env);
  const git = stack.GitConfig;
  return {
    id: Number(stack.Id),
    name: String(stack.Name ?? ''),
    endpointId: Number(stack.EndpointId),
    type: Number(stack.Type ?? 2),
    status: Number(stack.Status ?? 1),
    isGitStack: Boolean(git && git.URL),
    gitRepoUrl: git?.URL ? String(git.URL) : undefined,
    gitReference: git?.ReferenceName ? String(git.ReferenceName) : undefined,
    envCount: env.length,
  };
}

export function toStackDetail(stack: RawPortainerStack): PortainerStackDetail {
  const summary = toStackSummary(stack);
  const git = stack.GitConfig;
  const auth = git?.Authentication;
  const credId = Number(auth?.GitCredentialID ?? 0);
  const deployments: PortainerDeploymentRecord[] | undefined = Array.isArray(stack.DeploymentStatus)
    ? stack.DeploymentStatus.map((item) => ({
        status: Number(item?.Status ?? 0),
        time: typeof item?.Time === 'number' && item.Time > 0 ? item.Time : undefined,
        message: item?.Message ? String(item.Message) : undefined,
      }))
    : undefined;

  return {
    ...summary,
    env: normalizeEnvArray(stack.Env),
    hasSavedGitCredential: credId > 0,
    gitCredentialId: credId > 0 ? credId : 0,
    gitUsername: auth?.Username ? String(auth.Username) : undefined,
    entryPoint: stack.EntryPoint ? String(stack.EntryPoint) : undefined,
    projectPath: stack.ProjectPath ? String(stack.ProjectPath) : undefined,
    createdAt: typeof stack.CreationDate === 'number' && stack.CreationDate > 0 ? stack.CreationDate : undefined,
    createdBy: stack.CreatedBy ? String(stack.CreatedBy) : undefined,
    updatedAt: typeof stack.UpdateDate === 'number' && stack.UpdateDate > 0 ? stack.UpdateDate : undefined,
    updatedBy: stack.UpdatedBy ? String(stack.UpdatedBy) : undefined,
    gitConfigFilePath: git?.ConfigFilePath ? String(git.ConfigFilePath) : undefined,
    gitCommitHash: git?.ConfigHash ? String(git.ConfigHash) : undefined,
    deployments,
  };
}

export class PortainerClient {
  private readonly baseUrl: URL;
  private readonly apiKey: string;
  private readonly allowInsecureTls: boolean;
  private readonly timeoutMs: number;

  constructor(options: PortainerClientOptions) {
    this.baseUrl = assertValidPortainerUrl(options.baseUrl);
    this.apiKey = String(options.apiKey ?? '').trim();
    this.allowInsecureTls = Boolean(options.allowInsecureTls);
    this.timeoutMs = clampTimeoutMs(options.timeoutMs);
  }

  private buildUrl(pathname: string, query?: Record<string, string | number | undefined>): URL {
    const basePath = this.baseUrl.pathname.replace(/\/+$/, '');
    const suffix = pathname.startsWith('/') ? pathname : `/${pathname}`;
    const target = new URL(this.baseUrl.toString());
    target.pathname = `${basePath}${suffix}`;
    target.search = '';
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (typeof value !== 'undefined' && value !== '') {
          target.searchParams.set(key, String(value));
        }
      }
    }
    return target;
  }

  async request<TResponse>(options: {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;
    query?: Record<string, string | number | undefined>;
    body?: unknown;
    timeoutMs?: number;
    skipAuth?: boolean;
    rawBuffer?: boolean;
    signal?: AbortSignal;
  }): Promise<TResponse> {
    if (!options.skipAuth && !this.apiKey) {
      throw new PortainerApiError('Portainer API key is required', { code: 'MISSING_API_KEY' });
    }
    const targetUrl = this.buildUrl(options.path, options.query);
    const payload = typeof options.body !== 'undefined' ? Buffer.from(JSON.stringify(options.body), 'utf8') : null;
    const timeout = clampTimeoutMs(options.timeoutMs, this.timeoutMs);

    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (!options.skipAuth) {
      headers['X-API-Key'] = this.apiKey;
    }
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.byteLength);
    }

    const transport = targetUrl.protocol === 'https:' ? https : http;

    return new Promise<TResponse>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new PortainerApiError('Portainer request aborted', { code: 'ECONNABORTED' }));
        return;
      }

      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (options.signal) {
          options.signal.removeEventListener('abort', onAbort);
        }
        fn();
      };

      const req = transport.request(
        targetUrl,
        {
          method: options.method,
          headers,
          timeout,
          ...(targetUrl.protocol === 'https:' ? { rejectUnauthorized: !this.allowInsecureTls } : {}),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          res.on('end', () => {
            const fullBuffer = Buffer.concat(chunks);
            const status = res.statusCode ?? 500;
            if (status >= 200 && status < 300 && options.rawBuffer) {
              finish(() => resolve(fullBuffer as unknown as TResponse));
              return;
            }
            const rawText = fullBuffer.toString('utf8');
            let parsedBody: unknown = rawText;
            if (rawText.trim()) {
              try {
                parsedBody = JSON.parse(rawText);
              } catch {
                parsedBody = rawText;
              }
            } else {
              parsedBody = null;
            }

            if (status >= 200 && status < 300) {
              finish(() => resolve(parsedBody as TResponse));
              return;
            }

            const bodyObj =
              typeof parsedBody === 'object' && parsedBody !== null ? (parsedBody as Record<string, unknown>) : null;
            const remoteMessage =
              (typeof bodyObj?.message === 'string' && bodyObj.message) ||
              (typeof bodyObj?.details === 'string' && bodyObj.details) ||
              (typeof parsedBody === 'string' && parsedBody.slice(0, 300)) ||
              `Portainer responded with HTTP ${status}`;

            finish(() =>
              reject(
                new PortainerApiError(remoteMessage, {
                  status,
                  code: `HTTP_${status}`,
                  details: bodyObj ?? undefined,
                }),
              ),
            );
          });
        },
      );

      function onAbort() {
        req.destroy();
        finish(() => reject(new PortainerApiError('Portainer request aborted', { code: 'ECONNABORTED' })));
      }

      if (options.signal) {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      req.on('timeout', () => {
        req.destroy();
        finish(() =>
          reject(new PortainerApiError(`Portainer request timed out after ${timeout}ms`, { code: 'ECONNABORTED' })),
        );
      });

      req.on('error', (err: NodeJS.ErrnoException) => {
        const safeMsg = (err.message || 'Network error calling Portainer').replace(this.apiKey || '__none__', '***');
        finish(() => reject(new PortainerApiError(safeMsg, { code: err.code || 'NETWORK_ERROR' })));
      });

      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }

  async getStatus(signal?: AbortSignal): Promise<{ Version?: string; InstanceID?: string }> {
    return this.request<{ Version?: string; InstanceID?: string }>({
      method: 'GET',
      path: '/api/status',
      signal,
    });
  }

  async listEndpoints(signal?: AbortSignal): Promise<PortainerEndpointSummary[]> {
    const raw = await this.request<Array<Record<string, unknown>>>({
      method: 'GET',
      path: '/api/endpoints',
      signal,
    });
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.map((item) => ({
      id: Number(item.Id),
      name: String(item.Name ?? `Endpoint #${item.Id}`),
      type: Number(item.Type ?? 1),
      status: Number(item.Status ?? 1),
      url: typeof item.URL === 'string' ? item.URL : undefined,
    }));
  }

  async listStacks(endpointId?: number | null, signal?: AbortSignal): Promise<PortainerStackSummary[]> {
    const query = endpointId && endpointId > 0 ? { filters: JSON.stringify({ EndpointID: endpointId }) } : undefined;
    const raw = await this.request<RawPortainerStack[]>({
      method: 'GET',
      path: '/api/stacks',
      query,
      signal,
    });
    if (!Array.isArray(raw)) {
      return [];
    }
    const mapped = raw.map(toStackSummary);
    return endpointId && endpointId > 0 ? mapped.filter((item) => item.endpointId === endpointId) : mapped;
  }

  async getRawStack(stackId: number, signal?: AbortSignal): Promise<RawPortainerStack> {
    const validId = assertPositiveInt(stackId, 'Stack ID');
    return this.request<RawPortainerStack>({
      method: 'GET',
      path: `/api/stacks/${encodeURIComponent(String(validId))}`,
      signal,
    });
  }

  async getStackDetail(stackId: number, signal?: AbortSignal): Promise<PortainerStackDetail> {
    const raw = await this.getRawStack(stackId, signal);
    return toStackDetail(raw);
  }

  async getStackFile(stackId: number, signal?: AbortSignal): Promise<string> {
    const validId = assertPositiveInt(stackId, 'Stack ID');
    const res = await this.request<{ StackFileContent?: string }>({
      method: 'GET',
      path: `/api/stacks/${encodeURIComponent(String(validId))}/file`,
      signal,
    });
    return String(res?.StackFileContent ?? '');
  }

  async redeployGitStack(
    stackId: number,
    endpointId: number,
    payload: {
      env: PortainerEnvPair[];
      prune: boolean;
      repullImage: boolean;
      repositoryReferenceName: string;
      repositoryAuthentication: boolean;
      repositoryGitCredentialID?: number;
      repositoryUsername?: string;
      repositoryPassword?: string;
    },
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<RawPortainerStack> {
    const validStackId = assertPositiveInt(stackId, 'Stack ID');
    const validEndpointId = assertPositiveInt(endpointId, 'Environment (Endpoint) ID');
    return this.request<RawPortainerStack>({
      method: 'PUT',
      path: `/api/stacks/${encodeURIComponent(String(validStackId))}/git/redeploy`,
      query: { endpointId: validEndpointId },
      body: {
        env: payload.env,
        prune: payload.prune,
        pullImage: payload.repullImage,
        repullImageAndRedeploy: payload.repullImage,
        repositoryReferenceName: payload.repositoryReferenceName,
        repositoryAuthentication: payload.repositoryAuthentication,
        ...(payload.repositoryGitCredentialID && payload.repositoryGitCredentialID > 0
          ? { repositoryGitCredentialID: payload.repositoryGitCredentialID }
          : {}),
        ...(payload.repositoryUsername ? { repositoryUsername: payload.repositoryUsername } : {}),
        ...(payload.repositoryPassword ? { repositoryPassword: payload.repositoryPassword } : {}),
      },
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
  }

  async updateComposeStack(
    stackId: number,
    endpointId: number,
    payload: {
      stackFileContent: string;
      env: PortainerEnvPair[];
      prune: boolean;
      repullImage: boolean;
    },
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<RawPortainerStack> {
    const validStackId = assertPositiveInt(stackId, 'Stack ID');
    const validEndpointId = assertPositiveInt(endpointId, 'Environment (Endpoint) ID');
    return this.request<RawPortainerStack>({
      method: 'PUT',
      path: `/api/stacks/${encodeURIComponent(String(validStackId))}`,
      query: { endpointId: validEndpointId },
      body: {
        stackFileContent: payload.stackFileContent,
        env: payload.env,
        prune: payload.prune,
        pullImage: payload.repullImage,
      },
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
  }

  async triggerWebhook(
    webhookId: string,
    tag?: string | null,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<unknown> {
    const validWebhook = assertValidWebhookId(webhookId);
    const trimmedTag = String(tag ?? '').trim();
    return this.request<unknown>({
      method: 'POST',
      path: `/api/stacks/webhooks/${encodeURIComponent(validWebhook)}`,
      query: trimmedTag ? { tag: trimmedTag } : undefined,
      skipAuth: true,
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
  }

  async startStack(stackId: number, endpointId: number, signal?: AbortSignal): Promise<RawPortainerStack> {
    const validStackId = assertPositiveInt(stackId, 'Stack ID');
    const validEndpointId = assertPositiveInt(endpointId, 'Environment (Endpoint) ID');
    return this.request<RawPortainerStack>({
      method: 'POST',
      path: `/api/stacks/${encodeURIComponent(String(validStackId))}/start`,
      query: { endpointId: validEndpointId },
      signal,
    });
  }

  async stopStack(stackId: number, endpointId: number, signal?: AbortSignal): Promise<RawPortainerStack> {
    const validStackId = assertPositiveInt(stackId, 'Stack ID');
    const validEndpointId = assertPositiveInt(endpointId, 'Environment (Endpoint) ID');
    return this.request<RawPortainerStack>({
      method: 'POST',
      path: `/api/stacks/${encodeURIComponent(String(validStackId))}/stop`,
      query: { endpointId: validEndpointId },
      signal,
    });
  }

  /**
   * Wait until an asynchronous Portainer deployment (`Status === 3`, Deploying) settles into Active (`1`),
   * Inactive (`2`), or Error (`4`), throwing `PortainerApiError` when deployment fails.
   */
  async waitForStackSettlement(
    stackId: number,
    initialStack: RawPortainerStack,
    options?: { timeoutMs?: number; pollIntervalMs?: number; signal?: AbortSignal },
  ): Promise<RawPortainerStack> {
    let current = initialStack;
    const timeout = clampTimeoutMs(options?.timeoutMs, this.timeoutMs);
    const pollInterval = Math.max(50, options?.pollIntervalMs ?? 1500);
    const deadline = Date.now() + timeout;

    while (Number(current?.Status) === 3) {
      if (options?.signal?.aborted) {
        throw new PortainerApiError('Portainer stack deployment aborted', { code: 'ECONNABORTED' });
      }
      if (Date.now() >= deadline) {
        throw new PortainerApiError(`Timed out waiting for Portainer Stack #${stackId} deployment after ${timeout}ms`, {
          code: 'ECONNABORTED',
        });
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          options?.signal?.removeEventListener('abort', onAbort);
          resolve();
        }, pollInterval);
        function onAbort() {
          clearTimeout(timer);
          reject(new PortainerApiError('Portainer stack deployment aborted', { code: 'ECONNABORTED' }));
        }
        options?.signal?.addEventListener('abort', onAbort, { once: true });
      });
      current = await this.getRawStack(stackId, options?.signal);
    }

    if (Number(current?.Status) === 4) {
      const entries = Array.isArray(current.DeploymentStatus) ? current.DeploymentStatus : [];
      const lastError = [...entries].reverse().find((item) => item?.Status === 4 && item?.Message);
      const message = lastError?.Message
        ? `Portainer deployment failed: ${lastError.Message}`
        : `Portainer Stack #${stackId} entered error status`;
      throw new PortainerApiError(message, { code: 'DEPLOYMENT_FAILED', status: 502 });
    }

    return current;
  }

  async listStackContainers(
    endpointId: number,
    stackName: string,
    signal?: AbortSignal,
  ): Promise<PortainerContainerSummary[]> {
    const validEndpointId = assertPositiveInt(endpointId, 'Environment (Endpoint) ID');
    const trimmedName = String(stackName ?? '').trim();
    if (!trimmedName) {
      return [];
    }
    const filters = JSON.stringify({
      label: [`com.docker.compose.project=${trimmedName}`],
    });
    const raw = await this.request<RawDockerContainer[]>({
      method: 'GET',
      path: `/api/endpoints/${encodeURIComponent(String(validEndpointId))}/docker/containers/json`,
      query: { all: 1, filters },
      signal,
    });
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.map((container) => {
      const state = String(container.State ?? 'unknown').toLowerCase();
      const status = String(container.Status ?? '');
      const unhealthy = /\(unhealthy\)/i.test(status) || state === 'restarting' || state === 'dead';
      const firstName = Array.isArray(container.Names) && container.Names[0] ? container.Names[0] : '';
      const service = container.Labels?.['com.docker.compose.service'];

      const portsSet = new Set<string>();
      if (Array.isArray(container.Ports)) {
        for (const p of container.Ports) {
          const proto = p.Type || 'tcp';
          if (p.PublicPort && p.PrivatePort) {
            const hostPrefix = p.IP ? `${p.IP}:` : '';
            portsSet.add(`${hostPrefix}${p.PublicPort}->${p.PrivatePort}/${proto}`);
          } else if (p.PrivatePort) {
            portsSet.add(`${p.PrivatePort}/${proto}`);
          }
        }
      }

      const ipAddresses: string[] = [];
      if (container.NetworkSettings?.Networks && typeof container.NetworkSettings.Networks === 'object') {
        for (const net of Object.values(container.NetworkSettings.Networks)) {
          if (net?.IPAddress && !ipAddresses.includes(net.IPAddress)) {
            ipAddresses.push(net.IPAddress);
          }
        }
      }

      return {
        id: String(container.Id ?? '').slice(0, 12),
        name: firstName.replace(/^\/+/, ''),
        service: service ? String(service) : undefined,
        image: String(container.Image ?? ''),
        state,
        status,
        healthy: state === 'running' && !unhealthy,
        created: typeof container.Created === 'number' && container.Created > 0 ? container.Created : undefined,
        ports: Array.from(portsSet),
        ipAddresses,
      };
    });
  }

  async getContainerLiveStats(
    endpointId: number,
    containerId: string,
    signal?: AbortSignal,
  ): Promise<PortainerContainerStats> {
    const validEndpointId = assertPositiveInt(endpointId, 'Environment (Endpoint) ID');
    const validContainerId = assertValidContainerId(containerId);
    const raw = await this.request<RawDockerStats>({
      method: 'GET',
      path: `/api/endpoints/${encodeURIComponent(String(validEndpointId))}/docker/containers/${encodeURIComponent(
        validContainerId,
      )}/stats`,
      query: { stream: 'false' },
      timeoutMs: 10_000,
      signal,
    });
    return computeDockerContainerStats(raw);
  }

  async getContainerLogs(endpointId: number, containerId: string, tail = 100, signal?: AbortSignal): Promise<string> {
    const validEndpointId = assertPositiveInt(endpointId, 'Environment (Endpoint) ID');
    const validContainerId = assertValidContainerId(containerId);
    const clampedTail = Math.min(1000, Math.max(10, Math.trunc(Number(tail) || 100)));
    const buf = await this.request<Buffer>({
      method: 'GET',
      path: `/api/endpoints/${encodeURIComponent(String(validEndpointId))}/docker/containers/${encodeURIComponent(
        validContainerId,
      )}/logs`,
      query: {
        stdout: 1,
        stderr: 1,
        tail: clampedTail,
        timestamps: 1,
      },
      rawBuffer: true,
      timeoutMs: 15_000,
      signal,
    });
    return demuxDockerLogBuffer(buf);
  }
}

export function summarizeContainersHealth(containers: PortainerContainerSummary[]) {
  const totalCount = containers.length;
  const runningCount = containers.filter((c) => c.state === 'running').length;
  const healthy = totalCount > 0 && containers.every((c) => c.healthy);
  return { totalCount, runningCount, healthy };
}
