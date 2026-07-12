import { serverRequest } from '@nocobase/utils';
import { toSafeErrorMessage } from './utils/redact';

const REQUEST_TIMEOUT = 15000;
const API_BASE = '/api/v2';

export interface SftpgoConnectionConfig {
  baseUrl: string;
  authMethod: 'admin' | 'apikey' | string;
  /** Admin username (authMethod=admin), or the user to impersonate for a non-admin-bound apikey */
  username?: string | null;
  /** Decrypted admin password (authMethod=admin) */
  password?: string | null;
  /** Decrypted API key (authMethod=apikey) */
  apiKey?: string | null;
}

export type SftpgoResourceType = 'users' | 'folders' | 'apikeys';

export const RESOURCE_KEY_FIELD: Record<SftpgoResourceType, string> = {
  users: 'username',
  folders: 'name',
  apikeys: 'id',
};

export class SftpgoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SftpgoError';
  }
}

export function assertValidAddress(address: string): void {
  let parsed: URL;
  try {
    parsed = new URL(address);
  } catch {
    throw new SftpgoError(`Invalid SFTPGo base URL: "${address}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SftpgoError('SFTPGo base URL must use http or https');
  }
}

export class SftpgoClient {
  private clientToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(private readonly config: SftpgoConnectionConfig) {
    assertValidAddress(config.baseUrl);
  }

  private get baseUrl(): string {
    return this.config.baseUrl.replace(/\/+$/, '');
  }

  private resourcePath(type: SftpgoResourceType): string {
    return `${API_BASE}/${type}`;
  }

  private resourceItemPath(type: SftpgoResourceType, key: string | number): string {
    return `${this.resourcePath(type)}/${encodeURIComponent(String(key))}`;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    if (this.config.authMethod === 'apikey') {
      if (!this.config.apiKey) throw new SftpgoError('API key is not configured');
      // API keys not bound to a specific admin/user must impersonate one via "<key>.<username>"
      const key = this.config.username ? `${this.config.apiKey}.${this.config.username}` : this.config.apiKey;
      return { 'X-SFTPGO-API-KEY': key };
    }
    const token = await this.getAdminToken();
    return { Authorization: `Bearer ${token}` };
  }

  private async getAdminToken(): Promise<string> {
    const now = Date.now();
    if (this.clientToken && now < this.tokenExpiresAt) return this.clientToken;
    if (!this.config.username || !this.config.password) {
      throw new SftpgoError('Admin username/password is not configured');
    }
    try {
      const basic = Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64');
      const res = await serverRequest<{ access_token?: string; expires_at?: string }>({
        method: 'GET',
        url: `${this.baseUrl}${API_BASE}/token`,
        headers: { Authorization: `Basic ${basic}` },
        timeout: REQUEST_TIMEOUT,
      });
      const token = res.data?.access_token;
      if (!token) throw new SftpgoError('Token endpoint returned no access token');
      const expiresAtMs = res.data?.expires_at ? new Date(res.data.expires_at).getTime() : NaN;
      const ttlMs = Number.isFinite(expiresAtMs) ? Math.max(expiresAtMs - now, 60_000) : 20 * 60 * 1000;
      this.clientToken = token;
      // refresh at 80% of the TTL to avoid using an about-to-expire token
      this.tokenExpiresAt = now + ttlMs * 0.8;
      return token;
    } catch (err) {
      if (err instanceof SftpgoError) throw err;
      throw new SftpgoError(`Admin authentication failed: ${toSafeErrorMessage(err)}`);
    }
  }

  async healthCheck(): Promise<Record<string, unknown>> {
    try {
      const headers = await this.authHeaders();
      const res = await serverRequest<Record<string, unknown>>({
        method: 'GET',
        url: `${this.baseUrl}${API_BASE}/status`,
        headers,
        timeout: REQUEST_TIMEOUT,
      });
      return res.data || {};
    } catch (err) {
      throw new SftpgoError(`SFTPGo health check failed: ${toSafeErrorMessage(err)}`);
    }
  }

  async verifyAuth(): Promise<void> {
    try {
      const headers = await this.authHeaders();
      await serverRequest<unknown>({
        method: 'GET',
        url: `${this.baseUrl}${this.resourcePath('users')}`,
        headers,
        params: { limit: 1 },
        timeout: REQUEST_TIMEOUT,
      });
    } catch (err) {
      throw new SftpgoError(`Authentication verification failed: ${toSafeErrorMessage(err)}`);
    }
  }

  async listResources(type: SftpgoResourceType, params?: Record<string, unknown>): Promise<unknown[]> {
    try {
      const headers = await this.authHeaders();
      const res = await serverRequest<unknown[]>({
        method: 'GET',
        url: `${this.baseUrl}${this.resourcePath(type)}`,
        headers,
        params,
        timeout: REQUEST_TIMEOUT,
      });
      return res.data || [];
    } catch (err) {
      throw new SftpgoError(`Failed to list ${type}: ${toSafeErrorMessage(err)}`);
    }
  }

  async getResource(type: SftpgoResourceType, key: string | number): Promise<Record<string, unknown>> {
    try {
      const headers = await this.authHeaders();
      const res = await serverRequest<Record<string, unknown>>({
        method: 'GET',
        url: `${this.baseUrl}${this.resourceItemPath(type, key)}`,
        headers,
        timeout: REQUEST_TIMEOUT,
      });
      return res.data;
    } catch (err) {
      throw new SftpgoError(`Failed to read ${type} "${key}": ${toSafeErrorMessage(err)}`);
    }
  }

  async createResource(type: SftpgoResourceType, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      const headers = await this.authHeaders();
      const res = await serverRequest<Record<string, unknown>>({
        method: 'POST',
        url: `${this.baseUrl}${this.resourcePath(type)}`,
        headers,
        data,
        timeout: REQUEST_TIMEOUT,
      });
      return res.data;
    } catch (err) {
      throw new SftpgoError(`Failed to create ${type}: ${toSafeErrorMessage(err)}`);
    }
  }

  /**
   * SFTPGo's PUT replaces the whole resource. Fetches the current object and
   * merges the patch into it. `password` is omitted entirely from the merged
   * body for user updates unless the caller explicitly supplied a new one —
   * SFTPGo only keeps the existing password when the field is absent, not
   * when it's an empty string.
   */
  async updateResource(
    type: SftpgoResourceType,
    key: string | number,
    patch: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const current = await this.getResource(type, key);
    const merged: Record<string, unknown> = { ...current, ...patch };
    if (type === 'users' && !Object.prototype.hasOwnProperty.call(patch, 'password')) {
      delete merged.password;
    }
    try {
      const headers = await this.authHeaders();
      const res = await serverRequest<Record<string, unknown>>({
        method: 'PUT',
        url: `${this.baseUrl}${this.resourceItemPath(type, key)}`,
        headers,
        data: merged,
        timeout: REQUEST_TIMEOUT,
      });
      return res.data;
    } catch (err) {
      throw new SftpgoError(`Failed to update ${type} "${key}": ${toSafeErrorMessage(err)}`);
    }
  }

  async deleteResource(type: SftpgoResourceType, key: string | number): Promise<void> {
    try {
      const headers = await this.authHeaders();
      await serverRequest<unknown>({
        method: 'DELETE',
        url: `${this.baseUrl}${this.resourceItemPath(type, key)}`,
        headers,
        timeout: REQUEST_TIMEOUT,
      });
    } catch (err) {
      throw new SftpgoError(`Failed to delete ${type} "${key}": ${toSafeErrorMessage(err)}`);
    }
  }
}
