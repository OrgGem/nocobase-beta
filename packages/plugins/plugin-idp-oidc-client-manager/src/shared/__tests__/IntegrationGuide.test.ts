import { describe, expect, it } from 'vitest';
import { buildIntegrationValues } from '../IntegrationGuide';
import type { ClientRecord } from '../OidcClientsPage';

function createClient(overrides: Partial<ClientRecord> = {}): ClientRecord {
  return {
    id: 1,
    name: 'Desktop app',
    clientId: 'desktop-client',
    redirectUris: ['http://127.0.0.1/callback'],
    postLogoutRedirectUris: [],
    scopes: ['openid', 'profile'],
    clientType: 'public',
    allowDynamicLoopbackPort: false,
    tokenEndpointAuthMethod: 'client_secret_basic',
    autoApprove: true,
    enabled: true,
    ...overrides,
  };
}

const provider = {
  issuer: 'https://nocobase.example.com/',
  discoveryUrl: 'https://nocobase.example.com/.well-known/openid-configuration',
};

describe('buildIntegrationValues', () => {
  it('shows a concrete dynamic port for a public native loopback client', () => {
    const values = buildIntegrationValues(createClient({ allowDynamicLoopbackPort: true }), provider);

    expect(values.redirectUri).toBe('http://127.0.0.1:49152/callback');
    expect(values.authorizationUrl).toContain('code_challenge_method=S256');
  });

  it('adds consent and resource parameters when refresh and API access are enabled', () => {
    const values = buildIntegrationValues(createClient({ scopes: ['openid', 'offline_access', 'api'] }), provider);
    const authorizationUrl = new URL(values.authorizationUrl);

    expect(authorizationUrl.searchParams.get('prompt')).toBe('consent');
    expect(authorizationUrl.searchParams.get('resource')).toBe('https://nocobase.example.com/');
    expect(authorizationUrl.searchParams.get('scope')).toBe('openid offline_access api');
  });

  it('does not add optional parameters when their scopes are absent', () => {
    const values = buildIntegrationValues(
      createClient({ clientType: 'confidential', allowDynamicLoopbackPort: false }),
      provider,
    );
    const authorizationUrl = new URL(values.authorizationUrl);

    expect(authorizationUrl.searchParams.has('prompt')).toBe(false);
    expect(authorizationUrl.searchParams.has('resource')).toBe(false);
  });
});
