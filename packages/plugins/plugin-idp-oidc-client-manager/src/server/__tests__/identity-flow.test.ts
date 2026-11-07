/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Provider, type AdapterPayload, type Configuration } from 'oidc-provider';
import inject from 'light-my-request';
import Koa from 'koa';
import { ACL } from '@nocobase/acl';
import { Resourcer } from '@nocobase/resourcer';
import type { Context } from '@nocobase/actions';
import type { Repository } from '@nocobase/database';
import { IdpOauthService, type ProviderContext } from '../../../../@nocobase/plugin-idp-oauth/src/server/service';
import { OIDCAuth } from '../../../../plugin-oidc-auth/src/server/oidc-auth';
import type { OidcTransaction } from '../../../../plugin-oidc-auth/src/server/security';
import { DatabaseOidcClientResolver, normalizeClientInput } from '../client-service';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const issuer = 'https://idp.example.test/api';
const apiResource = `${issuer}/`;
const mcpResource = `${issuer}/mcp`;
const redirectUri = 'https://client.example.test/callback';
const verifier = 'original-pkce-verifier-with-at-least-forty-three-characters';

async function fixture(withMcp = false) {
  const stores = new Map<string, Map<string, AdapterPayload>>();
  class MemoryAdapter {
    private store: Map<string, AdapterPayload>;
    constructor(name: string) {
      this.store = stores.get(name) || new Map();
      stores.set(name, this.store);
    }
    async upsert(id: string, payload: AdapterPayload) {
      this.store.set(id, structuredClone(payload));
    }
    async find(id: string) {
      const found = this.store.get(id);
      return found && structuredClone(found);
    }
    async destroy(id: string) {
      this.store.delete(id);
    }
    async consume(id: string) {
      const found = this.store.get(id);
      if (found) found.consumed = Math.floor(Date.now() / 1000);
    }
    async revokeByGrantId(grantId: string) {
      for (const [id, found] of this.store) if (found.grantId === grantId) this.store.delete(id);
    }
    async findByUid(uid: string) {
      return [...this.store.values()].find((found) => found.uid === uid);
    }
    async findByUserCode(code: string) {
      return [...this.store.values()].find((found) => found.userCode === code);
    }
  }
  const user = { id: 17, username: 'review-user', email: 'unverified@example.test' };
  const tokenController = {
    getConfig: vi.fn().mockResolvedValue({ tokenExpirationTime: 3600000, sessionExpirationTime: 7200000 }),
    add: vi.fn().mockResolvedValue({ jti: 'internal-test-jti', signInTime: Date.now() }),
  };
  const app = {
    name: 'main',
    authManager: {
      jwt: { getSecret: () => 'temporary-test-cookie-key', sign: vi.fn().mockReturnValue('internal-test-session') },
      tokenController,
    },
    db: { getRepository: () => ({ findOne: vi.fn().mockResolvedValue(user) }) },
  };
  const service = new IdpOauthService(
    app as unknown as ConstructorParameters<typeof IdpOauthService>[0],
    { get: vi.fn(), set: vi.fn() } as unknown as ConstructorParameters<typeof IdpOauthService>[1],
  );
  service.registerResourceServer('api', {
    path: '/',
    scope: 'api',
    accessTokenFormat: 'jwt',
    jwt: { sign: { alg: 'RS256' } },
  });
  if (withMcp) {
    service.registerResourceServer('mcp', {
      path: '/mcp',
      scope: 'mcp offline_access',
      accessTokenFormat: 'jwt',
      jwt: { sign: { alg: 'RS256' } },
    });
  }
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwks = { keys: [{ ...(await exportJWK(privateKey)), kid: 'test-key', alg: 'RS256', use: 'sig' }] };
  const internals = service as unknown as {
    getProviderSigningJwks: () => Promise<typeof jwks>;
    createConfiguration: (ctx: ProviderContext) => Promise<Configuration>;
  };
  vi.spyOn(internals, 'getProviderSigningJwks').mockResolvedValue(jwks);
  const config = await internals.createConfiguration({
    appName: 'main',
    issuer,
    issuerPath: '/api',
    origin: 'https://idp.example.test',
  });
  const record = normalizeClientInput({
    name: 'Public client',
    clientId: 'public-client',
    clientType: 'public',
    redirectUris: [redirectUri],
    scopes: ['openid', 'profile', 'email', 'offline_access', 'api'],
  });
  const resolver = new DatabaseOidcClientResolver({ findOne: async () => record } as unknown as Repository);
  const publicClient = await resolver.resolveClient(record.clientId);
  assert(publicClient);
  const provider = new Provider(issuer, {
    ...config,
    adapter: MemoryAdapter,
    clients: [
      { ...publicClient, scope: `${publicClient.scope}${withMcp ? ' mcp' : ''}` },
      ...(['client_secret_basic', 'client_secret_post'] as const).map((method) => ({
        ...publicClient,
        client_id: method,
        client_secret: 'test-confidential-secret',
        token_endpoint_auth_method: method,
      })),
    ],
  });
  provider.proxy = true;
  vi.spyOn(service, 'ensureProvider').mockResolvedValue(provider);
  async function request(path: string, body?: Record<string, string>, token?: string) {
    return inject(provider.callback(), {
      method: body ? 'POST' : 'GET',
      url: path,
      headers: {
        host: 'idp.example.test',
        'x-forwarded-proto': 'https',
        ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { payload: new URLSearchParams(body).toString() } : {}),
    });
  }
  async function authorizationCode(
    scope: string,
    resource?: string,
    options: {
      clientId?: string;
      nonce?: string;
      challenge?: string;
    } = {},
  ) {
    const clientId = options.clientId || record.clientId;
    const client = await provider.Client.find(clientId);
    assert(client);
    const grant = new provider.Grant({ accountId: String(user.id), clientId });
    grant.addOIDCScope(
      scope
        .split(' ')
        .filter((item) => item !== 'api' && item !== 'mcp')
        .join(' '),
    );
    if (resource)
      grant.addResourceScope(
        resource,
        scope
          .split(' ')
          .filter((item) => ['api', 'mcp'].includes(item))
          .join(' '),
      );
    return new provider.AuthorizationCode({
      gty: 'authorization_code',
      accountId: String(user.id),
      client,
      grantId: await grant.save(),
      scope,
      resource,
      redirectUri,
      nonce: options.nonce,
      codeChallenge: options.challenge || createHash('sha256').update(verifier).digest('base64url'),
      codeChallengeMethod: 'S256',
    }).save();
  }
  async function exchange(scope: string, resource?: string) {
    const code = await authorizationCode(scope, resource);
    const response = await request('/idpOAuth/token', {
      grant_type: 'authorization_code',
      client_id: record.clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      ...(resource ? { resource } : {}),
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ access_token: string; id_token: string; refresh_token: string }>();
  }
  return { provider, service, config, request, authorizationCode, exchange, privateKey, user, tokenController };
}

describe('OIDC identity and resource tokens', () => {
  it.each([false, true])('keeps UserInfo and refresh usable with multiple resources=%s', async (withMcp) => {
    const f = await fixture(withMcp);
    const tokens = await f.exchange('openid profile email offline_access');
    expect(decodeJwt(tokens.id_token)).toMatchObject({ iss: issuer, sub: '17', aud: 'public-client' });
    const info = await f.request('/idpOAuth/me', undefined, tokens.access_token);
    expect(info.statusCode).toBe(200);
    expect(info.json()).toMatchObject({ sub: '17', email: f.user.email });
    expect(info.json()).not.toHaveProperty('email_verified');
    const refreshed = await f.request('/idpOAuth/token', {
      grant_type: 'refresh_token',
      client_id: 'public-client',
      refresh_token: tokens.refresh_token,
    });
    expect(refreshed.statusCode).toBe(200);
    expect((await f.request('/idpOAuth/me', undefined, refreshed.json().access_token)).statusCode).toBe(200);
  });

  it('uses an explicit API resource for API tokens and retains claims in the ID token', async () => {
    const f = await fixture();
    const tokens = await f.exchange('openid profile email offline_access api', apiResource);
    expect(decodeJwt(tokens.access_token)).toMatchObject({ aud: apiResource, scope: 'api', sub: '17' });
    expect(decodeJwt(tokens.id_token)).toMatchObject({ sub: '17', email: f.user.email });
    expect(decodeJwt(tokens.id_token)).not.toHaveProperty('email_verified');
    expect((await f.request('/idpOAuth/me', undefined, tokens.access_token)).statusCode).toBe(401);
    const refreshed = await f.request('/idpOAuth/token', {
      grant_type: 'refresh_token',
      client_id: 'public-client',
      refresh_token: tokens.refresh_token,
      resource: apiResource,
    });
    expect(refreshed.statusCode).toBe(200);
    expect(decodeJwt(refreshed.json().access_token)).toMatchObject({ aud: apiResource, scope: 'api' });
  });

  it('defaults an omitted resource only for MCP and preserves MCP code and refresh grants', async () => {
    const f = await fixture(true);
    const defaults = f.config.features?.resourceIndicators?.defaultResource;
    assert(defaults);
    const client = await f.provider.Client.find('public-client');
    assert(client);
    const ctx = (scope: string) => ({
      oidc: { params: { scope }, requestParamScopes: new Set(scope.split(' ')), entities: {} },
    });
    expect(await defaults(ctx('openid profile email') as never, client)).toBeUndefined();
    expect(await defaults(ctx('openid api') as never, client)).toBeUndefined();
    expect(await defaults(ctx('openid mcp') as never, client)).toBe(mcpResource);
    const code = await f.authorizationCode('openid mcp offline_access', mcpResource);
    const response = await f.request('/idpOAuth/token', {
      grant_type: 'authorization_code',
      client_id: 'public-client',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    expect(response.statusCode).toBe(200);
    expect(decodeJwt(response.json().access_token)).toMatchObject({ aud: mcpResource, scope: 'mcp' });
    const refreshed = await f.request('/idpOAuth/token', {
      grant_type: 'refresh_token',
      client_id: 'public-client',
      refresh_token: response.json().refresh_token,
    });
    expect(refreshed.statusCode).toBe(200);
    expect(decodeJwt(refreshed.json().access_token)).toMatchObject({ aud: mcpResource, scope: 'mcp' });
  });

  it.each(['none', 'client_secret_basic', 'client_secret_post'] as const)(
    'completes OIDCAuth validation using %s without trusting the unverified email',
    async (method) => {
      const f = await fixture();
      const fetches: Array<{ path: string; hasSecret: boolean }> = [];
      vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.origin !== new URL(issuer).origin) throw new Error('Unexpected test fetch origin');
        const body = request.method === 'POST' ? await request.text() : undefined;
        fetches.push({
          path: url.pathname,
          hasSecret: !!request.headers.get('authorization') || !!body?.includes('client_secret='),
        });
        const response = await inject(f.provider.callback(), {
          method: request.method as 'GET' | 'POST',
          url: url.pathname.replace(/^\/api/, '') + url.search,
          headers: { ...Object.fromEntries(request.headers), host: url.host, 'x-forwarded-proto': 'https' },
          payload: body,
        });
        return new Response(response.payload, {
          status: response.statusCode,
          headers: response.headers as HeadersInit,
        });
      });
      let transaction: OidcTransaction | undefined;
      const ctx = {
        app: {
          name: 'main',
          cache: {
            set: async (_key: string, value: OidcTransaction) => {
              transaction = value;
            },
          },
        },
        headers: { 'x-authenticator': 'oidc' },
        protocol: 'https',
        cookies: { set: vi.fn() },
        state: {} as { oidcTransaction?: OidcTransaction },
        action: { params: {} as Record<string, string> },
        t: (key: string) => key,
      };
      const linkedUser = { get: () => 17 };
      const authenticator = { findUser: vi.fn().mockResolvedValue(linkedUser), addUser: vi.fn() };
      const auth = Object.create(OIDCAuth.prototype) as OIDCAuth;
      Object.defineProperties(auth, {
        options: {
          value: {
            oidc: {
              issuer,
              clientId: method === 'none' ? 'public-client' : method,
              clientSecret: 'test-confidential-secret',
              tokenEndpointAuthMethod: method,
              redirectUri,
            },
          },
        },
        ctx: { value: ctx },
        authenticator: { value: authenticator },
        userRepository: { value: { update: vi.fn(), findOne: vi.fn().mockResolvedValue(linkedUser) } },
      });
      const authorizeUrl = new URL(await auth.createAuthorizationUrl('/admin'));
      expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
      expect(authorizeUrl.searchParams.has('resource')).toBe(false);
      assert(transaction);
      const clientId = authorizeUrl.searchParams.get('client_id');
      const challenge = authorizeUrl.searchParams.get('code_challenge');
      assert(clientId && challenge);
      const code = await f.authorizationCode('openid email profile', undefined, {
        clientId,
        nonce: transaction.nonce,
        challenge,
      });
      ctx.state.oidcTransaction = transaction;
      ctx.action.params = { code, state: transaction.state, iss: issuer };
      expect(await auth.validate()).toBe(linkedUser);
      expect(authenticator.findUser).toHaveBeenCalledWith(`${issuer}|17`);
      expect(fetches.find((entry) => entry.path.endsWith('/token'))?.hasSecret).toBe(method !== 'none');
      expect(fetches.some((entry) => entry.path.endsWith('/me'))).toBe(true);
      authenticator.findUser.mockResolvedValue(null);
      const secondCode = await f.authorizationCode('openid email profile', undefined, {
        clientId,
        nonce: transaction.nonce,
        challenge,
      });
      ctx.action.params.code = secondCode;
      await expect(auth.validate()).rejects.toThrow('did not verify this email');
      expect(authenticator.addUser).not.toHaveBeenCalled();
    },
  );
});

describe('OAuth scope enforcement through HTTP and NocoBase ACL', () => {
  it('rejects missing resource scope before session bridging and still enforces resource ACL', async () => {
    const f = await fixture(true);
    const koa = new Koa();
    const acl = new ACL();
    const resources = new Resourcer();
    acl.define({ role: 'reader', actions: { 'reports:list': {} } });
    let role = 'reader';
    resources.use(acl.middleware());
    resources.define({
      name: 'reports',
      actions: {
        list: async (ctx) => {
          ctx.body = { id: ctx.state.currentUser.id };
        },
      },
    });
    koa.use(async (ctx, next) => {
      Object.assign(ctx.app, { name: 'main' });
      ctx.getBearerToken = () => ctx.get('authorization').replace(/^Bearer /, '');
      ctx.t = (key: string) => key;
      if (ctx.cookies.get('existing-session')) ctx.state.currentUser = f.user;
      try {
        await f.service.authenticateResourceRequest(ctx as unknown as Context);
        if (ctx.state.currentUser) ctx.state.currentRole = role;
        await next();
      } catch (error) {
        const failure = error as { status?: number; message: string };
        ctx.status = failure.status || 500;
        ctx.body = { error: failure.message };
      }
    });
    koa.use(resources.middleware({ prefix: '/api' }));
    async function signed(scope: string, audience = apiResource, expires = '10m') {
      return new SignJWT({ scope, client_id: 'public-client' })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject('17')
        .setExpirationTime(expires)
        .sign(f.privateKey);
    }
    async function get(token: string, path = '/api/reports:list') {
      return inject(koa.callback(), {
        method: 'GET',
        url: path,
        headers: {
          host: 'idp.example.test',
          'x-forwarded-proto': 'https',
          authorization: `Bearer ${token}`,
          cookie: 'existing-session=present',
        },
      });
    }
    for (const scope of ['', 'openid profile email', 'offline_access', 'mcp']) {
      const denied = await get(await signed(scope));
      expect(denied.statusCode).toBe(403);
      expect(denied.headers['www-authenticate']).toContain('insufficient_scope');
    }
    expect(f.tokenController.add).not.toHaveBeenCalled();
    expect((await get(await signed('api', mcpResource))).statusCode).toBe(401);
    expect((await get(await signed('api', apiResource, '-1m'))).statusCode).toBe(401);
    expect((await get(await signed('offline_access', mcpResource), '/api/mcp')).statusCode).toBe(403);
    expect((await get(await signed('api'))).statusCode).toBe(200);
    role = 'no-permissions';
    expect((await get(await signed('api'))).statusCode).toBe(403);
  });
});
