/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createMockServer, type MockServer } from '@nocobase/test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import PluginIdpOauthServer from '../../../../@nocobase/plugin-idp-oauth/src/server/plugin';
import PluginIdpOidcClientManagerServer from '../plugin';
import { normalizeClientInput } from '../client-service';

let app: MockServer;
let signingKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let readerId: string;
let deniedId: string;
const issuer = 'http://localhost/api';

beforeAll(async () => {
  app = await createMockServer({
    registerActions: true,
    resourcer: { prefix: '/api' },
    acl: true,
    plugins: [
      'acl',
      'error-handler',
      'field-sort',
      'users',
      'ui-schema-storage',
      'data-source-main',
      'auth',
      'data-source-manager',
      'collection-tree',
      'system-settings',
      [PluginIdpOauthServer, { name: 'idp-oauth', packageName: '@nocobase/plugin-idp-oauth' }],
      [
        PluginIdpOidcClientManagerServer,
        { name: 'plugin-idp-oidc-client-manager', packageName: 'plugin-idp-oidc-client-manager' },
      ],
    ],
  });
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  signingKey = privateKey;
  const jwks = { keys: [{ ...(await exportJWK(privateKey)), kid: 'integration-test-key', alg: 'RS256', use: 'sig' }] };
  const service = app.pm.get(PluginIdpOauthServer).service;
  vi.spyOn(
    service as unknown as { getProviderSigningJwks: () => Promise<typeof jwks> },
    'getProviderSigningJwks',
  ).mockResolvedValue(jwks);
  for (const name of ['oidc-reader', 'oidc-denied']) {
    await app.db.getRepository('roles').create({ values: { name, title: name } });
  }
  app.acl.define({ role: 'oidc-reader', actions: { 'oidcProbe:read': {} } });
  app.resourceManager.define({
    name: 'oidcProbe',
    actions: {
      read: async (ctx) => {
        ctx.body = { id: String(ctx.state.currentUser.id) };
      },
    },
  });
  const users = app.db.getRepository('users');
  readerId = String((await users.create({ values: { username: 'oidc-reader', roles: ['oidc-reader'] } })).id);
  deniedId = String((await users.create({ values: { username: 'oidc-denied', roles: ['oidc-denied'] } })).id);
  await app.db.getRepository('oidcClients').create({
    values: normalizeClientInput({
      name: 'Integration client',
      clientId: 'integration-client',
      clientType: 'public',
      redirectUris: ['https://client.example.test/callback'],
      scopes: ['openid', 'profile', 'email', 'api'],
    }),
  });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await app?.destroy();
});

async function token(scope: string, subject = readerId) {
  return new SignJWT({ scope, client_id: 'integration-client' })
    .setProtectedHeader({ alg: 'RS256', kid: 'integration-test-key' })
    .setIssuer(issuer)
    .setAudience(`${issuer}/`)
    .setSubject(subject)
    .setExpirationTime('10m')
    .sign(signingKey);
}

it('enforces OAuth scope and user ACL through the full NocoBase resource middleware', async () => {
  const request = (bearer: string, role: string) =>
    app
      .agent()
      .get('/api/oidcProbe:read')
      .set('Host', 'localhost')
      .set('Authorization', `Bearer ${bearer}`)
      .set('X-Role', role);
  const missingScope = await request(await token('openid profile email'), 'oidc-reader');
  expect(missingScope.status).toBe(403);
  expect(missingScope.headers['www-authenticate']).toContain('insufficient_scope');
  const allowed = await request(await token('api'), 'oidc-reader');
  expect(allowed.status).toBe(200);
  expect(allowed.body.data).toEqual({ id: readerId });
  expect((await request(await token('api', deniedId), 'oidc-denied')).status).toBe(403);
});

it('resolves the persisted public client and serves OIDC discovery through the app', async () => {
  const service = app.pm.get(PluginIdpOauthServer).service;
  expect(await service.resolveClient('integration-client')).toMatchObject({
    client_id: 'integration-client',
    token_endpoint_auth_method: 'none',
  });
  const response = await app.agent().get('/api/.well-known/openid-configuration').set('Host', 'localhost');
  expect(response.status).toBe(200);
  expect(response.body.issuer).toBe(issuer);
});

it('denies already-issued API tokens after a managed client is disabled or loses the api scope', async () => {
  const clients = app.db.getRepository('oidcClients');
  const bearer = await token('api');
  const request = () =>
    app
      .agent()
      .get('/api/oidcProbe:read')
      .set('Host', 'localhost')
      .set('Authorization', `Bearer ${bearer}`)
      .set('X-Role', 'oidc-reader');
  try {
    await clients.update({ filter: { clientId: 'integration-client' }, values: { enabled: false } });
    expect((await request()).status).toBe(403);
    await clients.update({ filter: { clientId: 'integration-client' }, values: { enabled: true, scopes: ['openid'] } });
    expect((await request()).status).toBe(403);
  } finally {
    await clients.update({
      filter: { clientId: 'integration-client' },
      values: { enabled: true, scopes: ['openid', 'profile', 'email', 'api'] },
    });
  }
});
