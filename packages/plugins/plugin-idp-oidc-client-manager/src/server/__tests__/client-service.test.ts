import type { Repository } from '@nocobase/database';
import { describe, expect, it, vi } from 'vitest';
import { DatabaseOidcClientResolver, normalizeClientInput, serializeClient } from '../client-service';

const publicInput = {
  name: 'Desktop app',
  clientId: 'desktop-app',
  redirectUris: ['https://desktop.example.com/callback'],
  postLogoutRedirectUris: [],
  scopes: ['openid', 'profile'],
  clientType: 'public',
  allowDynamicLoopbackPort: false,
  tokenEndpointAuthMethod: 'none',
  enabled: true,
};

describe('OIDC public client service', () => {
  it('normalizes a public authorization-code client with PKCE metadata', () => {
    expect(normalizeClientInput(publicInput)).toEqual({
      name: 'Desktop app',
      clientId: 'desktop-app',
      redirectUris: ['https://desktop.example.com/callback'],
      postLogoutRedirectUris: [],
      scopes: ['openid', 'profile'],
      clientType: 'public',
      allowDynamicLoopbackPort: false,
      tokenEndpointAuthMethod: 'none',
      autoApprove: false,
      enabled: true,
    });
  });

  it('rejects confidential, client-credentials, and secret-bearing configurations', () => {
    expect(() => normalizeClientInput({ ...publicInput, clientType: 'confidential' })).toThrow(
      'Only public clients are supported',
    );
    expect(() => normalizeClientInput({ ...publicInput, grantTypes: ['client_credentials'] })).toThrow(
      'Only the authorization_code grant type is supported',
    );
    expect(() => normalizeClientInput({ ...publicInput, tokenEndpointAuthMethod: 'client_secret_basic' })).toThrow(
      'Public clients must use token endpoint authentication none',
    );
    expect(() => normalizeClientInput({ ...publicInput, serviceUserId: 7 })).toThrow(
      'Client secret and service-user credentials are disabled',
    );
    expect(() => normalizeClientInput({ ...publicInput, clientSecret: 'secret' })).toThrow(
      'Client secret and service-user credentials are disabled',
    );
  });

  it('requires the public client type instead of defaulting to confidential', () => {
    const { clientType: _clientType, ...missingType } = publicInput;
    expect(() => normalizeClientInput(missingType)).toThrow('Only public clients are supported');
  });

  it('rejects insecure callbacks and preserves client IDs exactly', () => {
    expect(() =>
      normalizeClientInput({ ...publicInput, redirectUris: ['http://desktop.example.com/callback'] }),
    ).toThrow('HTTPS');
    expect(
      normalizeClientInput({
        ...publicInput,
        clientId: 'app:desktop-app',
        autoApprove: true,
      }).clientId,
    ).toBe('app:desktop-app');
  });

  it('allows HTTP loopback callbacks and dynamic ports for native public clients', () => {
    expect(
      normalizeClientInput({
        ...publicInput,
        redirectUris: ['http://127.0.0.1/callback'],
        allowDynamicLoopbackPort: true,
      }).allowDynamicLoopbackPort,
    ).toBe(true);
    expect(() =>
      normalizeClientInput({
        ...publicInput,
        redirectUris: ['https://desktop.example.com/callback'],
        allowDynamicLoopbackPort: true,
      }),
    ).toThrow('HTTP loopback');
  });

  it('requires openid and rejects provider-unsupported scopes', () => {
    expect(() => normalizeClientInput({ ...publicInput, scopes: ['profile'] })).toThrow('include openid');
    expect(() => normalizeClientInput({ ...publicInput, scopes: ['openid', 'custom:write'] })).toThrow('not supported');
  });

  it('resolves only enabled public clients without a client secret', async () => {
    const findOne = vi.fn().mockResolvedValue({
      id: 1,
      name: 'Desktop app',
      clientId: 'desktop-app',
      clientSecret: null,
      redirectUris: ['http://127.0.0.1/callback'],
      postLogoutRedirectUris: [],
      scopes: ['openid', 'profile', 'offline_access'],
      clientType: 'public' as const,
      allowDynamicLoopbackPort: true,
      tokenEndpointAuthMethod: 'none' as const,
      enabled: true,
    });
    const resolver = new DatabaseOidcClientResolver({ findOne } as unknown as Repository);

    await expect(resolver.resolveClient('desktop-app')).resolves.toMatchObject({
      client_id: 'desktop-app',
      application_type: 'native',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      redirect_uris: ['http://127.0.0.1/callback'],
    });
    await expect(resolver.resolveClient('desktop-app')).resolves.not.toHaveProperty('client_secret');
    expect(findOne).toHaveBeenCalledWith({ filter: { clientId: 'desktop-app', enabled: true } });
  });

  it('does not resolve an existing confidential record after public-only mode is enabled', async () => {
    const resolver = new DatabaseOidcClientResolver({
      findOne: vi.fn().mockResolvedValue({ clientId: 'legacy-confidential', clientType: 'confidential' }),
    } as unknown as Repository);

    await expect(resolver.resolveClient('legacy-confidential')).resolves.toBeUndefined();
  });

  it('never serializes a client secret and hides non-public records', () => {
    const publicRecord = serializeClient({
      id: 1,
      name: 'Desktop app',
      clientId: 'desktop-app',
      clientSecret: 'must-not-leak',
      redirectUris: ['https://desktop.example.com/callback'],
      postLogoutRedirectUris: [],
      scopes: ['openid'],
      clientType: 'public',
      allowDynamicLoopbackPort: false,
      tokenEndpointAuthMethod: 'none',
      enabled: true,
    });
    expect(publicRecord).not.toHaveProperty('clientSecret');
    const legacyRecord = {
      id: 2,
      name: 'Legacy confidential',
      clientId: 'legacy-confidential',
      redirectUris: ['https://legacy.example.com/callback'],
      postLogoutRedirectUris: [],
      scopes: ['openid'],
      clientType: 'confidential',
      allowDynamicLoopbackPort: false,
      tokenEndpointAuthMethod: 'client_secret_basic',
      autoApprove: false,
      enabled: true,
    };
    expect(serializeClient(legacyRecord as unknown as Parameters<typeof serializeClient>[0])).toBeNull();
  });
});
