/**
 * UiPath API Client
 *
 * Handles OAuth2 client_credentials auth, OData query building, folder scope headers,
 * token caching, and retry logic for both Automation Cloud and on-prem Orchestrator.
 *
 * Design decisions:
 * - Does NOT depend on the @uipath/orchestrator-nodejs package (outdated, uses legacy auth).
 * - Owns its own OAuth2 client_credentials flow with 60s pre-expiry refresh.
 * - Folder context resolved via priority: FolderKey > OrganizationUnitId > FolderPath.
 * - OData query builder for $top/$skip/$filter/$select/$expand/$orderby/$count.
 */

import type {
  UiPathInstanceConfig,
  FolderContext,
  ODataQuery,
  UiPathRequestOptions,
  TokenCacheEntry,
  ODataResponse,
} from './types';
import { Agent } from 'undici';

const TOKEN_REFRESH_BUFFER_MS = 60_000; // Refresh 60s before expiry
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_CLOUD_BASE_URL = 'https://cloud.uipath.com';

export class UiPathApiClient {
  private tokenCache: TokenCacheEntry | null = null;
  private tokenPromise: Promise<string> | null = null;
  private config: UiPathInstanceConfig;

  constructor(config: UiPathInstanceConfig) {
    this.config = {
      ...config,
      apiBaseUrl: config.apiBaseUrl?.replace(/\/+$/, '') || this.buildApiBaseUrl(config),
      tokenUrl: config.tokenUrl || this.buildTokenUrl(config),
    };
  }

  // ─── URL Construction ──────────────────────────────────────────────

  private buildApiBaseUrl(config: UiPathInstanceConfig): string {
    const base = (config.baseUrl || '').replace(/\/+$/, '');
    if (config.deploymentType === 'onPrem') {
      if (!base) return '';
      if (/\/orchestrator_?$/i.test(base)) return base;
      return `${base}/orchestrator`;
    }
    // Cloud: https://cloud.uipath.com/{accountLogicalName}/{tenantLogicalName}/orchestrator_
    const cloudBase = (config.baseUrl || DEFAULT_CLOUD_BASE_URL).replace(/\/+$/, '');
    return `${cloudBase}/${config.accountLogicalName}/${config.tenantLogicalName}/orchestrator_`;
  }

  private buildTokenUrl(config: UiPathInstanceConfig): string {
    const base = (config.baseUrl || DEFAULT_CLOUD_BASE_URL).replace(/\/+$/, '');
    if (config.deploymentType === 'onPrem') {
      return `${base}/identity/connect/token`;
    }
    return `${base}/identity_/connect/token`;
  }

  private getFetchOptions(signal?: AbortSignal): Record<string, any> {
    const options: Record<string, any> = {};
    if (signal) options.signal = signal;
    if (this.config.ignoreSsl) {
      options.dispatcher = new Agent({
        connect: {
          rejectUnauthorized: false,
        },
      });
    }
    return options;
  }

  // ─── OAuth2 Token ──────────────────────────────────────────────────

  private async getAccessToken(): Promise<string> {
    // Check cached token (with 60s buffer)
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt - TOKEN_REFRESH_BUFFER_MS) {
      return this.tokenCache.accessToken;
    }

    // Coalesce concurrent token requests
    if (this.tokenPromise) {
      return this.tokenPromise;
    }

    this.tokenPromise = this.fetchToken();
    try {
      return await this.tokenPromise;
    } finally {
      this.tokenPromise = null;
    }
  }

  private async fetchToken(): Promise<string> {
    const { tokenUrl, clientId, clientSecret, scopes } = this.config;

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: scopes,
    });

    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      ...this.getFetchOptions(),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`UiPath OAuth token error ${res.status}: ${text}`);
    }

    const data = await res.json();
    const expiresIn = (data.expires_in || 3600) * 1000; // ms

    this.tokenCache = {
      accessToken: data.access_token,
      expiresAt: Date.now() + expiresIn,
    };

    return data.access_token;
  }

  /** Force-clear cached token (useful after 401 retry). */
  clearToken(): void {
    this.tokenCache = null;
    this.tokenPromise = null;
  }

  // ─── Folder Header Resolution ─────────────────────────────────────

  private buildFolderHeaders(folder?: FolderContext): Record<string, string> {
    const ctx = folder || {
      folderId: this.config.defaultFolderId,
      folderKey: this.config.defaultFolderKey,
      folderPath: this.config.defaultFolderPath,
    };

    const headers: Record<string, string> = {};

    // Priority: FolderKey > OrganizationUnitId > FolderPath
    if (ctx.folderKey) {
      headers['X-UIPATH-FolderKey'] = ctx.folderKey;
    } else if (ctx.folderId) {
      headers['X-UIPATH-OrganizationUnitId'] = String(ctx.folderId);
    } else if (ctx.folderPath) {
      headers['X-UIPATH-FolderPath'] = ctx.folderPath;
    }

    return headers;
  }

  // ─── OData Query Builder ──────────────────────────────────────────

  static buildODataParams(query?: ODataQuery & Record<string, any>): URLSearchParams {
    const params = new URLSearchParams();
    if (!query) return params;

    const odataKeys = ['$top', '$skip', '$filter', '$select', '$expand', '$orderby', '$count'];
    for (const key of odataKeys) {
      const shortKey = key.replace('$', '') as keyof ODataQuery;
      const val = query[key] ?? query[shortKey];
      if (val !== undefined && val !== null) {
        params.set(key, String(val));
      }
    }

    // Pass through any non-OData query params
    for (const [key, val] of Object.entries(query)) {
      if (!odataKeys.includes(key) && !odataKeys.includes(`$${key}`) && val !== undefined) {
        params.set(key, String(val));
      }
    }

    return params;
  }

  // ─── Core Request ─────────────────────────────────────────────────

  async request<T = any>(method: string, endpoint: string, options: UiPathRequestOptions = {}): Promise<T> {
    const { query, body, folder, timeout = DEFAULT_TIMEOUT_MS } = options;

    const token = await this.getAccessToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...this.buildFolderHeaders(folder),
      };
      if (body) {
        headers['Content-Type'] = 'application/json';
      }

      const qs = UiPathApiClient.buildODataParams(query);
      const qsStr = qs.toString();
      const sep = endpoint.includes('?') ? '&' : '?';
      const url = `${this.config.apiBaseUrl}${endpoint}${qsStr ? `${sep}${qsStr}` : ''}`;

      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        ...this.getFetchOptions(controller.signal),
      });

      // 401 → clear token and retry once
      if (res.status === 401) {
        this.clearToken();
        const retryToken = await this.getAccessToken();
        headers['Authorization'] = `Bearer ${retryToken}`;

        const retryRes = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          ...this.getFetchOptions(controller.signal),
        });

        if (!retryRes.ok) {
          const text = await retryRes.text().catch(() => '');
          throw new Error(`UiPath API error ${retryRes.status}: ${text}`);
        }

        return this.parseResponse<T>(retryRes);
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`UiPath API error ${res.status}: ${text}`);
      }

      return this.parseResponse<T>(res);
    } finally {
      clearTimeout(timer);
    }
  }

  private async parseResponse<T>(res: Response): Promise<T> {
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return res.json() as Promise<T>;
    }
    return (await res.text()) as unknown as T;
  }

  // ─── Convenience Methods ──────────────────────────────────────────

  async get<T = any>(endpoint: string, options?: Omit<UiPathRequestOptions, 'body'>): Promise<T> {
    return this.request<T>('GET', endpoint, options);
  }

  async post<T = any>(endpoint: string, body?: any, options?: UiPathRequestOptions): Promise<T> {
    return this.request<T>('POST', endpoint, { ...options, body });
  }

  async put<T = any>(endpoint: string, body?: any, options?: UiPathRequestOptions): Promise<T> {
    return this.request<T>('PUT', endpoint, { ...options, body });
  }

  async patch<T = any>(endpoint: string, body?: any, options?: UiPathRequestOptions): Promise<T> {
    return this.request<T>('PATCH', endpoint, { ...options, body });
  }

  async delete<T = any>(endpoint: string, options?: UiPathRequestOptions): Promise<T> {
    return this.request<T>('DELETE', endpoint, options);
  }

  // ─── Health Check ─────────────────────────────────────────────────

  async testConnection(): Promise<{ status: string; latencyMs: number; message?: string }> {
    const start = Date.now();
    try {
      // Test token acquisition + basic API call
      await this.get('/odata/Folders', { query: { $top: 1 } });
      return { status: 'healthy', latencyMs: Date.now() - start };
    } catch (error: any) {
      return {
        status: 'unhealthy',
        latencyMs: Date.now() - start,
        message: error.message,
      };
    }
  }

  // ─── Accessor ─────────────────────────────────────────────────────

  getConfig(): Readonly<UiPathInstanceConfig> {
    return this.config;
  }
}
