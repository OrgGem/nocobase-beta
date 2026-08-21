import { createHash, createHmac, randomBytes } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MockServer } from '@nocobase/test';
import { isAesContainer } from '../../../../plugin-crypto-toolkit/src/server/services/crypto-core';
import { verifyJwt } from '../services/jwt';
import { MockUpstream, createRsaKeyFixture, createTestApp, createTestRoute, loginAgent } from './helpers';

function unwrap(res: { body: unknown }): Record<string, unknown> {
  const body = res.body as Record<string, unknown> | undefined;
  if (body && typeof body === 'object' && 'data' in body && body.data && typeof body.data === 'object') {
    return body.data as Record<string, unknown>;
  }
  return (body ?? {}) as Record<string, unknown>;
}

describe('apiRoutes:test action', () => {
  let app: MockServer;
  let agent: Awaited<ReturnType<typeof loginAgent>>;
  const upstream = new MockUpstream();
  const aesKeyB64 = randomBytes(32).toString('base64');

  beforeAll(async () => {
    await upstream.start();
    app = await createTestApp();
    agent = await loginAgent(app);
  }, 300000);

  afterAll(async () => {
    await upstream.stop();
    await app?.destroy();
  });

  it('encrypts the payload for an outbound AES route and decrypts the response', async () => {
    const route = await createTestRoute(app, {
      name: 'test-out-aes',
      direction: 'outbound',
      method: 'POST',
      targetUrl: `${upstream.baseUrl}/echo`,
      encryptionMode: 'aes-256-gcm',
      wireFormat: 'binary',
      aesSecret: aesKeyB64,
    });
    const payload = JSON.stringify({ test: 'aes-outbound' });
    const res = await agent.resource('apiRoutes').test({ filterByTk: route.get('id'), values: { payload } });
    expect(res.status).toBe(200);
    const body = unwrap(res);
    expect(body.ok).toBe(true);
    expect(body.requestEncrypted).toBe(true);
    expect(body.responseEncrypted).toBe(true);
    expect(body.responsePreview).toBe(payload);
    // The upstream must have received the NCB1 container, not the plaintext.
    const received = upstream.lastRequest?.body;
    expect(received ? isAesContainer(received) : false).toBe(true);
    expect(received?.toString('utf8')).not.toContain('aes-outbound');
  });

  it('skips response decryption when responseEncrypted is false', async () => {
    const route = await createTestRoute(app, {
      name: 'test-out-aes-plain-resp',
      direction: 'outbound',
      method: 'POST',
      targetUrl: `${upstream.baseUrl}/status/200`,
      encryptionMode: 'aes-256-gcm',
      wireFormat: 'binary',
      aesSecret: aesKeyB64,
      responseEncrypted: false,
    });
    const res = await agent
      .resource('apiRoutes')
      .test({ filterByTk: route.get('id'), values: { payload: '{"plain-resp":true}' } });
    expect(res.status).toBe(200);
    const body = unwrap(res);
    expect(body.ok).toBe(true);
    // The request was still encrypted; only the response step was skipped.
    expect(body.requestEncrypted).toBe(true);
    expect(body.responseEncrypted).toBe(false);
    expect(body.responsePreview).toBe('status 200');
    const received = upstream.lastRequest?.body;
    expect(received ? isAesContainer(received) : false).toBe(true);
  });

  it('sends plaintext for a route without encryption', async () => {
    const route = await createTestRoute(app, {
      name: 'test-out-plain',
      direction: 'outbound',
      method: 'POST',
      targetUrl: `${upstream.baseUrl}/echo`,
    });
    const payload = JSON.stringify({ test: 'plain' });
    const res = await agent.resource('apiRoutes').test({ filterByTk: route.get('id'), values: { payload } });
    expect(res.status).toBe(200);
    const body = unwrap(res);
    expect(body.ok).toBe(true);
    expect(body.requestEncrypted).toBe(false);
    expect(body.responseEncrypted).toBe(false);
    expect(body.responsePreview).toBe(payload);
    expect(upstream.lastRequest?.body.toString('utf8')).toBe(payload);
  });

  it('reports crypto config errors without marking the upstream unreachable', async () => {
    const route = await createTestRoute(app, {
      name: 'test-out-aes-env',
      direction: 'outbound',
      method: 'POST',
      targetUrl: `${upstream.baseUrl}/echo`,
      encryptionMode: 'aes-256-gcm',
      wireFormat: 'binary',
      aesSecretEnvVar: 'APIM_TEST_MISSING_SECRET_VAR',
    });
    const res = await agent.resource('apiRoutes').test({ filterByTk: route.get('id'), values: { payload: 'hello' } });
    expect(res.status).toBe(200);
    const body = unwrap(res);
    expect(body.ok).toBe(false);
    expect(body.errorCode).toBe('APIM_CRYPTO_CONFIG');
  });

  it('writes a request log entry marked as ui-test', async () => {
    const route = await createTestRoute(app, {
      name: 'test-out-logged',
      direction: 'outbound',
      method: 'POST',
      targetUrl: `${upstream.baseUrl}/echo`,
    });
    const payload = JSON.stringify({ test: 'logged' });
    const res = await agent.resource('apiRoutes').test({ filterByTk: route.get('id'), values: { payload } });
    expect(res.status).toBe(200);
    expect(unwrap(res).ok).toBe(true);

    const log = await app.db
      .getRepository('apiRequestLogs')
      .findOne({ filter: { routeName: 'test-out-logged' }, sort: ['-createdAt'] });
    expect(log).toBeTruthy();
    expect(log.get('path')).toBe('ui-test');
    expect(log.get('status')).toBe('ok');
    expect(log.get('direction')).toBe('outbound');
    expect(log.get('method')).toBe('POST');
    expect(Number(log.get('httpStatus'))).toBe(200);
    expect(Number(log.get('upstreamStatus'))).toBe(200);
    expect(Number(log.get('requestBytes'))).toBe(Buffer.byteLength(payload));
    expect(log.get('apiKeyId')).toBeNull();
    // logPayloads is off by default, so no payload content is stored.
    expect(log.get('requestPayload')).toBeNull();
    expect(log.get('responsePayload')).toBeNull();
  });

  it('stores payloads in the log when the route has logPayloads enabled', async () => {
    const route = await createTestRoute(app, {
      name: 'test-out-logged-payloads',
      direction: 'outbound',
      method: 'POST',
      targetUrl: `${upstream.baseUrl}/echo`,
      logPayloads: true,
    });
    const payload = JSON.stringify({ test: 'logged-payloads' });
    const res = await agent.resource('apiRoutes').test({ filterByTk: route.get('id'), values: { payload } });
    expect(res.status).toBe(200);
    expect(unwrap(res).ok).toBe(true);

    const log = await app.db
      .getRepository('apiRequestLogs')
      .findOne({ filter: { routeName: 'test-out-logged-payloads' }, sort: ['-createdAt'] });
    expect(log).toBeTruthy();
    expect(Buffer.from(String(log.get('requestPayload')), 'base64').toString('utf8')).toBe(payload);
    expect(Buffer.from(String(log.get('responsePayload')), 'base64').toString('utf8')).toBe(payload);
  });

  it('logs crypto config failures from tests as failed', async () => {
    const route = await createTestRoute(app, {
      name: 'test-out-aes-env-logged',
      direction: 'outbound',
      method: 'POST',
      targetUrl: `${upstream.baseUrl}/echo`,
      encryptionMode: 'aes-256-gcm',
      wireFormat: 'binary',
      aesSecretEnvVar: 'APIM_TEST_MISSING_SECRET_VAR_LOG',
    });
    const res = await agent.resource('apiRoutes').test({ filterByTk: route.get('id'), values: { payload: 'hello' } });
    expect(res.status).toBe(200);
    expect(unwrap(res).ok).toBe(false);

    const log = await app.db
      .getRepository('apiRequestLogs')
      .findOne({ filter: { routeName: 'test-out-aes-env-logged' }, sort: ['-createdAt'] });
    expect(log).toBeTruthy();
    expect(log.get('path')).toBe('ui-test');
    expect(log.get('status')).toBe('failed');
    expect(log.get('errorCode')).toBe('APIM_CRYPTO_CONFIG');
    expect(log.get('upstreamStatus')).toBeNull();
  });

  describe('outbound signing pipeline (mirrors the gateway)', () => {
    const hmacSecret = 'test-action-hmac-secret';
    const jwtSecret = 'test-action-jwt-secret';

    it('signs the test request with HMAC over the target path', async () => {
      const route = await createTestRoute(app, {
        name: 'test-out-hmac',
        direction: 'outbound',
        method: 'POST',
        targetUrl: `${upstream.baseUrl}/echo`,
        hmacSignEnabled: true,
        hmacSecret,
      });
      const before = upstream.requests.length;
      const res = await agent
        .resource('apiRoutes')
        .test({ filterByTk: route.get('id'), values: { payload: '{"hmac":true}' } });
      expect(res.status).toBe(200);
      expect(unwrap(res).ok).toBe(true);

      const forwarded = upstream.requests[before];
      const timestamp = String(forwarded.headers['x-apim-timestamp']);
      const nonce = String(forwarded.headers['x-apim-nonce']);
      const bodyHash = createHash('sha256').update(forwarded.body).digest('hex');
      const canonical = [timestamp, nonce, 'POST', '/echo', bodyHash].join('\n');
      const expected = createHmac('sha256', hmacSecret).update(canonical, 'utf8').digest('hex');
      expect(forwarded.headers['x-apim-signature']).toBe(expected);
    });

    it('mints an HS256 Bearer token for the test request', async () => {
      const route = await createTestRoute(app, {
        name: 'test-out-jwt-hs',
        direction: 'outbound',
        method: 'POST',
        targetUrl: `${upstream.baseUrl}/echo`,
        jwtSignEnabled: true,
        jwtSignAlgorithm: 'HS256',
        jwtSecret,
        jwtIssuer: 'apim-test',
        jwtExpiresInSec: 60,
      });
      const before = upstream.requests.length;
      const res = await agent
        .resource('apiRoutes')
        .test({ filterByTk: route.get('id'), values: { payload: '{"jwt":true}' } });
      expect(res.status).toBe(200);
      expect(unwrap(res).ok).toBe(true);

      const authorization = String(upstream.requests[before].headers.authorization ?? '');
      expect(authorization.startsWith('Bearer ')).toBe(true);
      const payload = verifyJwt({
        token: authorization.slice(7),
        algorithms: ['HS256'],
        secret: jwtSecret,
        issuer: 'apim-test',
      });
      expect(typeof payload.exp).toBe('number');
    });

    it('mints an RS256 Bearer token for the test request', async () => {
      const own = await createRsaKeyFixture(app, { name: 'test-jwt-sign-own', direction: 'own' });
      const route = await createTestRoute(app, {
        name: 'test-out-jwt-rs',
        direction: 'outbound',
        method: 'POST',
        targetUrl: `${upstream.baseUrl}/echo`,
        jwtSignEnabled: true,
        jwtSignAlgorithm: 'RS256',
        jwtSignKeyName: own.keyName,
        jwtExpiresInSec: 60,
      });
      const before = upstream.requests.length;
      const res = await agent
        .resource('apiRoutes')
        .test({ filterByTk: route.get('id'), values: { payload: '{"jwt-rs":true}' } });
      expect(res.status).toBe(200);
      expect(unwrap(res).ok).toBe(true);

      const authorization = String(upstream.requests[before].headers.authorization ?? '');
      expect(authorization.startsWith('Bearer ')).toBe(true);
      const payload = verifyJwt({
        token: authorization.slice(7),
        algorithms: ['RS256'],
        publicKeyPem: own.publicPem,
      });
      expect(typeof payload.exp).toBe('number');
    });

    it('reports a missing HMAC secret as APIM_CRYPTO_CONFIG without calling the upstream', async () => {
      const route = await createTestRoute(app, {
        name: 'test-out-hmac-nosecret',
        direction: 'outbound',
        method: 'POST',
        targetUrl: `${upstream.baseUrl}/echo`,
        hmacSignEnabled: true,
      });
      const before = upstream.requests.length;
      const res = await agent
        .resource('apiRoutes')
        .test({ filterByTk: route.get('id'), values: { payload: '{"hmac":false}' } });
      expect(res.status).toBe(200);
      const body = unwrap(res);
      expect(body.ok).toBe(false);
      expect(body.errorCode).toBe('APIM_CRYPTO_CONFIG');
      expect(upstream.requests.length).toBe(before);
    });

    it('reports a missing JWT secret as APIM_CRYPTO_CONFIG without calling the upstream', async () => {
      const route = await createTestRoute(app, {
        name: 'test-out-jwt-nosecret',
        direction: 'outbound',
        method: 'POST',
        targetUrl: `${upstream.baseUrl}/echo`,
        jwtSignEnabled: true,
        jwtSignAlgorithm: 'HS256',
      });
      const before = upstream.requests.length;
      const res = await agent
        .resource('apiRoutes')
        .test({ filterByTk: route.get('id'), values: { payload: '{"jwt":false}' } });
      expect(res.status).toBe(200);
      const body = unwrap(res);
      expect(body.ok).toBe(false);
      expect(body.errorCode).toBe('APIM_CRYPTO_CONFIG');
      expect(upstream.requests.length).toBe(before);
    });
  });
});


