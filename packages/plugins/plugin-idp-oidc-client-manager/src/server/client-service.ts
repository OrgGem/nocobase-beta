import { randomBytes } from 'node:crypto';
import type { Repository } from '@nocobase/database';
import type { OidcClientMetadata, OidcClientResolver } from '@nocobase/plugin-idp-oauth';
import type { AesEncryptor } from '@nocobase/server';

export const COLLECTION_NAME = 'oidcClients';
export const SECRET_BYTES = 32;
export const AUTH_METHODS = ['client_secret_basic', 'client_secret_post'] as const;
export const DEFAULT_SCOPES = ['openid', 'profile', 'email'] as const;
export const PROVIDER_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'api'] as const;

export type TokenEndpointAuthMethod = (typeof AUTH_METHODS)[number];
export type OidcClientType = 'confidential' | 'public';

export type ClientInput = {
  name: string;
  clientId: string;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  scopes: string[];
  clientType: OidcClientType;
  allowDynamicLoopbackPort: boolean;
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  autoApprove: boolean;
  enabled: boolean;
};

type ClientRecord = ClientInput & {
  id: number;
  clientSecret?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

function isAuthMethod(value: unknown): value is TokenEndpointAuthMethod {
  return typeof value === 'string' && AUTH_METHODS.includes(value as TokenEndpointAuthMethod);
}

function normalizeUriList(value: unknown, field: string, allowEmpty: boolean): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  const normalized = [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
  if (!allowEmpty && normalized.length === 0) throw new Error(`${field} must contain at least one URI`);
  for (const uri of normalized) {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      throw new Error(`${field} contains an invalid URI: ${uri}`);
    }
    const isLoopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
      throw new Error(`${field} must use HTTPS, except HTTP loopback URIs`);
    }
    if (parsed.hash) throw new Error(`${field} must not contain a fragment`);
  }
  return normalized;
}

function normalizeScopes(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('scopes must be an array');
  const scopes = [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
  if (!scopes.includes('openid')) throw new Error('scopes must include openid');
  for (const scope of scopes) {
    if (!/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope)) throw new Error(`Invalid scope: ${scope}`);
    if (!PROVIDER_SCOPES.includes(scope as (typeof PROVIDER_SCOPES)[number])) {
      throw new Error(`Scope is not supported by the provider: ${scope}`);
    }
  }
  return scopes;
}

function isLoopbackUri(uri: string) {
  const parsed = new URL(uri);
  return parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname);
}

export function normalizeClientInput(value: unknown): ClientInput {
  if (!value || typeof value !== 'object') throw new Error('Client configuration is required');
  const input = value as Record<string, unknown>;
  const name = String(input.name ?? '').trim();
  const requestedClientId = String(input.clientId ?? '').trim();
  const autoApprove = input.autoApprove === true;
  const clientType: OidcClientType = input.clientType === 'public' ? 'public' : 'confidential';
  const allowDynamicLoopbackPort = input.allowDynamicLoopbackPort === true;
  const clientId =
    autoApprove && !requestedClientId.startsWith('app:') ? `app:${requestedClientId}` : requestedClientId;
  if (!name) throw new Error('name is required');
  const clientIdValue = clientId.startsWith('app:') ? clientId.slice(4) : clientId;
  if (!/^[A-Za-z0-9._~-]{3,128}$/.test(clientIdValue)) {
    throw new Error('clientId must contain 3-128 safe characters');
  }
  if (clientId.startsWith('app:') && !autoApprove) {
    throw new Error('The app: client ID prefix requires automatic approval');
  }
  if (clientType === 'confidential' && !isAuthMethod(input.tokenEndpointAuthMethod)) {
    throw new Error('Unsupported token endpoint auth method');
  }
  const redirectUris = normalizeUriList(input.redirectUris, 'redirectUris', false);
  if (allowDynamicLoopbackPort && clientType !== 'public') {
    throw new Error('Dynamic loopback ports are only available to public clients');
  }
  if (allowDynamicLoopbackPort && !redirectUris.every(isLoopbackUri)) {
    throw new Error('Dynamic loopback ports require HTTP loopback redirect URIs');
  }
  return {
    name,
    clientId,
    redirectUris,
    postLogoutRedirectUris: normalizeUriList(input.postLogoutRedirectUris ?? [], 'postLogoutRedirectUris', true),
    scopes: normalizeScopes(input.scopes ?? DEFAULT_SCOPES),
    clientType,
    allowDynamicLoopbackPort,
    tokenEndpointAuthMethod:
      clientType === 'public' ? 'client_secret_basic' : (input.tokenEndpointAuthMethod as TokenEndpointAuthMethod),
    autoApprove,
    enabled: input.enabled !== false,
  };
}

export function generateClientSecret() {
  return randomBytes(SECRET_BYTES).toString('base64url');
}

export function serializeClient(record: ClientRecord) {
  return {
    id: record.id,
    name: record.name,
    clientId: record.clientId,
    redirectUris: record.redirectUris,
    postLogoutRedirectUris: record.postLogoutRedirectUris,
    scopes: record.scopes?.length ? record.scopes : [...DEFAULT_SCOPES],
    clientType: record.clientType || 'confidential',
    allowDynamicLoopbackPort: record.allowDynamicLoopbackPort === true,
    tokenEndpointAuthMethod: record.tokenEndpointAuthMethod,
    autoApprove: record.autoApprove,
    enabled: record.enabled,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export class DatabaseOidcClientResolver implements OidcClientResolver {
  constructor(
    private readonly repository: Repository,
    private readonly encryptor: AesEncryptor,
  ) {}

  async resolveClient(clientId: string): Promise<OidcClientMetadata | undefined> {
    const record = (await this.repository.findOne({ filter: { clientId, enabled: true } })) as ClientRecord | null;
    if (!record) return undefined;
    const clientType = record.clientType || 'confidential';
    const metadata: OidcClientMetadata = {
      client_id: record.clientId,
      client_name: record.name,
      redirect_uris: record.redirectUris,
      post_logout_redirect_uris: record.postLogoutRedirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      application_type: clientType === 'public' && record.allowDynamicLoopbackPort ? 'native' : 'web',
      token_endpoint_auth_method: clientType === 'public' ? 'none' : record.tokenEndpointAuthMethod,
      scope: (record.scopes?.length ? record.scopes : DEFAULT_SCOPES).join(' '),
    };
    if (clientType === 'confidential') {
      if (!record.clientSecret) return undefined;
      metadata.client_secret = await this.encryptor.decrypt(record.clientSecret);
    }
    return metadata;
  }
}
