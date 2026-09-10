import { RegistryRequestError } from './registry-client';
import { resolveEcrCredentialsProvider, type EcrClientConfigOptions, type EcrCredentialsProvider } from './ecr-client';

/**
 * Minimal structural type for an ECR client instance. Production builds a real
 * `ECRClient` from `@aws-sdk/client-ecr`; tests inject a mock with the same
 * shape so no AWS SDK call is ever made in unit tests.
 */
export interface EcrClientLike {
  send(command: unknown): Promise<{
    authorizationData?: Array<{ authorizationToken?: string; expiresAt?: Date }>;
  }>;
}

export type EcrClientFactory = (config: { region: string; credentials?: EcrCredentialsProvider }) => EcrClientLike;

export interface EcrAuthOptions extends EcrClientConfigOptions {
  region: string;
  registryHost: string;
  createClient?: EcrClientFactory;
}

const REFRESH_BUFFER_MS = 30 * 60_000;
const FALLBACK_TTL_MS = 12 * 60 * 60_000;

interface EcrTokenCacheEntry {
  token: string;
  expiresAt: number;
}

const ecrTokenCache = new Map<string, EcrTokenCacheEntry>();
const ecrRefreshPromises = new Map<string, Promise<string>>();

interface EcrSdkModule {
  ECRClient: new (config: { region: string; credentials?: EcrCredentialsProvider }) => EcrClientLike;
  GetAuthorizationTokenCommand: new (input: object) => unknown;
}

function defaultCreateClient(config: { region: string; credentials?: EcrCredentialsProvider }): EcrClientLike {
  let ecrModule: EcrSdkModule;
  try {
    ecrModule = require('@aws-sdk/client-ecr') as EcrSdkModule;
  } catch (error) {
    throw new Error(
      '[docker-registry-ui] @aws-sdk/client-ecr is required for ECR credential mode. Please run `npm install @aws-sdk/client-ecr`.',
    );
  }
  return new ecrModule.ECRClient(config);
}

function requireEcrCommand(): { GetAuthorizationTokenCommand: new (input: object) => unknown } {
  let ecrModule: EcrSdkModule;
  try {
    ecrModule = require('@aws-sdk/client-ecr') as EcrSdkModule;
  } catch (error) {
    throw new Error(
      '[docker-registry-ui] @aws-sdk/client-ecr is required for ECR credential mode. Please run `npm install @aws-sdk/client-ecr`.',
    );
  }
  return ecrModule;
}

/** Test-only: clears the shared token cache so tests do not leak state. */
export function clearEcrAuthCacheForTests(): void {
  ecrTokenCache.clear();
  ecrRefreshPromises.clear();
}

export class EcrAuthProvider {
  private readonly cacheKey: string;

  constructor(private readonly options: EcrAuthOptions) {
    this.cacheKey = `${options.region}|${options.registryHost}`;
  }

  /** Returns the full `Authorization` header value: `Basic <authorizationToken>`. */
  async getAuthorizationHeader(): Promise<string> {
    const token = await this.getToken(false);
    return `Basic ${token}`;
  }

  /** Invalidates the cached token and fetches a fresh one. */
  async forceRefresh(): Promise<void> {
    ecrTokenCache.delete(this.cacheKey);
    await this.getToken(true);
  }

  /** Validates the ECR configuration by calling GetAuthorizationToken once (used by testConnection). */
  async validate(): Promise<void> {
    await this.getToken(true);
  }

  private async getToken(force: boolean): Promise<string> {
    if (!force) {
      const cached = ecrTokenCache.get(this.cacheKey);
      if (cached && cached.expiresAt > Date.now() + REFRESH_BUFFER_MS) return cached.token;
    }

    const inflight = ecrRefreshPromises.get(this.cacheKey);
    if (inflight && !force) return inflight;

    const refreshPromise = this.fetchToken();
    ecrRefreshPromises.set(this.cacheKey, refreshPromise);
    try {
      return await refreshPromise;
    } finally {
      if (ecrRefreshPromises.get(this.cacheKey) === refreshPromise) {
        ecrRefreshPromises.delete(this.cacheKey);
      }
    }
  }

  private async fetchToken(): Promise<string> {
    const credentials = resolveEcrCredentialsProvider(this.options);
    const createClient = this.options.createClient ?? defaultCreateClient;
    const client = createClient({ region: this.options.region, credentials });

    let authorizationToken: string | undefined;
    let expiresAt: Date | undefined;
    try {
      const { GetAuthorizationTokenCommand } = requireEcrCommand();
      const response = await client.send(new GetAuthorizationTokenCommand({}));
      const entry = response.authorizationData?.[0];
      authorizationToken = entry?.authorizationToken;
      expiresAt = entry?.expiresAt;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new RegistryRequestError(`ECR GetAuthorizationToken failed: ${message}`, 403, 'ECR_AUTH_FAILED');
    }

    if (!authorizationToken) {
      throw new RegistryRequestError(
        'ECR GetAuthorizationToken returned no authorization token',
        403,
        'ECR_AUTH_FAILED',
      );
    }

    const now = Date.now();
    const expiresAtMs = expiresAt ? expiresAt.getTime() : now + FALLBACK_TTL_MS;
    ecrTokenCache.set(this.cacheKey, { token: authorizationToken, expiresAt: expiresAtMs });
    return authorizationToken;
  }
}
