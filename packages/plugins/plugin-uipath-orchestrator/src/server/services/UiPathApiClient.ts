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
 * - Uses undici's fetch (not global fetch) so the `dispatcher` option works correctly
 *   for ignoreSsl / custom TLS settings. Global fetch silently ignores `dispatcher`,
 *   which causes unhandled rejections on self-signed / HTTP-only environments.
 */

import type {
  UiPathInstanceConfig,
  FolderContext,
  ODataQuery,
  UiPathRequestOptions,
  TokenCacheEntry,
} from './types';
import { fetch as undiciFetch, Agent } from 'undici';

const TOKEN_REFRESH_BUFFER_MS = 60_000; // Refresh 60s before expiry
const DEFAULT_TIMEOUT_MS = 15_000;
const TOKEN_TIMEOUT_MS = 10_000; // Timeout for token acquisition
const DEFAULT_CLOUD_BASE_URL = 'https://cloud.uipath.com';

export class UiPathApiClient {
  private tokenCache: TokenCacheEntry | null = null;
  private tokenPromise: Promise<string> | null = null;
  private config: UiPathInstanceConfig;

  constructor(config: UiPathInstanceConfig) {
    const normalizedConfig = {
      ...config,
      baseUrl: config.baseUrl?.trim(),
      apiBaseUrl: config.apiBaseUrl?.trim(),
      tokenUrl: config.tokenUrl?.trim(),
      clientId: config.clientId?.trim(),
      scopes: config.scopes?.trim() || 'OR.Default',
    };
    this.config = {
      ...normalizedConfig,
      apiBaseUrl: normalizedConfig.apiBaseUrl?.replace(/\/+$/, '') || this.buildApiBaseUrl(normalizedConfig),
      tokenUrl: normalizedConfig.tokenUrl || this.buildTokenUrl(normalizedConfig),
    };
  }

  // ─── URL Construction ──────────────────────────────────────────────

  private buildApiBaseUrl(config: UiPathInstanceConfig): string {
    const base = (config.baseUrl || '').replace(/\/+$/, '');
    if (config.deploymentType === 'onPrem') {
      return base;
    }
    // Cloud: https://cloud.uipath.com/{accountLogicalName}/{tenantLogicalName}/orchestrator_
    const cloudBase = (config.baseUrl || DEFAULT_CLOUD_BASE_URL).replace(/\/+$/, '');
    return `${cloudBase}/${config.accountLogicalName}/${config.tenantLogicalName}/orchestrator_`;
  }

  private buildTokenUrl(config: UiPathInstanceConfig): string {
    const base = (config.baseUrl || DEFAULT_CLOUD_BASE_URL).replace(/\/+$/, '');
    if (config.deploymentType === 'onPrem') {
      if (/\/identity\/connect\/token$/i.test(base)) return base;
      if (/\/identity$/i.test(base)) return `${base}/connect/token`;

      // The Base URL field is usually the Orchestrator URL. For standalone/on-prem
      // deployments, Identity is a sibling of Orchestrator, not a child route.
      const identityBase = base.replace(/\/orchestrator_?$/i, '');
      return `${identityBase}/identity/connect/token`;
    }
    return `${base}/identity_/connect/token`;
  }

  /**
   * Build fetch options with proper dispatcher for SSL/TLS handling.
   * Uses undici's Agent to support rejectUnauthorized on HTTP & self-signed HTTPS.
   */
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

  /**
   * Wrapper around undici fetch that catches network-level errors
   * to prevent unhandled rejections from crashing the process.
   */
  private async safeFetch(url: string, init: Record<string, any>): Promise<Response> {
    try {
      return await (undiciFetch as any)(url, init);
    } catch (err: any) {
      if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
        throw err;
      }

      // Normalize network errors into a standard Error with context
      const code = err?.code || err?.cause?.code || '';
      const message = err?.message || 'Network request failed';
      const sslHint = this.getSslErrorHint(code, message);
      const networkError = new Error(`UiPath connection error [${code}]: ${message}${sslHint}`);
      (networkError as any).statusCode = 503;
      throw networkError;
    }
  }

  private getSslErrorHint(code: string, message: string): string {
    const value = `${code} ${message}`.toUpperCase();
    const sslCodes = [
      'CERT_HAS_EXPIRED',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_GET_ISSUER_CERT',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'ERR_TLS_CERT_ALTNAME_INVALID',
    ];

    if (!sslCodes.some((sslCode) => value.includes(sslCode))) {
      return '';
    }

    if (this.config.ignoreSsl) {
      return ' (Ignore SSL is enabled, but the TLS handshake still failed. Check protocol/cipher support and the server certificate chain.)';
    }

    return ' (This looks like a TLS/certificate validation error. Enable "Ignore SSL" for a quick on-prem test, or install/fix the Orchestrator certificate chain.)';
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

    if (!tokenUrl) {
      throw new Error('UiPath token URL is not configured. Check your instance settings.');
    }

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: scopes,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);

    try {
      const res = await this.safeFetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        ...this.getFetchOptions(controller.signal),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`UiPath OAuth token error ${res.status}: ${text}`);
      }

      const data = (await res.json()) as any;
      const expiresIn = (data.expires_in || 3600) * 1000; // ms

      this.tokenCache = {
        accessToken: data.access_token,
        expiresAt: Date.now() + expiresIn,
      };

      return data.access_token;
    } catch (err: any) {
      // Re-throw with better context for connection failures
      if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
        throw new Error(
          `UiPath token request timed out after ${TOKEN_TIMEOUT_MS}ms. Check that the token URL is reachable: ${tokenUrl}`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
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

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...this.buildFolderHeaders(folder),
    };
    if (this.config.tenantName) {
      headers['X-UIPATH-TenantName'] = this.config.tenantName;
    }
    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    const qs = UiPathApiClient.buildODataParams(query);
    const qsStr = qs.toString();
    const sep = endpoint.includes('?') ? '&' : '?';
    const url = `${this.config.apiBaseUrl}${endpoint}${qsStr ? `${sep}${qsStr}` : ''}`;

    // Each attempt gets its own AbortController so that timeout doesn't leak across retries
    const doFetch = async (authToken: string): Promise<Response> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        headers['Authorization'] = `Bearer ${authToken}`;
        const res = await this.safeFetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          ...this.getFetchOptions(controller.signal),
        });
        return res;
      } catch (err: any) {
        if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
          throw new Error(`UiPath API request timed out after ${timeout}ms: ${method} ${endpoint}`);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    };

    const res = await doFetch(token);

    // 401 → clear token and retry once with fresh credentials
    if (res.status === 401) {
      this.clearToken();
      const retryToken = await this.getAccessToken();
      const retryRes = await doFetch(retryToken);

      if (!retryRes.ok) {
        const text = await retryRes.text().catch(() => '');
        const err = new Error(`UiPath API error ${retryRes.status}: ${text}`);
        (err as any).statusCode = retryRes.status;
        throw err;
      }

      return this.parseResponse<T>(retryRes);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`UiPath API error ${res.status}: ${text}`);
      (err as any).statusCode = res.status;
      throw err;
    }

    return this.parseResponse<T>(res);
  }

  private async parseResponse<T>(res: any): Promise<T> {
    const contentType = (res.headers?.get?.('content-type') || res.headers?.['content-type'] || '') as string;
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
      // Test token acquisition first so auth/TLS errors are easier to distinguish
      // from Orchestrator permission errors on the health endpoint.
      await this.getAccessToken();
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
