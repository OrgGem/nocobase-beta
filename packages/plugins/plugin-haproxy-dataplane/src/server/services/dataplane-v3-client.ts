// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {
  DEFAULT_TIMEOUT_MS,
  MAX_SERVER_WEIGHT,
  MAX_TIMEOUT_MS,
  MIN_SERVER_WEIGHT,
  MIN_TIMEOUT_MS,
  VALID_ADMIN_STATES,
} from '../../shared/constants';
import type {
  ConfigMutationMeta,
  DataplaneApiInfo,
  HaproxyAclConfig,
  HaproxyAdminState,
  HaproxyAuthType,
  HaproxyBackendConfig,
  HaproxyBackendSwitchingRule,
  HaproxyBindConfig,
  HaproxyDefaultsConfig,
  HaproxyFrontendConfig,
  HaproxyHttpRequestRule,
  HaproxyMergedServerRow,
  HaproxyNodeSnapshot,
  HaproxyProcessSummary,
  HaproxyRawConfigResponse,
  HaproxyReload,
  HaproxyRuntimeMapEntry,
  HaproxyRuntimeServer,
  HaproxyServerConfig,
  HaproxySslCertificate,
  HaproxyStatEntityType,
  HaproxyStatRow,
  HaproxyStickTable,
  HaproxyStickTableEntry,
  HaproxyStorageFile,
  HaproxyTransaction,
} from '../../shared/types';

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const BLOCKED_METADATA_HOSTS = new Set(['169.254.169.254', 'fd00:ec2::254', 'metadata.google.internal']);
const ENTITY_NAME_REGEX = /^[^\s/\\?#]{1,255}$/;
const STORAGE_FILE_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._@-]{0,250}$/;

export interface DataplaneV3ClientConfig {
  baseUrl: string;
  authType: HaproxyAuthType;
  username?: string;
  password?: string;
  tlsSkipVerify?: boolean;
  timeoutMs?: number;
}

export interface ConfigWriteOptions {
  transactionId?: string;
  version?: number;
  forceReload?: boolean;
}

export interface StorageWriteOptions {
  forceReload?: boolean;
  skipReload?: boolean;
}

interface RawHttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  bodyText: string;
}

export class DataplaneApiError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = 'DataplaneApiError';
    this.status = status;
  }
}

function createValidationError(message: string): DataplaneApiError {
  return new DataplaneApiError(message, 400);
}

export function normalizeDataplaneV3BaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw createValidationError('Data Plane API Base URL is required');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw createValidationError('Data Plane API Base URL must be a valid http:// or https:// URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw createValidationError('Data Plane API Base URL must use http:// or https://');
  }
  if (parsed.username || parsed.password) {
    throw createValidationError('Embed credentials in connection fields, not inside Base URL');
  }
  if (parsed.search || parsed.hash) {
    throw createValidationError('Data Plane API Base URL must not contain query parameters or fragments');
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (BLOCKED_METADATA_HOSTS.has(hostname)) {
    throw createValidationError('Cloud metadata endpoints are not allowed as Data Plane API targets');
  }
  const cleanPath = parsed.pathname.replace(/\/+$/, '');
  if (/\/v[12]$/i.test(cleanPath)) {
    throw createValidationError('Only HAProxy Data Plane API v3 (/v3) is supported');
  }
  const v3Path = cleanPath.endsWith('/v3') ? cleanPath : `${cleanPath}/v3`;
  return `${parsed.origin}${v3Path}`;
}

export function clampTimeoutMs(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(num)));
}

function hasControlChar(text: string): boolean {
  return Array.from(text).some((ch) => {
    const code = ch.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

export function assertValidEntityName(value: string, label: string): string {
  const trimmed = value.trim();
  if (!ENTITY_NAME_REGEX.test(trimmed) || hasControlChar(trimmed)) {
    throw createValidationError(`Invalid HAProxy ${label} name`);
  }
  return trimmed;
}

function assertValidBackendSwitchingTarget(value: string): string {
  const trimmed = String(value ?? '').trim();
  if (!trimmed || trimmed.length > 512 || hasControlChar(trimmed)) {
    throw createValidationError('Invalid HAProxy target backend name');
  }
  return trimmed;
}

export function assertSafeStorageFileName(value: string, label = 'file'): string {
  const trimmed = value.trim();
  if (!STORAGE_FILE_REGEX.test(trimmed) || trimmed.includes('..') || hasControlChar(trimmed)) {
    throw createValidationError(`Invalid storage ${label} name`);
  }
  return trimmed;
}

function buildMultipartFileUpload(
  fileName: string,
  content: string,
  partContentType = 'text/plain',
): { body: Buffer; contentType: string } {
  const safeName = assertSafeStorageFileName(fileName);
  const boundary = `----NocoBaseHaproxyBoundary${crypto.randomBytes(12).toString('hex')}`;
  const preamble = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file_upload"; filename="${safeName}"\r\nContent-Type: ${partContentType}\r\n\r\n`,
    'utf8',
  );
  const fileBytes = Buffer.from(content, 'utf8');
  const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    body: Buffer.concat([preamble, fileBytes, epilogue]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asNumber(value: unknown, fallback = 0): number {
  return asNumberOrNull(value) ?? fallback;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function headerFirst(headers: http.IncomingHttpHeaders, key: string): string | null {
  const raw = headers[key.toLowerCase()];
  if (Array.isArray(raw)) {
    return raw[0] ?? null;
  }
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function extractMutationMeta(res: RawHttpResult): ConfigMutationMeta {
  return {
    status: res.status,
    reloadId: headerFirst(res.headers, 'reload-id'),
    configurationVersion: asNumberOrNull(headerFirst(res.headers, 'configuration-version')),
  };
}

function parseAddressAndPort(addr: string | null): { address: string | null; port: number | null } {
  if (!addr) {
    return { address: null, port: null };
  }
  const ipv6Match = addr.match(/^\[([^\]]+)\]:(\d+)$/);
  if (ipv6Match) {
    return { address: ipv6Match[1], port: Number(ipv6Match[2]) };
  }
  const lastColon = addr.lastIndexOf(':');
  if (lastColon > 0 && addr.indexOf(':') === lastColon) {
    const portNum = Number(addr.slice(lastColon + 1));
    if (Number.isInteger(portNum) && portNum > 0) {
      return { address: addr.slice(0, lastColon), port: portNum };
    }
  }
  return { address: addr, port: null };
}

export function parseDataplaneInfo(raw: unknown): DataplaneApiInfo {
  const root = asRecord(raw);
  const api = asRecord(root?.api);
  const system = asRecord(root?.system);
  return {
    apiVersion: asStringOrNull(api?.version),
    buildDate: asStringOrNull(api?.build_date),
    hostname: asStringOrNull(system?.hostname),
    osString: asStringOrNull(system?.os_string),
    systemUptime: asNumberOrNull(system?.uptime),
  };
}

export function parseProcessInfo(raw: unknown): HaproxyProcessSummary {
  const root = asRecord(raw);
  const info = asRecord(root?.info) ?? asRecord(root?.data);
  return {
    runtimeApi: asStringOrNull(root?.runtimeAPI),
    error: asStringOrNull(root?.error),
    version: asStringOrNull(info?.version),
    uptime: asNumberOrNull(info?.uptime),
    pid: asNumberOrNull(info?.pid),
    nbthread: asNumberOrNull(info?.nbthread),
    currConns: asNumberOrNull(info?.curr_conns),
    cumConns: asNumberOrNull(info?.cum_conns) ?? asNumberOrNull(info?.cum_conn),
    connRate: asNumberOrNull(info?.conn_rate),
    maxConn: asNumberOrNull(info?.max_conn),
    currSslConns: asNumberOrNull(info?.curr_ssl_conns),
    bytesOutRate: asNumberOrNull(info?.bytes_out_rate),
  };
}

export function parseNativeStats(raw: unknown): { statsError: string | null; rows: HaproxyStatRow[] } {
  const root = asRecord(raw);
  const statsError = asStringOrNull(root?.error);
  const list = Array.isArray(root?.stats) ? root.stats : Array.isArray(raw) ? raw : [];
  const rows: HaproxyStatRow[] = [];

  for (const item of list) {
    const entry = asRecord(item);
    if (!entry) continue;
    const rawType = String(entry.type ?? '').toLowerCase();
    if (rawType !== 'frontend' && rawType !== 'backend' && rawType !== 'server') {
      continue;
    }
    const entityType = rawType as HaproxyStatEntityType;
    const name = asStringOrNull(entry.name);
    if (!name) continue;
    const backendName = asStringOrNull(entry.backend_name);
    const s = asRecord(entry.stats) ?? entry;

    rows.push({
      key: `${entityType}:${backendName ?? ''}:${name}`,
      type: entityType,
      name,
      backendName,
      status: asStringOrNull(s.status) ?? 'UNKNOWN',
      mode: asStringOrNull(s.mode),
      algo: asStringOrNull(s.algo),
      addr: asStringOrNull(s.addr),
      weight: asNumberOrNull(s.weight),
      act: asNumberOrNull(s.act),
      bck: asNumberOrNull(s.bck),
      scur: asNumber(s.scur),
      smax: asNumber(s.smax),
      slim: asNumberOrNull(s.slim),
      stot: asNumber(s.stot),
      reqRate: asNumberOrNull(s.req_rate),
      reqTot: asNumberOrNull(s.req_tot),
      bin: asNumber(s.bin),
      bout: asNumber(s.bout),
      hrsp2xx: asNumber(s.hrsp_2xx),
      hrsp4xx: asNumber(s.hrsp_4xx),
      hrsp5xx: asNumber(s.hrsp_5xx),
      econ: asNumber(s.econ),
      eresp: asNumber(s.eresp),
      ereq: asNumber(s.ereq),
      qcur: asNumber(s.qcur),
      rtime: asNumberOrNull(s.rtime),
      ttime: asNumberOrNull(s.ttime),
      checkStatus: asStringOrNull(s.check_status),
      checkCode: asNumberOrNull(s.check_code),
      checkDuration: asNumberOrNull(s.check_duration),
      lastchg: asNumberOrNull(s.lastchg),
      downtime: asNumberOrNull(s.downtime),
    });
  }

  return { statsError, rows };
}

export function parseRuntimeServer(raw: unknown, fallbackBackend: string): HaproxyRuntimeServer | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const name = asStringOrNull(rec.name);
  if (!name) return null;
  return {
    id: asStringOrNull(rec.id),
    name,
    backendName: asStringOrNull(rec.backend_name) ?? fallbackBackend,
    address: asStringOrNull(rec.address),
    port: asNumberOrNull(rec.port),
    adminState: asStringOrNull(rec.admin_state) ?? 'ready',
    operationalState: asStringOrNull(rec.operational_state) ?? 'up',
    weight: asNumberOrNull(rec.weight),
    uweight: asNumberOrNull(rec.uweight),
    iweight: asNumberOrNull(rec.iweight),
    useSsl: typeof rec.use_ssl === 'boolean' ? rec.use_ssl : null,
    lastTimeChange: asNumberOrNull(rec.last_time_change),
  };
}

function inferStatesFromStatus(status: string): { adminState: string; operationalState: string } {
  const upper = status.toUpperCase();
  if (upper.startsWith('MAINT')) {
    return { adminState: 'maint', operationalState: upper.includes('UP') ? 'up' : 'down' };
  }
  if (upper.startsWith('DRAIN')) {
    return { adminState: 'drain', operationalState: 'stopping' };
  }
  if (upper.startsWith('DOWN')) {
    return { adminState: 'ready', operationalState: 'down' };
  }
  return { adminState: 'ready', operationalState: 'up' };
}

function unwrapArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) {
    return raw as T[];
  }
  const rec = asRecord(raw);
  if (Array.isArray(rec?.data)) {
    return rec.data as T[];
  }
  return [];
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

export class DataplaneV3Client {
  private readonly baseV3Url: string;
  private readonly authType: HaproxyAuthType;
  private readonly username: string;
  private readonly password: string;
  private readonly tlsSkipVerify: boolean;
  private readonly timeoutMs: number;

  constructor(config: DataplaneV3ClientConfig) {
    this.baseV3Url = normalizeDataplaneV3BaseUrl(config.baseUrl);
    this.authType = config.authType === 'none' ? 'none' : 'basic';
    this.username = config.username ?? '';
    this.password = config.password ?? '';
    this.tlsSkipVerify = Boolean(config.tlsSkipVerify);
    this.timeoutMs = clampTimeoutMs(config.timeoutMs);
  }

  private sendRaw(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    subPath: string,
    options?: {
      query?: Record<string, string | undefined>;
      body?: Buffer;
      contentType?: string;
      accept?: string;
    },
  ): Promise<RawHttpResult> {
    const target = new URL(`${this.baseV3Url}${subPath}`);
    if (options?.query) {
      for (const [k, v] of Object.entries(options.query)) {
        if (v !== undefined && v !== '') {
          target.searchParams.set(k, v);
        }
      }
    }

    const headers: Record<string, string> = {
      Accept: options?.accept ?? 'application/json',
    };
    if (options?.body) {
      headers['Content-Type'] = options.contentType ?? 'application/json';
      headers['Content-Length'] = String(options.body.byteLength);
    }
    if (this.authType === 'basic') {
      const token = Buffer.from(`${this.username}:${this.password}`, 'utf8').toString('base64');
      headers.Authorization = `Basic ${token}`;
    }

    const isHttps = target.protocol === 'https:';
    const transport = isHttps ? https : http;

    return new Promise<RawHttpResult>((resolve, reject) => {
      const req = transport.request(
        target,
        {
          method,
          headers,
          timeout: this.timeoutMs,
          ...(isHttps ? { rejectUnauthorized: !this.tlsSkipVerify } : {}),
        },
        (res) => {
          const status = res.statusCode ?? 502;
          const chunks: Buffer[] = [];
          let received = 0;

          res.on('data', (chunk: Buffer) => {
            received += chunk.byteLength;
            if (received > MAX_RESPONSE_BYTES) {
              req.destroy(new DataplaneApiError('Data Plane API response exceeded size limit', 502));
              return;
            }
            chunks.push(chunk);
          });

          res.on('end', () => {
            const bodyText = Buffer.concat(chunks).toString('utf8');
            if (status >= 200 && status < 300) {
              resolve({ status, headers: res.headers, bodyText });
              return;
            }

            let parsedErr: Record<string, unknown> | null = null;
            if (bodyText.trim()) {
              try {
                parsedErr = asRecord(JSON.parse(bodyText));
              } catch {
                parsedErr = null;
              }
            }
            const apiMsg = asStringOrNull(parsedErr?.message) ?? (bodyText.trim().slice(0, 320) || `HTTP ${status}`);
            const mappedStatus = status === 401 || status === 403 ? 502 : status >= 400 && status < 500 ? status : 502;
            reject(new DataplaneApiError(`Data Plane API (${status}): ${apiMsg}`, mappedStatus));
          });
        },
      );

      req.on('timeout', () => {
        req.destroy(new DataplaneApiError(`Data Plane API request timed out after ${this.timeoutMs}ms`, 504));
      });

      req.on('error', (err) => {
        if (err instanceof DataplaneApiError) {
          reject(err);
          return;
        }
        reject(new DataplaneApiError(`Cannot reach Data Plane API: ${err.message}`, 502));
      });

      if (options?.body) {
        req.write(options.body);
      }
      req.end();
    });
  }

  private async requestJsonWithMeta<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    subPath: string,
    query?: Record<string, string | undefined>,
    body?: unknown,
  ): Promise<{ data: T; meta: ConfigMutationMeta }> {
    const payload = body !== undefined ? Buffer.from(JSON.stringify(body), 'utf8') : undefined;
    const res = await this.sendRaw(method, subPath, {
      query,
      body: payload,
      contentType: 'application/json',
      accept: 'application/json',
    });
    const meta = extractMutationMeta(res);
    if (!res.bodyText.trim() || res.status === 204) {
      return { data: null as unknown as T, meta };
    }
    try {
      return { data: JSON.parse(res.bodyText) as T, meta };
    } catch {
      throw new DataplaneApiError('Data Plane API returned invalid JSON', 502);
    }
  }

  private async requestJson<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    subPath: string,
    query?: Record<string, string | undefined>,
    body?: unknown,
  ): Promise<T> {
    const { data } = await this.requestJsonWithMeta<T>(method, subPath, query, body);
    return data;
  }

  private async resolveConfigWriteQuery(opts?: ConfigWriteOptions): Promise<Record<string, string | undefined>> {
    if (opts?.transactionId) {
      const safeTx = assertValidEntityName(opts.transactionId, 'transaction');
      return { transaction_id: safeTx };
    }
    const version = opts?.version !== undefined ? Number(opts.version) : await this.getConfigVersion();
    if (!Number.isInteger(version) || version < 0) {
      throw createValidationError('Valid HAProxy configuration version is required');
    }
    return {
      version: String(version),
      ...(opts?.forceReload ? { force_reload: 'true' } : {}),
    };
  }

  private buildReadConfigQuery(transactionId?: string): Record<string, string | undefined> | undefined {
    if (!transactionId) return undefined;
    return { transaction_id: assertValidEntityName(transactionId, 'transaction') };
  }

  private buildStorageWriteQuery(opts?: StorageWriteOptions): Record<string, string | undefined> {
    return {
      ...(opts?.skipReload ? { skip_reload: 'true' } : {}),
      ...(!opts?.skipReload && opts?.forceReload ? { force_reload: 'true' } : {}),
    };
  }

  // --- Core Info, Runtime & Live Stats ---

  async getInfo(): Promise<DataplaneApiInfo> {
    const raw = await this.requestJson<unknown>('GET', '/info');
    return parseDataplaneInfo(raw);
  }

  async getProcessInfo(): Promise<HaproxyProcessSummary> {
    const raw = await this.requestJson<unknown>('GET', '/services/haproxy/runtime/info');
    return parseProcessInfo(raw);
  }

  async getNativeStats(): Promise<{ statsError: string | null; rows: HaproxyStatRow[] }> {
    const raw = await this.requestJson<unknown>('GET', '/services/haproxy/stats/native');
    return parseNativeStats(raw);
  }

  async getRuntimeServers(backendName: string): Promise<HaproxyRuntimeServer[]> {
    const safeBackend = assertValidEntityName(backendName, 'backend');
    const raw = await this.requestJson<unknown>(
      'GET',
      `/services/haproxy/runtime/backends/${encodeURIComponent(safeBackend)}/servers`,
    );
    const list = unwrapArray<unknown>(raw);
    const parsed: HaproxyRuntimeServer[] = [];
    for (const item of list) {
      const server = parseRuntimeServer(item, safeBackend);
      if (server) {
        parsed.push(server);
      }
    }
    return parsed;
  }

  async updateRuntimeServer(
    backendName: string,
    serverName: string,
    patch: { adminState?: HaproxyAdminState; weight?: number; address?: string; port?: number },
  ): Promise<HaproxyRuntimeServer> {
    const safeBackend = assertValidEntityName(backendName, 'backend');
    const safeServer = assertValidEntityName(serverName, 'server');

    const body: Record<string, unknown> = {};
    if (patch.adminState !== undefined) {
      if (!(VALID_ADMIN_STATES as readonly string[]).includes(patch.adminState)) {
        throw createValidationError(`adminState must be one of: ${VALID_ADMIN_STATES.join(', ')}`);
      }
      body.admin_state = patch.adminState;
    }
    if (patch.weight !== undefined) {
      const numericWeight = Number(patch.weight);
      if (!Number.isInteger(numericWeight) || numericWeight < MIN_SERVER_WEIGHT || numericWeight > MAX_SERVER_WEIGHT) {
        throw createValidationError(
          `Server weight must be an integer between ${MIN_SERVER_WEIGHT} and ${MAX_SERVER_WEIGHT}`,
        );
      }
      body.weight = numericWeight;
    }
    if (patch.address !== undefined && patch.address.trim() !== '') {
      body.address = assertValidEntityName(patch.address, 'address');
    }
    if (patch.port !== undefined) {
      const numericPort = Number(patch.port);
      if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
        throw createValidationError('Server port must be between 1 and 65535');
      }
      body.port = numericPort;
    }
    if (Object.keys(body).length === 0) {
      throw createValidationError('At least one runtime server attribute must be provided');
    }

    const runtimePath = `/services/haproxy/runtime/backends/${encodeURIComponent(
      safeBackend,
    )}/servers/${encodeURIComponent(safeServer)}`;
    const raw = await this.requestJson<unknown>('PUT', runtimePath, undefined, body);

    let parsed = parseRuntimeServer(raw, safeBackend);

    // Data Plane API v3 runtime_server schema only mutates admin_state / operational_state and omits weight.
    // When weight is requested and runtime_server did not return weight, persist weight via configuration/backends/.../servers.
    if (patch.weight !== undefined && (!parsed || parsed.weight == null)) {
      const numericWeight = Number(patch.weight);
      const existingCfg = await this.requestJson<HaproxyServerConfig>(
        'GET',
        `/services/haproxy/configuration/backends/${encodeURIComponent(safeBackend)}/servers/${encodeURIComponent(
          safeServer,
        )}`,
      ).catch(() => null);
      if (existingCfg && typeof existingCfg === 'object' && typeof existingCfg.address === 'string') {
        await this.updateBackendServer(
          safeBackend,
          safeServer,
          { ...existingCfg, weight: numericWeight },
          { forceReload: true },
        );
        if (patch.adminState !== undefined && patch.adminState !== 'ready') {
          await new Promise((resolve) => setTimeout(resolve, 900));
          const reapplied = await this.requestJson<unknown>('PUT', runtimePath, undefined, {
            admin_state: patch.adminState,
          }).catch(() => null);
          const reparsed = reapplied ? parseRuntimeServer(reapplied, safeBackend) : null;
          if (reparsed) {
            parsed = reparsed;
          }
        }
      }
      if (parsed) {
        parsed = { ...parsed, weight: numericWeight, uweight: numericWeight };
      }
    }

    return (
      parsed ?? {
        id: null,
        name: safeServer,
        backendName: safeBackend,
        address: patch.address ?? null,
        port: patch.port ?? null,
        adminState: patch.adminState ?? 'ready',
        operationalState: 'up',
        weight: patch.weight ?? null,
        uweight: patch.weight ?? null,
        iweight: null,
        useSsl: null,
        lastTimeChange: null,
      }
    );
  }

  async addRuntimeServer(
    backendName: string,
    payload: {
      name: string;
      address: string;
      port?: number;
      weight?: number;
      check?: 'enabled' | 'disabled';
      maintenance?: 'enabled' | 'disabled';
    },
  ): Promise<Record<string, unknown>> {
    const safeBackend = assertValidEntityName(backendName, 'backend');
    const safeName = assertValidEntityName(payload.name, 'server');
    const safeAddress = assertValidEntityName(payload.address, 'address');
    const body: Record<string, unknown> = {
      name: safeName,
      address: safeAddress,
      ...(payload.port != null ? { port: Number(payload.port) } : {}),
      ...(payload.weight != null ? { weight: Number(payload.weight) } : {}),
      ...(payload.check ? { check: payload.check } : {}),
      ...(payload.maintenance ? { maintenance: payload.maintenance } : {}),
    };
    return this.requestJson<Record<string, unknown>>(
      'POST',
      `/services/haproxy/runtime/backends/${encodeURIComponent(safeBackend)}/servers`,
      undefined,
      body,
    );
  }

  async deleteRuntimeServer(backendName: string, serverName: string): Promise<{ deleted: true }> {
    const safeBackend = assertValidEntityName(backendName, 'backend');
    const safeServer = assertValidEntityName(serverName, 'server');
    await this.requestJson<unknown>(
      'DELETE',
      `/services/haproxy/runtime/backends/${encodeURIComponent(safeBackend)}/servers/${encodeURIComponent(safeServer)}`,
    );
    return { deleted: true };
  }

  // --- Runtime Maps & Stick Tables ---

  async listRuntimeMaps(): Promise<HaproxyStorageFile[]> {
    const raw = await this.requestJson<unknown>('GET', '/services/haproxy/runtime/maps');
    return unwrapArray<HaproxyStorageFile>(raw);
  }

  async getRuntimeMapEntries(mapName: string): Promise<HaproxyRuntimeMapEntry[]> {
    const safeMap = assertValidEntityName(mapName, 'map');
    const raw = await this.requestJson<unknown>(
      'GET',
      `/services/haproxy/runtime/maps/${encodeURIComponent(safeMap)}/entries`,
    );
    return unwrapArray<HaproxyRuntimeMapEntry>(raw);
  }

  async addRuntimeMapEntry(
    mapName: string,
    key: string,
    value: string,
    forceSync = true,
  ): Promise<HaproxyRuntimeMapEntry> {
    const safeMap = assertValidEntityName(mapName, 'map');
    if (!key.trim()) {
      throw createValidationError('Map entry key is required');
    }
    return this.requestJson<HaproxyRuntimeMapEntry>(
      'POST',
      `/services/haproxy/runtime/maps/${encodeURIComponent(safeMap)}/entries`,
      forceSync ? { force_sync: 'true' } : undefined,
      { key: key.trim(), value },
    );
  }

  async updateRuntimeMapEntry(
    mapName: string,
    entryId: string,
    value: string,
    forceSync = true,
  ): Promise<HaproxyRuntimeMapEntry> {
    const safeMap = assertValidEntityName(mapName, 'map');
    const safeId = assertValidEntityName(entryId, 'map entry');
    return this.requestJson<HaproxyRuntimeMapEntry>(
      'PUT',
      `/services/haproxy/runtime/maps/${encodeURIComponent(safeMap)}/entries/${encodeURIComponent(safeId)}`,
      forceSync ? { force_sync: 'true' } : undefined,
      { value },
    );
  }

  async deleteRuntimeMapEntry(mapName: string, entryId: string, forceSync = true): Promise<{ deleted: true }> {
    const safeMap = assertValidEntityName(mapName, 'map');
    const safeId = assertValidEntityName(entryId, 'map entry');
    await this.requestJson<unknown>(
      'DELETE',
      `/services/haproxy/runtime/maps/${encodeURIComponent(safeMap)}/entries/${encodeURIComponent(safeId)}`,
      forceSync ? { force_sync: 'true' } : undefined,
    );
    return { deleted: true };
  }

  async listStickTables(): Promise<HaproxyStickTable[]> {
    const raw = await this.requestJson<unknown>('GET', '/services/haproxy/runtime/stick_tables');
    return unwrapArray<HaproxyStickTable>(raw);
  }

  async getStickTableEntries(tableName: string): Promise<HaproxyStickTableEntry[]> {
    const safeTable = assertValidEntityName(tableName, 'stick table');
    const raw = await this.requestJson<unknown>(
      'GET',
      `/services/haproxy/runtime/stick_tables/${encodeURIComponent(safeTable)}/entries`,
    );
    return unwrapArray<HaproxyStickTableEntry>(raw);
  }

  // --- Configuration Version, Transactions & Reloads ---

  async getConfigVersion(transactionId?: string): Promise<number> {
    const { data, meta } = await this.requestJsonWithMeta<unknown>(
      'GET',
      '/services/haproxy/configuration/version',
      this.buildReadConfigQuery(transactionId),
    );
    const parsed = asNumberOrNull(data) ?? meta.configurationVersion;
    if (parsed == null) {
      throw new DataplaneApiError('Unable to read HAProxy configuration version', 502);
    }
    return parsed;
  }

  async listTransactions(status?: 'in_progress' | 'failed'): Promise<HaproxyTransaction[]> {
    const raw = await this.requestJson<unknown>(
      'GET',
      '/services/haproxy/transactions',
      status ? { status } : undefined,
    );
    return unwrapArray<HaproxyTransaction>(raw);
  }

  async startTransaction(version?: number): Promise<HaproxyTransaction> {
    const effectiveVersion = version !== undefined ? Number(version) : await this.getConfigVersion();
    return this.requestJson<HaproxyTransaction>('POST', '/services/haproxy/transactions', {
      version: String(effectiveVersion),
    });
  }

  async commitTransaction(
    transactionId: string,
    forceReload = false,
  ): Promise<{ transaction: HaproxyTransaction | null; meta: ConfigMutationMeta }> {
    const safeId = assertValidEntityName(transactionId, 'transaction');
    const { data, meta } = await this.requestJsonWithMeta<HaproxyTransaction>(
      'PUT',
      `/services/haproxy/transactions/${encodeURIComponent(safeId)}`,
      forceReload ? { force_reload: 'true' } : undefined,
    );
    return { transaction: data, meta };
  }

  async deleteTransaction(transactionId: string): Promise<{ deleted: true }> {
    const safeId = assertValidEntityName(transactionId, 'transaction');
    await this.requestJson<unknown>('DELETE', `/services/haproxy/transactions/${encodeURIComponent(safeId)}`);
    return { deleted: true };
  }

  async listReloads(): Promise<HaproxyReload[]> {
    const raw = await this.requestJson<unknown>('GET', '/services/haproxy/reloads');
    return unwrapArray<HaproxyReload>(raw);
  }

  // --- Raw haproxy.cfg ---

  async getRawConfig(transactionId?: string): Promise<HaproxyRawConfigResponse> {
    const res = await this.sendRaw('GET', '/services/haproxy/configuration/raw', {
      query: this.buildReadConfigQuery(transactionId),
      accept: 'text/plain, application/json;q=0.8, */*;q=0.5',
    });
    return {
      content: res.bodyText,
      version: asNumberOrNull(headerFirst(res.headers, 'configuration-version')),
      checksum: headerFirst(res.headers, 'configuration-checksum'),
    };
  }

  async pushRawConfig(
    content: string,
    opts?: { version?: number; forceReload?: boolean; skipVersion?: boolean },
  ): Promise<ConfigMutationMeta> {
    if (!content.trim()) {
      throw createValidationError('Raw HAProxy configuration cannot be empty');
    }
    const query: Record<string, string | undefined> = {};
    if (opts?.skipVersion) {
      query.skip_version = 'true';
    } else {
      const ver = opts?.version !== undefined ? Number(opts.version) : await this.getConfigVersion();
      query.version = String(ver);
    }
    if (opts?.forceReload) {
      query.force_reload = 'true';
    }

    const res = await this.sendRaw('POST', '/services/haproxy/configuration/raw', {
      query,
      body: Buffer.from(content, 'utf8'),
      contentType: 'text/plain',
      accept: 'application/json, text/plain;q=0.8, */*;q=0.5',
    });
    return extractMutationMeta(res);
  }

  // --- Structured Configuration: Defaults, Frontends, Binds, ACLs, Switching Rules, HTTP Rules ---

  async listDefaults(transactionId?: string): Promise<HaproxyDefaultsConfig[]> {
    const raw = await this.requestJson<unknown>(
      'GET',
      '/services/haproxy/configuration/defaults',
      this.buildReadConfigQuery(transactionId),
    );
    return unwrapArray<HaproxyDefaultsConfig>(raw);
  }

  async listFrontends(transactionId?: string): Promise<HaproxyFrontendConfig[]> {
    const raw = await this.requestJson<unknown>(
      'GET',
      '/services/haproxy/configuration/frontends',
      this.buildReadConfigQuery(transactionId),
    );
    return unwrapArray<HaproxyFrontendConfig>(raw);
  }

  async createFrontend(
    frontend: HaproxyFrontendConfig,
    opts?: ConfigWriteOptions,
  ): Promise<{ data: HaproxyFrontendConfig; meta: ConfigMutationMeta }> {
    const safeName = assertValidEntityName(frontend.name, 'frontend');
    const query = await this.resolveConfigWriteQuery(opts);
    return this.requestJsonWithMeta<HaproxyFrontendConfig>('POST', '/services/haproxy/configuration/frontends', query, {
      ...frontend,
      name: safeName,
    });
  }

  async updateFrontend(
    name: string,
    frontend: HaproxyFrontendConfig,
    opts?: ConfigWriteOptions,
  ): Promise<{ data: HaproxyFrontendConfig; meta: ConfigMutationMeta }> {
    const safeName = assertValidEntityName(name, 'frontend');
    const query = await this.resolveConfigWriteQuery(opts);
    return this.requestJsonWithMeta<HaproxyFrontendConfig>(
      'PUT',
      `/services/haproxy/configuration/frontends/${encodeURIComponent(safeName)}`,
      query,
      { ...frontend, name: safeName },
    );
  }

  async deleteFrontend(name: string, opts?: ConfigWriteOptions): Promise<ConfigMutationMeta> {
    const safeName = assertValidEntityName(name, 'frontend');
    const query = await this.resolveConfigWriteQuery(opts);
    const { meta } = await this.requestJsonWithMeta<unknown>(
      'DELETE',
      `/services/haproxy/configuration/frontends/${encodeURIComponent(safeName)}`,
      query,
    );
    return meta;
  }

  async listBinds(frontendName: string, transactionId?: string): Promise<HaproxyBindConfig[]> {
    const safeFrontend = assertValidEntityName(frontendName, 'frontend');
    const raw = await this.requestJson<unknown>(
      'GET',
      `/services/haproxy/configuration/frontends/${encodeURIComponent(safeFrontend)}/binds`,
      this.buildReadConfigQuery(transactionId),
    );
    return unwrapArray<HaproxyBindConfig>(raw);
  }

  async createBind(
    frontendName: string,
    bind: HaproxyBindConfig,
    opts?: ConfigWriteOptions,
  ): Promise<{ data: HaproxyBindConfig; meta: ConfigMutationMeta }> {
    const safeFrontend = assertValidEntityName(frontendName, 'frontend');
    const safeName = assertValidEntityName(bind.name, 'bind');
    const query = await this.resolveConfigWriteQuery(opts);
    return this.requestJsonWithMeta<HaproxyBindConfig>(
      'POST',
      `/services/haproxy/configuration/frontends/${encodeURIComponent(safeFrontend)}/binds`,
      query,
      { ...bind, name: safeName },
    );
  }

  async updateBind(
    frontendName: string,
    bindName: string,
    bind: HaproxyBindConfig,
    opts?: ConfigWriteOptions,
  ): Promise<{ data: HaproxyBindConfig; meta: ConfigMutationMeta }> {
    const safeFrontend = assertValidEntityName(frontendName, 'frontend');
    const safeName = assertValidEntityName(bindName, 'bind');
    const query = await this.resolveConfigWriteQuery(opts);
    return this.requestJsonWithMeta<HaproxyBindConfig>(
      'PUT',
      `/services/haproxy/configuration/frontends/${encodeURIComponent(safeFrontend)}/binds/${encodeURIComponent(
        safeName,
      )}`,
      query,
      { ...bind, name: safeName },
    );
  }

  async deleteBind(frontendName: string, bindName: string, opts?: ConfigWriteOptions): Promise<ConfigMutationMeta> {
    const safeFrontend = assertValidEntityName(frontendName, 'frontend');
    const safeName = assertValidEntityName(bindName, 'bind');
    const query = await this.resolveConfigWriteQuery(opts);
    const { meta } = await this.requestJsonWithMeta<unknown>(
      'DELETE',
      `/services/haproxy/configuration/frontends/${encodeURIComponent(safeFrontend)}/binds/${encodeURIComponent(
        safeName,
      )}`,
      query,
    );
    return meta;
  }

  async listFrontendAcls(frontendName: string, transactionId?: string): Promise<HaproxyAclConfig[]> {
    const safeFrontend = assertValidEntityName(frontendName, 'frontend');
    const raw = await this.requestJson<unknown>(
      'GET',
      `/services/haproxy/configuration/frontends/${encodeURIComponent(safeFrontend)}/acls`,
      this.buildReadConfigQuery(transactionId),
    );
    return unwrapArray<HaproxyAclConfig>(raw);
  }

  async replaceFrontendAcls(
    frontendName: string,
    acls: HaproxyAclConfig[],
    opts?: ConfigWriteOptions,
  ): Promise<{ data: HaproxyAclConfig[]; meta: ConfigMutationMeta }> {
    const safeFrontend = assertValidEntityName(frontendName, 'frontend');
    const query = await this.resolveConfigWriteQuery(opts);
    const sanitized = acls.map((item) => ({
      acl_name: assertValidEntityName(item.acl_name, 'ACL'),
      criterion: String(item.criterion ?? '').trim(),
      ...(item.value !== undefined && String(item.value).trim() !== '' ? { value: String(item.value).trim() } : {}),
    }));
    return this.requestJsonWithMeta<HaproxyAclConfig[]>(
      'PUT',
      `/services/haproxy/configuration/frontends/${encodeURIComponent(safeFrontend)}/acls`,
      query,
      sanitized,
    );
  }

  async listBackendSwitchingRules(
    frontendName: string,
    transactionId?: string,
  ): Promise<HaproxyBackendSwitchingRule[]> {
    const safeFrontend = assertValidEntityName(frontendName, 'frontend');
    const raw = await this.requestJson<unknown>(
      'GET',
      `/services/haproxy/configuration/frontends/${encodeURIComponent(safeFrontend)}/backend_switching_rules`,
      this.buildReadConfigQuery(transactionId),
    );
    return unwrapArray<HaproxyBackendSwitchingRule>(raw);
  }

  async replaceBackendSwitchingRules(
    frontendName: string,
    rules: HaproxyBackendSwitchingRule[],
    opts?: ConfigWriteOptions,
  ): Promise<{ data: HaproxyBackendSwitchingRule[]; meta: ConfigMutationMeta }> {
    const safeFrontend = assertValidEntityName(frontendName, 'frontend');
    const query = await this.resolveConfigWriteQuery(opts);
    const sanitized = rules.map((r) => ({
      name: assertValidBackendSwitchingTarget(r.name),
      ...(r.cond ? { cond: r.cond } : {}),
      ...(r.cond_test ? { cond_test: String(r.cond_test).trim() } : {}),
    }));
    return this.requestJsonWithMeta<HaproxyBackendSwitchingRule[]>(
      'PUT',
      `/services/haproxy/configuration/frontends/${encodeURIComponent(safeFrontend)}/backend_switching_rules`,
      query,
      sanitized,
    );
  }

  async listFrontendHttpRequestRules(frontendName: string, transactionId?: string): Promise<HaproxyHttpRequestRule[]> {
    const safeFrontend = assertValidEntityName(frontendName, 'frontend');
    const raw = await this.requestJson<unknown>(
      'GET',
      `/services/haproxy/configuration/frontends/${encodeURIComponent(safeFrontend)}/http_request_rules`,
      this.buildReadConfigQuery(transactionId),
    );
    return unwrapArray<HaproxyHttpRequestRule>(raw);
  }

  async replaceFrontendHttpRequestRules(
    frontendName: string,
    rules: HaproxyHttpRequestRule[],
    opts?: ConfigWriteOptions,
  ): Promise<{ data: HaproxyHttpRequestRule[]; meta: ConfigMutationMeta }> {
    const safeFrontend = assertValidEntityName(frontendName, 'frontend');
    const query = await this.resolveConfigWriteQuery(opts);
    return this.requestJsonWithMeta<HaproxyHttpRequestRule[]>(
      'PUT',
      `/services/haproxy/configuration/frontends/${encodeURIComponent(safeFrontend)}/http_request_rules`,
      query,
      rules,
    );
  }

  // --- Structured Configuration: Backends & Configured Servers ---

  async listBackends(transactionId?: string): Promise<HaproxyBackendConfig[]> {
    const raw = await this.requestJson<unknown>(
      'GET',
      '/services/haproxy/configuration/backends',
      this.buildReadConfigQuery(transactionId),
    );
    return unwrapArray<HaproxyBackendConfig>(raw);
  }

  async createBackend(
    backend: HaproxyBackendConfig,
    opts?: ConfigWriteOptions,
  ): Promise<{ data: HaproxyBackendConfig; meta: ConfigMutationMeta }> {
    const safeName = assertValidEntityName(backend.name, 'backend');
    const query = await this.resolveConfigWriteQuery(opts);
    return this.requestJsonWithMeta<HaproxyBackendConfig>('POST', '/services/haproxy/configuration/backends', query, {
      ...backend,
      name: safeName,
    });
  }

  async updateBackend(
    name: string,
    backend: HaproxyBackendConfig,
    opts?: ConfigWriteOptions,
  ): Promise<{ data: HaproxyBackendConfig; meta: ConfigMutationMeta }> {
    const safeName = assertValidEntityName(name, 'backend');
    const query = await this.resolveConfigWriteQuery(opts);
    return this.requestJsonWithMeta<HaproxyBackendConfig>(
      'PUT',
      `/services/haproxy/configuration/backends/${encodeURIComponent(safeName)}`,
      query,
      { ...backend, name: safeName },
    );
  }

  async deleteBackend(name: string, opts?: ConfigWriteOptions): Promise<ConfigMutationMeta> {
    const safeName = assertValidEntityName(name, 'backend');
    const query = await this.resolveConfigWriteQuery(opts);
    const { meta } = await this.requestJsonWithMeta<unknown>(
      'DELETE',
      `/services/haproxy/configuration/backends/${encodeURIComponent(safeName)}`,
      query,
    );
    return meta;
  }

  async listBackendServers(backendName: string, transactionId?: string): Promise<HaproxyServerConfig[]> {
    const safeBackend = assertValidEntityName(backendName, 'backend');
    const raw = await this.requestJson<unknown>(
      'GET',
      `/services/haproxy/configuration/backends/${encodeURIComponent(safeBackend)}/servers`,
      this.buildReadConfigQuery(transactionId),
    );
    return unwrapArray<HaproxyServerConfig>(raw);
  }

  async createBackendServer(
    backendName: string,
    server: HaproxyServerConfig,
    opts?: ConfigWriteOptions,
  ): Promise<{ data: HaproxyServerConfig; meta: ConfigMutationMeta }> {
    const safeBackend = assertValidEntityName(backendName, 'backend');
    const safeName = assertValidEntityName(server.name, 'server');
    const safeAddr = assertValidEntityName(server.address, 'server address');
    const query = await this.resolveConfigWriteQuery(opts);
    return this.requestJsonWithMeta<HaproxyServerConfig>(
      'POST',
      `/services/haproxy/configuration/backends/${encodeURIComponent(safeBackend)}/servers`,
      query,
      { ...server, name: safeName, address: safeAddr },
    );
  }

  async updateBackendServer(
    backendName: string,
    serverName: string,
    server: HaproxyServerConfig,
    opts?: ConfigWriteOptions,
  ): Promise<{ data: HaproxyServerConfig; meta: ConfigMutationMeta }> {
    const safeBackend = assertValidEntityName(backendName, 'backend');
    const safeName = assertValidEntityName(serverName, 'server');
    const safeAddr = assertValidEntityName(server.address, 'server address');
    const query = await this.resolveConfigWriteQuery(opts);
    return this.requestJsonWithMeta<HaproxyServerConfig>(
      'PUT',
      `/services/haproxy/configuration/backends/${encodeURIComponent(safeBackend)}/servers/${encodeURIComponent(
        safeName,
      )}`,
      query,
      { ...server, name: safeName, address: safeAddr },
    );
  }

  async deleteBackendServer(
    backendName: string,
    serverName: string,
    opts?: ConfigWriteOptions,
  ): Promise<ConfigMutationMeta> {
    const safeBackend = assertValidEntityName(backendName, 'backend');
    const safeName = assertValidEntityName(serverName, 'server');
    const query = await this.resolveConfigWriteQuery(opts);
    const { meta } = await this.requestJsonWithMeta<unknown>(
      'DELETE',
      `/services/haproxy/configuration/backends/${encodeURIComponent(safeBackend)}/servers/${encodeURIComponent(
        safeName,
      )}`,
      query,
    );
    return meta;
  }

  // --- Managed Storage (SSL Certificates, Map Files, General Files) ---

  async listSslCertificates(): Promise<HaproxySslCertificate[]> {
    const raw = await this.requestJson<unknown>('GET', '/services/haproxy/storage/ssl_certificates');
    return unwrapArray<HaproxySslCertificate>(raw);
  }

  async uploadSslCertificate(
    fileName: string,
    pemContent: string,
    opts?: StorageWriteOptions,
  ): Promise<{ cert: HaproxySslCertificate | null; meta: ConfigMutationMeta }> {
    if (!pemContent.trim()) {
      throw createValidationError('PEM certificate bundle cannot be empty');
    }
    const multipart = buildMultipartFileUpload(fileName, pemContent, 'text/plain');
    const res = await this.sendRaw('POST', '/services/haproxy/storage/ssl_certificates', {
      query: this.buildStorageWriteQuery(opts),
      body: multipart.body,
      contentType: multipart.contentType,
      accept: 'application/json',
    });
    const cert = res.bodyText.trim() ? (JSON.parse(res.bodyText) as HaproxySslCertificate) : null;
    return { cert, meta: extractMutationMeta(res) };
  }

  async replaceSslCertificate(
    storageName: string,
    pemContent: string,
    opts?: StorageWriteOptions,
  ): Promise<{ cert: HaproxySslCertificate | null; meta: ConfigMutationMeta }> {
    if (!pemContent.trim()) {
      throw createValidationError('PEM certificate bundle cannot be empty');
    }
    const safeName = assertSafeStorageFileName(storageName, 'SSL certificate');
    const res = await this.sendRaw(
      'PUT',
      `/services/haproxy/storage/ssl_certificates/${encodeURIComponent(safeName)}`,
      {
        query: this.buildStorageWriteQuery(opts),
        body: Buffer.from(pemContent, 'utf8'),
        contentType: 'text/plain',
        accept: 'application/json',
      },
    );
    const cert = res.bodyText.trim() ? (JSON.parse(res.bodyText) as HaproxySslCertificate) : null;
    return { cert, meta: extractMutationMeta(res) };
  }

  async deleteSslCertificate(storageName: string, opts?: StorageWriteOptions): Promise<ConfigMutationMeta> {
    const safeName = assertSafeStorageFileName(storageName, 'SSL certificate');
    const res = await this.sendRaw(
      'DELETE',
      `/services/haproxy/storage/ssl_certificates/${encodeURIComponent(safeName)}`,
      {
        query: this.buildStorageWriteQuery(opts),
      },
    );
    return extractMutationMeta(res);
  }

  async listStorageMaps(): Promise<HaproxyStorageFile[]> {
    const raw = await this.requestJson<unknown>('GET', '/services/haproxy/storage/maps');
    return unwrapArray<HaproxyStorageFile>(raw);
  }

  async getStorageMapContent(storageName: string): Promise<string> {
    const safeName = assertSafeStorageFileName(storageName, 'map');
    const res = await this.sendRaw('GET', `/services/haproxy/storage/maps/${encodeURIComponent(safeName)}`, {
      accept: 'application/octet-stream, text/plain;q=0.9, */*;q=0.5',
    });
    return res.bodyText;
  }

  async createStorageMap(fileName: string, content: string): Promise<HaproxyStorageFile | null> {
    const multipart = buildMultipartFileUpload(fileName, content, 'text/plain');
    const res = await this.sendRaw('POST', '/services/haproxy/storage/maps', {
      body: multipart.body,
      contentType: multipart.contentType,
      accept: 'application/json',
    });
    return res.bodyText.trim() ? (JSON.parse(res.bodyText) as HaproxyStorageFile) : null;
  }

  async replaceStorageMap(
    storageName: string,
    content: string,
    opts?: StorageWriteOptions,
  ): Promise<ConfigMutationMeta> {
    const safeName = assertSafeStorageFileName(storageName, 'map');
    const res = await this.sendRaw('PUT', `/services/haproxy/storage/maps/${encodeURIComponent(safeName)}`, {
      query: this.buildStorageWriteQuery(opts),
      body: Buffer.from(content, 'utf8'),
      contentType: 'text/plain',
      accept: 'application/json, text/plain;q=0.8, */*;q=0.5',
    });
    return extractMutationMeta(res);
  }

  async deleteStorageMap(storageName: string): Promise<{ deleted: true }> {
    const safeName = assertSafeStorageFileName(storageName, 'map');
    await this.sendRaw('DELETE', `/services/haproxy/storage/maps/${encodeURIComponent(safeName)}`);
    return { deleted: true };
  }

  async listStorageGeneralFiles(): Promise<HaproxyStorageFile[]> {
    const raw = await this.requestJson<unknown>('GET', '/services/haproxy/storage/general');
    return unwrapArray<HaproxyStorageFile>(raw);
  }

  async getStorageGeneralFileContent(storageName: string): Promise<string> {
    const safeName = assertSafeStorageFileName(storageName, 'general');
    const res = await this.sendRaw('GET', `/services/haproxy/storage/general/${encodeURIComponent(safeName)}`, {
      accept: 'application/octet-stream, text/plain;q=0.9, */*;q=0.5',
    });
    return res.bodyText;
  }

  async createStorageGeneralFile(fileName: string, content: string): Promise<HaproxyStorageFile | null> {
    const multipart = buildMultipartFileUpload(fileName, content, 'application/octet-stream');
    const res = await this.sendRaw('POST', '/services/haproxy/storage/general', {
      body: multipart.body,
      contentType: multipart.contentType,
      accept: 'application/json',
    });
    return res.bodyText.trim() ? (JSON.parse(res.bodyText) as HaproxyStorageFile) : null;
  }

  async replaceStorageGeneralFile(
    storageName: string,
    content: string,
    opts?: StorageWriteOptions,
  ): Promise<ConfigMutationMeta> {
    const safeName = assertSafeStorageFileName(storageName, 'general');
    const multipart = buildMultipartFileUpload(safeName, content, 'application/octet-stream');
    const res = await this.sendRaw('PUT', `/services/haproxy/storage/general/${encodeURIComponent(safeName)}`, {
      query: this.buildStorageWriteQuery(opts),
      body: multipart.body,
      contentType: multipart.contentType,
      accept: 'application/json, text/plain;q=0.8, */*;q=0.5',
    });
    return extractMutationMeta(res);
  }

  async deleteStorageGeneralFile(storageName: string): Promise<{ deleted: true }> {
    const safeName = assertSafeStorageFileName(storageName, 'general');
    await this.sendRaw('DELETE', `/services/haproxy/storage/general/${encodeURIComponent(safeName)}`);
    return { deleted: true };
  }

  // --- Connection Test & Merged Snapshot ---

  async testConnection(): Promise<{ apiInfo: DataplaneApiInfo; processInfo: HaproxyProcessSummary }> {
    const [apiInfo, processInfo] = await Promise.all([this.getInfo(), this.getProcessInfo()]);
    return { apiInfo, processInfo };
  }

  async getSnapshot(connectionId: number, connectionName: string): Promise<HaproxyNodeSnapshot> {
    const [apiInfo, processInfo, nativeStats, configVersion] = await Promise.all([
      this.getInfo(),
      this.getProcessInfo(),
      this.getNativeStats(),
      this.getConfigVersion().catch(() => null),
    ]);

    const frontends = nativeStats.rows.filter((r) => r.type === 'frontend');
    const backends = nativeStats.rows.filter((r) => r.type === 'backend');
    const statServers = nativeStats.rows.filter((r) => r.type === 'server');

    const backendNames = Array.from(
      new Set([
        ...backends.map((b) => b.name),
        ...statServers.map((s) => s.backendName).filter((b): b is string => Boolean(b)),
      ]),
    );

    const runtimeMap = new Map<string, HaproxyRuntimeServer>();
    await mapWithConcurrency(backendNames, 6, async (backendName) => {
      try {
        const runtimeList = await this.getRuntimeServers(backendName);
        for (const rtSrv of runtimeList) {
          runtimeMap.set(`${backendName}/${rtSrv.name}`, rtSrv);
        }
      } catch {
        // Keep native stats rows visible even if a specific backend has no runtime servers or fails socket inspection.
      }
    });

    const mergedKeys = new Set<string>();
    const servers: HaproxyMergedServerRow[] = [];

    for (const s of statServers) {
      const backendName = s.backendName ?? '';
      const lookupKey = `${backendName}/${s.name}`;
      mergedKeys.add(lookupKey);
      const rt = runtimeMap.get(lookupKey);
      const inferred = inferStatesFromStatus(s.status);
      const addrPort = parseAddressAndPort(s.addr);

      servers.push({
        key: lookupKey,
        backendName,
        name: s.name,
        address: rt?.address ?? addrPort.address,
        port: rt?.port ?? addrPort.port,
        status: s.status,
        adminState: rt?.adminState ?? inferred.adminState,
        operationalState: rt?.operationalState ?? inferred.operationalState,
        weight: rt?.weight ?? s.weight,
        uweight: rt?.uweight ?? null,
        iweight: rt?.iweight ?? null,
        scur: s.scur,
        smax: s.smax,
        stot: s.stot,
        qcur: s.qcur,
        bin: s.bin,
        bout: s.bout,
        hrsp2xx: s.hrsp2xx,
        hrsp4xx: s.hrsp4xx,
        hrsp5xx: s.hrsp5xx,
        econ: s.econ,
        eresp: s.eresp,
        rtime: s.rtime,
        checkStatus: s.checkStatus,
        checkCode: s.checkCode,
        checkDuration: s.checkDuration,
        lastchg: rt?.lastTimeChange ?? s.lastchg,
      });
    }

    for (const [lookupKey, rt] of runtimeMap.entries()) {
      if (mergedKeys.has(lookupKey)) continue;
      servers.push({
        key: lookupKey,
        backendName: rt.backendName,
        name: rt.name,
        address: rt.address,
        port: rt.port,
        status: rt.adminState === 'maint' ? 'MAINT' : rt.operationalState.toUpperCase(),
        adminState: rt.adminState,
        operationalState: rt.operationalState,
        weight: rt.weight,
        uweight: rt.uweight,
        iweight: rt.iweight,
        scur: 0,
        smax: 0,
        stot: 0,
        qcur: 0,
        bin: 0,
        bout: 0,
        hrsp2xx: 0,
        hrsp4xx: 0,
        hrsp5xx: 0,
        econ: 0,
        eresp: 0,
        rtime: null,
        checkStatus: null,
        checkCode: null,
        checkDuration: null,
        lastchg: rt.lastTimeChange,
      });
    }

    return {
      connectionId,
      connectionName,
      fetchedAt: new Date().toISOString(),
      configVersion,
      apiInfo,
      processInfo,
      statsError: nativeStats.statsError,
      frontends,
      backends,
      servers,
    };
  }
}
