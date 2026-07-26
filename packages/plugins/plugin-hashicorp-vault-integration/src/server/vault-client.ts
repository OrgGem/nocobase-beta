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

export interface VaultPathEntry {
  name: string;
  path: string;
  isFolder: boolean;
}

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultError';
  }
}

function isNotFound(err: unknown): boolean {
  return (err as { response?: { status?: number } } | undefined)?.response?.status === 404;
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

  listUrl(secretPath = ''): string {
    const mount = this.encodePath(this.mount);
    const path = this.encodePath(secretPath);
    const suffix = path ? `/${path}` : '';
    if (this.config.kvVersion === 1) {
      return `${this.baseUrl}/v1/${mount}${suffix}`;
    }
    return `${this.baseUrl}/v1/${mount}/metadata${suffix}`;
  }

  async listPath(secretPath = ''): Promise<VaultPathEntry[]> {
    if (secretPath) assertSafePath(secretPath);
    const token = await this.authenticate();
    let body: unknown;
    try {
      // GET + ?list=true is Vault's proxy-friendly equivalent of the non-standard LIST method
      const res = await serverRequest<unknown>({
        method: 'GET',
        url: this.listUrl(secretPath),
        params: { list: 'true' },
        headers: this.buildHeaders(token),
        timeout: REQUEST_TIMEOUT,
      });
      body = res.data;
    } catch (err) {
      // Vault answers 404 when a path has no children — an empty folder, not an error
      if (isNotFound(err)) return [];
      throw new VaultError(`Failed to list Vault path "${secretPath || '/'}": ${toSafeErrorMessage(err)}`);
    }

    const keys = (body as { data?: { keys?: unknown } } | undefined)?.data?.keys;
    if (!Array.isArray(keys)) return [];
    const prefix = secretPath ? `${secretPath.replace(/\/+$/, '')}/` : '';
    return keys
      .filter((key): key is string => typeof key === 'string' && key.length > 0)
      .map((key) => {
        const isFolder = key.endsWith('/');
        const name = isFolder ? key.slice(0, -1) : key;
        return { name, path: `${prefix}${name}`, isFolder };
      });
  }

  async listAllPaths(
    secretPath = '',
    options: { maxDepth?: number; maxEntries?: number } = {},
  ): Promise<{ entries: VaultPathEntry[]; truncated: boolean }> {
    const maxDepth = options.maxDepth ?? 10;
    const maxEntries = options.maxEntries ?? 2000;
    const entries: VaultPathEntry[] = [];
    let truncated = false;
    const queue: { path: string; depth: number }[] = [{ path: secretPath, depth: 0 }];
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      const children = await this.listPath(item.path);
      for (const child of children) {
        if (entries.length >= maxEntries) {
          return { entries, truncated: true };
        }
        entries.push(child);
        if (child.isFolder) {
          if (item.depth + 1 < maxDepth) {
            queue.push({ path: child.path, depth: item.depth + 1 });
          } else {
            truncated = true;
          }
        }
      }
    }
    return { entries, truncated };
  }

  async listSecretKeys(secretPath: string): Promise<string[]> {
    const secretData = await this.fetchSecretData(secretPath);
    if (!secretData) return [];
    return Object.keys(secretData).sort();
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

  private async fetchSecretData(secretPath: string): Promise<Record<string, unknown> | null> {
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
      if (isNotFound(err)) return null;
      throw new VaultError(`Failed to read secret "${secretPath}": ${toSafeErrorMessage(err)}`);
    }
    let secretData: unknown = (body as { data?: unknown } | undefined)?.data;
    if (this.config.kvVersion !== 1) {
      secretData = (secretData as { data?: unknown } | undefined)?.data;
    }
    if (!secretData || typeof secretData !== 'object') return null;
    return secretData as Record<string, unknown>;
  }

  async readSecret(secretPath: string, secretKey: string): Promise<string> {
    const secretData = await this.fetchSecretData(secretPath);
    if (!secretData) {
      throw new VaultError(`Secret not found at "${secretPath}"`);
    }
    const value = secretData[secretKey];
    if (value === undefined || value === null) {
      throw new VaultError(`Key "${secretKey}" not found in secret "${secretPath}"`);
    }
    return typeof value === 'string' ? value : JSON.stringify(value);
  }

  /** Write a full secret payload (replaces every key at the path). */
  async writeSecret(secretPath: string, data: Record<string, unknown>): Promise<void> {
    assertSafePath(secretPath);
    const token = await this.authenticate();
    const payload = this.config.kvVersion === 1 ? data : { data };
    try {
      await serverRequest<unknown>({
        method: 'POST',
        url: this.secretUrl(secretPath),
        headers: this.buildHeaders(token),
        data: payload,
        timeout: REQUEST_TIMEOUT,
      });
    } catch (err) {
      throw new VaultError(`Failed to write secret "${secretPath}": ${toSafeErrorMessage(err)}`);
    }
  }

  /** Set a single key, preserving the other keys already stored at the path. */
  async setSecretKey(secretPath: string, secretKey: string, value: string): Promise<void> {
    if (!secretKey) throw new VaultError('Secret key is required');
    const existing = (await this.fetchSecretData(secretPath)) || {};
    await this.writeSecret(secretPath, { ...existing, [secretKey]: value });
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
