import type { Repository } from '@nocobase/database';
import type { OidcClientMetadata, OidcClientResolver } from '@nocobase/plugin-idp-oauth';

export const COLLECTION_NAME = 'oidcClients';
export const PUBLIC_AUTH_METHOD = 'none' as const;
export const AUTHORIZATION_CODE_GRANT = 'authorization_code' as const;
export const DEFAULT_SCOPES = ['openid', 'profile', 'email'] as const;
export const PROVIDER_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'api'] as const;

export type OidcClientType = 'public';
export type ClientInput = {
  name: string;
  clientId: string;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  scopes: string[];
  clientType: OidcClientType;
  allowDynamicLoopbackPort: boolean;
  tokenEndpointAuthMethod: typeof PUBLIC_AUTH_METHOD;
  autoApprove: boolean;
  enabled: boolean;
};

type ClientRecord = ClientInput & {
  id: number;
  clientSecret?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

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
  const requested = typeof value === 'undefined' ? [...DEFAULT_SCOPES] : value;
  if (!Array.isArray(requested)) throw new Error('scopes must be an array');
  const scopes = [...new Set(requested.map((item) => String(item).trim()).filter(Boolean))];
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

function assertPublicOnly(input: Record<string, unknown>) {
  if (input.clientType !== 'public') throw new Error('Only public clients are supported');
  if (typeof input.tokenEndpointAuthMethod !== 'undefined' && input.tokenEndpointAuthMethod !== PUBLIC_AUTH_METHOD) {
    throw new Error('Public clients must use token endpoint authentication none');
  }
  if (
    Array.isArray(input.grantTypes) &&
    (input.grantTypes.length !== 1 || input.grantTypes[0] !== AUTHORIZATION_CODE_GRANT)
  ) {
    throw new Error('Only the authorization_code grant type is supported');
  }
  if (typeof input.serviceUserId !== 'undefined' || typeof input.clientSecret !== 'undefined') {
    throw new Error('Client secret and service-user credentials are disabled');
  }
}

export function normalizeClientInput(value: unknown): ClientInput {
  if (!value || typeof value !== 'object') throw new Error('Client configuration is required');
  const input = value as Record<string, unknown>;
  assertPublicOnly(input);
  const name = String(input.name ?? '').trim();
  const clientId = String(input.clientId ?? '').trim();
  const allowDynamicLoopbackPort = input.allowDynamicLoopbackPort === true;
  if (!name) throw new Error('name is required');
  const clientIdValue = clientId.startsWith('app:') ? clientId.slice(4) : clientId;
  if (!/^[A-Za-z0-9._~-]{3,128}$/.test(clientIdValue)) {
    throw new Error('clientId must contain 3-128 safe characters');
  }
  const redirectUris = normalizeUriList(input.redirectUris ?? [], 'redirectUris', false);
  if (allowDynamicLoopbackPort && !redirectUris.every(isLoopbackUri)) {
    throw new Error('Dynamic loopback ports require HTTP loopback redirect URIs');
  }
  return {
    name,
    clientId,
    redirectUris,
    postLogoutRedirectUris: normalizeUriList(input.postLogoutRedirectUris ?? [], 'postLogoutRedirectUris', true),
    scopes: normalizeScopes(input.scopes),
    clientType: 'public',
    allowDynamicLoopbackPort,
    tokenEndpointAuthMethod: PUBLIC_AUTH_METHOD,
    autoApprove: false,
    enabled: input.enabled !== false,
  };
}

export function serializeClient(record: ClientRecord) {
  if (record.clientType !== 'public') return null;
  return {
    id: record.id,
    name: record.name,
    clientId: record.clientId,
    redirectUris: record.redirectUris,
    postLogoutRedirectUris: record.postLogoutRedirectUris,
    scopes: record.scopes?.length ? record.scopes : [...DEFAULT_SCOPES],
    clientType: 'public' as const,
    allowDynamicLoopbackPort: record.allowDynamicLoopbackPort === true,
    tokenEndpointAuthMethod: PUBLIC_AUTH_METHOD,
    enabled: record.enabled,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export class DatabaseOidcClientResolver implements OidcClientResolver {
  constructor(private readonly repository: Repository) {}

  async resolveClient(clientId: string): Promise<OidcClientMetadata | undefined> {
    const record = (await this.repository.findOne({ filter: { clientId, enabled: true } })) as ClientRecord | null;
    if (!record || record.clientType !== 'public') return undefined;
    return {
      client_id: record.clientId,
      client_name: record.name,
      redirect_uris: record.redirectUris,
      post_logout_redirect_uris: record.postLogoutRedirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      application_type: record.allowDynamicLoopbackPort ? 'native' : 'web',
      token_endpoint_auth_method: PUBLIC_AUTH_METHOD,
      scope: (record.scopes?.length ? record.scopes : DEFAULT_SCOPES).join(' '),
    };
  }
}
