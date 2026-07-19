import type { Repository } from '@nocobase/database';
import type { AesEncryptor } from '@nocobase/server';
import { describe, expect, it, vi } from 'vitest';
import {
  DatabaseOidcClientResolver,
  generateClientSecret,
  normalizeClientInput,
  serializeClient,
} from '../client-service';

describe('OIDC client service', () => {
  it('normalizes a confidential authorization-code client', () => {
    expect(
      normalizeClientInput({
        name: 'CRM',
        clientId: 'crm-production',
        redirectUris: ['https://crm.example.com/signin-oidc'],
        postLogoutRedirectUris: ['https://crm.example.com/signout-callback-oidc'],
        scopes: ['openid', 'profile', 'email', 'offline_access'],
        clientType: 'confidential',
        allowDynamicLoopbackPort: false,
        tokenEndpointAuthMethod: 'client_secret_basic',
        enabled: true,
      }),
    ).toEqual({
      name: 'CRM',
      clientId: 'crm-production',
      redirectUris: ['https://crm.example.com/signin-oidc'],
      postLogoutRedirectUris: ['https://crm.example.com/signout-callback-oidc'],
      scopes: ['openid', 'profile', 'email', 'offline_access'],
      clientType: 'confidential',
      allowDynamicLoopbackPort: false,
      tokenEndpointAuthMethod: 'client_secret_basic',
      autoApprove: false,
      enabled: true,
    });
  });

  it('rejects insecure remote callbacks and reserved client IDs', () => {
    const base = {
      name: 'CRM',
      postLogoutRedirectUris: [],
      scopes: ['openid'],
      clientType: 'confidential',
      allowDynamicLoopbackPort: false,
      tokenEndpointAuthMethod: 'client_secret_basic',
      enabled: true,
    };
    expect(() =>
      normalizeClientInput({ ...base, clientId: 'crm', redirectUris: ['http://crm.example.com/callback'] }),
    ).toThrow('HTTPS');
    expect(() =>
      normalizeClientInput({ ...base, clientId: 'app:crm', redirectUris: ['https://crm.example.com/callback'] }),
    ).toThrow('automatic approval');
  });

  it('allows HTTP loopback callbacks for local development', () => {
    expect(
      normalizeClientInput({
        name: 'Local CRM',
        clientId: 'local-crm',
        redirectUris: ['http://localhost:5000/signin-oidc'],
        postLogoutRedirectUris: [],
        scopes: ['openid', 'profile'],
        clientType: 'confidential',
        allowDynamicLoopbackPort: false,
        tokenEndpointAuthMethod: 'client_secret_post',
        enabled: true,
      }).redirectUris,
    ).toEqual(['http://localhost:5000/signin-oidc']);
  });

  it('returns provider metadata only for enabled clients', async () => {
    const record = {
      id: 1,
      name: 'CRM',
      clientId: 'crm-production',
      clientSecret: 'encrypted-field-decrypted-value',
      redirectUris: ['https://crm.example.com/signin-oidc'],
      postLogoutRedirectUris: [],
      scopes: ['openid', 'profile'],
      clientType: 'confidential' as const,
      allowDynamicLoopbackPort: false,
      tokenEndpointAuthMethod: 'client_secret_basic' as const,
      enabled: true,
    };
    const findOne = vi.fn().mockResolvedValue(record);
    const decrypt = vi.fn().mockResolvedValue('decrypted-client-secret');
    const resolver = new DatabaseOidcClientResolver(
      { findOne } as unknown as Repository,
      { decrypt } as unknown as AesEncryptor,
    );

    await expect(resolver.resolveClient('crm-production')).resolves.toMatchObject({
      client_id: 'crm-production',
      client_secret: 'decrypted-client-secret',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'openid profile',
    });
    expect(findOne).toHaveBeenCalledWith({ filter: { clientId: 'crm-production', enabled: true } });
    expect(decrypt).toHaveBeenCalledWith('encrypted-field-decrypted-value');
  });

  it('never serializes the client secret in list responses', () => {
    const publicRecord = serializeClient({
      id: 1,
      name: 'CRM',
      clientId: 'crm-production',
      clientSecret: 'must-not-leak',
      redirectUris: ['https://crm.example.com/callback'],
      postLogoutRedirectUris: [],
      scopes: ['openid'],
      clientType: 'confidential',
      allowDynamicLoopbackPort: false,
      tokenEndpointAuthMethod: 'client_secret_basic',
      enabled: true,
    });
    expect(publicRecord).not.toHaveProperty('clientSecret');
  });

  it('generates high-entropy, URL-safe unique secrets', () => {
    const first = generateClientSecret();
    const second = generateClientSecret();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
  });

  it('requires openid and rejects provider-unsupported scopes', () => {
    const base = {
      name: 'CRM',
      clientId: 'crm-production',
      redirectUris: ['https://crm.example.com/callback'],
      postLogoutRedirectUris: [],
      tokenEndpointAuthMethod: 'client_secret_basic',
      enabled: true,
    };
    expect(() => normalizeClientInput({ ...base, scopes: ['profile'] })).toThrow('include openid');
    expect(() => normalizeClientInput({ ...base, scopes: ['openid', 'custom:write'] })).toThrow('not supported');
  });

  it('resolves a public native client without decrypting or returning a client secret', async () => {
    const findOne = vi.fn().mockResolvedValue({
      id: 2,
      name: 'Desktop app',
      clientId: 'desktop-app',
      clientSecret: null,
      redirectUris: ['http://127.0.0.1/callback'],
      postLogoutRedirectUris: [],
      scopes: ['openid', 'profile', 'offline_access'],
      clientType: 'public',
      allowDynamicLoopbackPort: true,
      tokenEndpointAuthMethod: 'client_secret_basic',
      autoApprove: false,
      enabled: true,
    });
    const decrypt = vi.fn();
    const resolver = new DatabaseOidcClientResolver(
      { findOne } as unknown as Repository,
      { decrypt } as unknown as AesEncryptor,
    );

    const metadata = await resolver.resolveClient('desktop-app');
    expect(metadata).toMatchObject({
      client_id: 'desktop-app',
      application_type: 'native',
      token_endpoint_auth_method: 'none',
      redirect_uris: ['http://127.0.0.1/callback'],
    });
    expect(metadata).not.toHaveProperty('client_secret');
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('only enables dynamic ports for public HTTP loopback redirects', () => {
    const base = {
      name: 'Desktop app',
      clientId: 'desktop-app',
      postLogoutRedirectUris: [],
      scopes: ['openid'],
      clientType: 'public',
      allowDynamicLoopbackPort: true,
      enabled: true,
    };
    expect(
      normalizeClientInput({ ...base, redirectUris: ['http://127.0.0.1/callback'] }).allowDynamicLoopbackPort,
    ).toBe(true);
    expect(() => normalizeClientInput({ ...base, redirectUris: ['https://desktop.example.com/callback'] })).toThrow(
      'HTTP loopback',
    );
    expect(() =>
      normalizeClientInput({
        ...base,
        clientType: 'confidential',
        tokenEndpointAuthMethod: 'client_secret_basic',
        redirectUris: ['http://127.0.0.1/callback'],
      }),
    ).toThrow('only available to public');
  });
});
