import { serverRequest } from '@nocobase/utils';
import { toSafeErrorMessage } from './utils/redact';

const REQUEST_TIMEOUT = 15000;

export interface VaultConnectionConfig {
  address: string;
  namespace?: string | null;
  authMethod: 'token' | 'approle' | string;
  /** Decrypted token (authMethod=token) */
  token?: string | null;
  roleId?: string | null;
  /** Decrypted secret id (authMethod=approle) */
  secretId?: string | null;
  kvVersion?: number | null;
  mount?: string | null;
}

export interface VaultHealth {
  initialized: boolean;
  sealed: boolean;
  version?: string;
}

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultError';
  }
}

export function assertValidAddress(address: string): void {
  let parsed: URL;
  try {
    parsed = new URL(address);
  } catch {
    throw new VaultError(`Invalid Vault address: "${address}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new VaultError('Vault address must use http or https');
  }
}

export function assertSafePath(path: string): void {
  if (!path) throw new VaultError('Secret path is required');
  if (path.startsWith('/')) throw new VaultError('Secret path must be relative (no leading "/")');
  if (path.split('/').some((seg) => seg === '..' || seg === '.')) {
    throw new VaultError('Secret path must not contain "." or ".." segments');
  }
}

export class VaultClient {
  private clientToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(private readonly config: VaultConnectionConfig) {
    assertValidAddress(config.address);
  }

  private get baseUrl(): string {
    return this.config.address.replace(/\/+$/, '');
  }

  private get mount(): string {
    return this.config.mount || 'secret';
  }

  private buildHeaders(token?: string): Record<string, string> {
    const headers: Record<string, string> = {};
    if (token) headers['X-Vault-Token'] = token;
    if (this.config.namespace) headers['X-Vault-Namespace'] = this.config.namespace;
    return headers;
  }

  private encodePath(path: string): string {
    return path
      .split('/')
      .filter(Boolean)
      .map((seg) => encodeURIComponent(seg))
      .join('/');
  }

  secretUrl(secretPath: string): string {
    const mount = this.encodePath(this.mount);
    const path = this.encodePath(secretPath);
    if (this.config.kvVersion === 1) {
      return `${this.baseUrl}/v1/${mount}/${path}`;
    }
    return `${this.baseUrl}/v1/${mount}/data/${path}`;
  }

  async authenticate(): Promise<string> {
    if (this.config.authMethod !== 'approle') {
      if (!this.config.token) throw new VaultError('Vault token is not configured');
      return this.config.token;
    }
    const now = Date.now();
    if (this.clientToken && now < this.tokenExpiresAt) return this.clientToken;
    if (!this.config.roleId || !this.config.secretId) {
      throw new VaultError('AppRole credentials are not configured');
    }
    try {
      const res = await serverRequest<{ auth?: { client_token?: string; lease_duration?: number } }>({
        method: 'POST',
        url: `${this.baseUrl}/v1/auth/approle/login`,
        headers: this.buildHeaders(),
        data: { role_id: this.config.roleId, secret_id: this.config.secretId },
        timeout: REQUEST_TIMEOUT,
      });
      const auth = res.data?.auth;
      if (!auth?.client_token) throw new VaultError('AppRole login returned no client token');
      const lease = typeof auth.lease_duration === 'number' && auth.lease_duration > 0 ? auth.lease_duration : 300;
      this.clientToken = auth.client_token;
      // refresh at 80% of the lease to avoid using an about-to-expire token
      this.tokenExpiresAt = now + lease * 0.8 * 1000;
      return this.clientToken;
    } catch (err) {
      if (err instanceof VaultError) throw err;
      throw new VaultError(`AppRole login failed: ${toSafeErrorMessage(err)}`);
    }
  }

  async readSecret(secretPath: string, secretKey: string): Promise<string> {
    assertSafePath(secretPath);
    const token = await this.authenticate();
    let body: unknown;
    try {
      const res = await serverRequest<unknown>({
        method: 'GET',
        url: this.secretUrl(secretPath),
        headers: this.buildHeaders(token),
        timeout: REQUEST_TIMEOUT,
      });
      body = res.data;
    } catch (err) {
      throw new VaultError(`Failed to read secret "${secretPath}": ${toSafeErrorMessage(err)}`);
    }
    let secretData: unknown = (body as { data?: unknown } | undefined)?.data;
    if (this.config.kvVersion !== 1) {
      secretData = (secretData as { data?: unknown } | undefined)?.data;
    }
    if (!secretData || typeof secretData !== 'object') {
      throw new VaultError(`Secret not found at "${secretPath}"`);
    }
    const value = (secretData as Record<string, unknown>)[secretKey];
    if (value === undefined || value === null) {
      throw new VaultError(`Key "${secretKey}" not found in secret "${secretPath}"`);
    }
    return typeof value === 'string' ? value : JSON.stringify(value);
  }

  async verifyAuth(): Promise<void> {
    const token = await this.authenticate();
    try {
      await serverRequest<unknown>({
        method: 'GET',
        url: `${this.baseUrl}/v1/auth/token/lookup-self`,
        headers: this.buildHeaders(token),
        timeout: REQUEST_TIMEOUT,
      });
    } catch (err) {
      throw new VaultError(`Token verification failed: ${toSafeErrorMessage(err)}`);
    }
  }

  async healthCheck(): Promise<VaultHealth> {
    let body: unknown;
    try {
      // /v1/sys/health returns 429 (standby) / 503 (sealed) etc. — accept any status
      const res = await serverRequest<unknown>({
        method: 'GET',
        url: `${this.baseUrl}/v1/sys/health`,
        headers: this.buildHeaders(),
        timeout: REQUEST_TIMEOUT,
        validateStatus: () => true,
      });
      body = res.data;
    } catch (err) {
      throw new VaultError(`Vault health check failed: ${toSafeErrorMessage(err)}`);
    }
    const health = (body || {}) as { initialized?: boolean; sealed?: boolean; version?: string };
    if (health.sealed) throw new VaultError('Vault is sealed');
    if (health.initialized === false) throw new VaultError('Vault is not initialized');
    return {
      initialized: health.initialized !== false,
      sealed: !!health.sealed,
      version: health.version,
    };
  }
}
