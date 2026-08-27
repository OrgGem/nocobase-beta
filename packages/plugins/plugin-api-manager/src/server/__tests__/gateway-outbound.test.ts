import { randomBytes } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MockServer } from '@nocobase/test';
import supertest from 'supertest';
import { OUTBOUND_PREFIX } from '../../constants';
import {
  aesGcmDecrypt,
  isAesContainer,
  isRsaHybridContainer,
  rsaHybridDecrypt,
} from '../../../../plugin-crypto-toolkit/src/server/services/crypto-core';
import { decryptAndVerify, encryptAndSign } from '../../../../plugin-crypto-toolkit/src/server/services/pgp-service';
import {
  MockUpstream,
  createPgpKeyFixture,
  createRsaKeyFixture,
  createTestApiKey,
  createTestApp,
  createTestRoute,
} from './helpers';
describe('gateway outbound', () => {
  let app: MockServer;
  let request: ReturnType<typeof supertest>;
  let rsaPrivatePem: string;
  let pgpOwn: Awaited<ReturnType<typeof createPgpKeyFixture>>;
  let pgpPartner: Awaited<ReturnType<typeof createPgpKeyFixture>>;
  const upstream = new MockUpstream();
  const aesKeyB64 = randomBytes(32).toString('base64');
  const aesKey = Buffer.from(aesKeyB64, 'base64');

  beforeAll(async () => {
    await upstream.start();
    app = await createTestApp();
    request = supertest(app.callback());

    await createTestRoute(app, {
      name: 'out-plain',
      direction: 'outbound',
      method: 'POST',
      targetUrl: `${upstream.baseUrl}/echo`,
      encryptionMode: 'none',
    });
    // GET route: query-only requests, no body.
    await createTestRoute(app, {
      name: 'out-get',
      direction: 'outbound',
      method: 'GET',
      targetUrl: `${upstream.baseUrl}/echo`,
      encryptionMode: 'none',
    });
    await createTestRoute(app, {
      name: 'out-get-aes',
      direction: 'outbound',
      method: 'GET',
      targetUrl: `${upstream.baseUrl}/echo`,
      encryptionMode: 'aes-256-gcm',
      wireFormat: 'binary',
      aesSecret: aesKeyB64,
    });
    // Raw-binary file upload route (Cách A: client sends file bytes + metadata headers).
    await createTestRoute(app, {
      name: 'out-file-json',
      direction: 'outbound',
      method: 'POST',
      targetUrl: `${upstream.baseUrl}/echo`,
      encryptionMode: 'aes-256-gcm',
      wireFormat: 'json',
      aesSecret: aesKeyB64,
      forwardHeaders: ['x-file-name', 'x-file-content-type', 'x-file-sha256'],
    });
    await createTestRoute(app, {
      name: 'out-aes',
      direction: 'outbound',
      method: 'POST',
      targetUrl: `${upstream.baseUrl}/echo`,
      encryptionMode: 'aes-256-gcm',
      wireFormat: 'binary',
      aesSecret: aesKeyB64,
    });
    // Route with forwardResponseHeaders allowlist: downloads keep filename/content-length/etag.
    await createTestRoute(app, {
      name: 'out-download',
      direction: 'outbound',
      method: 'GET',
      targetUrl: `${upstream.baseUrl}/headers/content-disposition/attachment%3B%20filename%3D%22invoice.pdf%22`,
      encryptionMode: 'none',
      forwardResponseHeaders: ['content-disposition', 'content-length', 'etag', 'accept-ranges'],
    });
    await createTestRoute(app, {
      name: 'out-aes-plain-resp',
      direction: 'outbound',
      method: 'POST',
      targetUrl: `${upstream.baseUrl}/status/200`,
      encryptionMode: 'aes-256-gcm',
      wireFormat: 'binary',
      aesSecret: aesKeyB64,
      responseEncrypted: false,
    });
    await createTestRoute(app, {
      name: 'out-retry',
      direction: 'outbound',
      method: 'POST',
      targetUrl: `${upstream.baseUrl}/flaky`,
      encryptionMode: 'none',
      retryCount: 2,
      retryDelayMs: 10,
    });
    // Port 9 (discard) is closed on localhost, so this route always fails to connect.
    await createTestRoute(app, {
      name: 'out-unreachable',
      direction: 'outbound',
      method: 'POST',
      targetUrl: 'http://127.0.0.1:9/echo',
      encryptionMode: 'none',
    });

    // The own decrypt row holds the private half of the partner pair so the
    // /echo round-trip can decrypt the response it encrypted on the way out.
    const rsaPartner = await createRsaKeyFixture(app, { name: 'out-rsa-partner', direction: 'partner' });
    rsaPrivatePem = rsaPartner.privatePem;
    process.env.CRYPTO_TOOLKIT_APIM_OUT_RSA_OWN_PRIVATE = rsaPartner.privatePem;
    await app.db.getRepository('cryptoKeys').create({
      values: {
        name: 'out-rsa-own',
        kind: 'rsa-4096',
        direction: 'own',
        purpose: 'encrypt',
        publicMaterial: rsaPartner.publicPem,
        publicFormat: 'pem',
        privateEnvVar: 'CRYPTO_TOOLKIT_APIM_OUT_RSA_OWN_PRIVATE',
        enabled: true,
      },
    });
    await createTestRoute(app, {
      name: 'out-rsa',
      direction: 'outbound',
      method: 'POST',
      targetUrl: `${upstream.baseUrl}/echo`,
      encryptionMode: 'rsa-oaep',
      wireFormat: 'binary',
      rsaEncryptKeyName: 'out-rsa-partner',
      rsaDecryptKeyName: 'out-rsa-own',
    });
    await createTestRoute(app, {
      name: 'out-rsa-plain-resp',
      direction: 'outbound',
      method: 'POST',
      targetUrl: `${upstream.baseUrl}/status/200`,
      encryptionMode: 'rsa-oaep',
      wireFormat: 'binary',
      rsaEncryptKeyName: 'out-rsa-partner',
      responseEncrypted: false,
    });
    // PGP outbound: own key encrypts to partner; partner key holds private material.
    pgpOwn = await createPgpKeyFixture(app, { name: 'out-pgp-own', direction: 'own' });
    pgpPartner = await createPgpKeyFixture(app, { name: 'out-pgp-partner', direction: 'partner' });
    await createTestRoute(app, {
      name: 'out-pgp',
      direction: 'outbound',
      method: 'POST',
      targetUrl: `${upstream.baseUrl}/echo`,
      encryptionMode: 'pgp',
      pgpEncryptKeyName: 'out-pgp-own',
      pgpDecryptKeyName: 'out-pgp-own',
    });
    await createTestRoute(app, {
      name: 'out-pgp-get',
      direction: 'outbound',
      method: 'GET',
      targetUrl: `${upstream.baseUrl}/echo`,
      encryptionMode: 'pgp',
      pgpEncryptKeyName: 'out-pgp-own',
      pgpDecryptKeyName: 'out-pgp-own',
    });
    await createTestRoute(app, {
      name: 'out-rsa-get',
      direction: 'outbound',
      method: 'GET',
      targetUrl: `${upstream.baseUrl}/echo`,
      encryptionMode: 'rsa-oaep',
      wireFormat: 'binary',
      rsaEncryptKeyName: 'out-rsa-partner',
      rsaDecryptKeyName: 'out-rsa-own',
    });
  }, 300000);

  afterAll(async () => {
    await upstream.stop();
    await app?.destroy();
  });

  it('forwards an unencrypted request and passes the response through', async () => {
    const key = await createTestApiKey(app, { scopes: ['outbound'] });
    const payload = JSON.stringify({ out: 'plain' });
    const res = await request
      .post(`${OUTBOUND_PREFIX}out-plain`)
      .set('X-API-Key', key)
      .set('Content-Type', 'application/json')
      .send(payload);
    expect(res.status).toBe(200);
    expect(res.text).toBe(payload);
    expect(upstream.lastRequest?.body.toString('utf8')).toBe(payload);
  });

  it('returns 404 for an unknown outbound route', async () => {
    const key = await createTestApiKey(app, { scopes: ['outbound'] });
    const res = await request.post(`${OUTBOUND_PREFIX}missing`).set('X-API-Key', key).send('{}');
    expect(res.status).toBe(404);
  });

  it('forwards the caller query string to the target', async () => {
    const key = await createTestApiKey(app, { scopes: ['outbound'] });
    const res = await request
      .post(`${OUTBOUND_PREFIX}out-plain?batch=3&flag=on`)
      .set('X-API-Key', key)
      .set('Content-Type', 'application/json')
      .send('{"q":1}');
    expect(res.status).toBe(200);
    expect(upstream.lastRequest?.path).toBe('/echo?batch=3&flag=on');
  });
  it('forwards a GET request with query-only params (no body)', async () => {
    const key = await createTestApiKey(app, { scopes: ['outbound'] });
    const before = upstream.requests.length;
    const res = await request.get(`${OUTBOUND_PREFIX}out-get?batch=3&flag=on`).set('X-API-Key', key);
    expect(res.status).toBe(200);
    const forwarded = upstream.requests[before];
    expect(forwarded.method).toBe('GET');
    expect(forwarded.path).toBe('/echo?batch=3&flag=on');
    expect(forwarded.body.length).toBe(0);
    // Echo returns empty body for an empty request body.
    expect(Buffer.isBuffer(res.body) ? res.body.length : 0).toBe(0);
  });

  it('forwards a GET request and encrypts the (empty) body when the route is encrypted', async () => {
    const key = await createTestApiKey(app, { scopes: ['outbound'] });
    const before = upstream.requests.length;
    const res = await request.get(`${OUTBOUND_PREFIX}out-get-aes?batch=7`).set('X-API-Key', key);
    expect(res.status).toBe(200);
    const forwarded = upstream.requests[before];
    expect(forwarded.method).toBe('GET');
    expect(forwarded.path).toBe('/echo?batch=7');
    // Empty plaintext body still produces a valid encrypted container on the wire.
    const received = forwarded.body as Buffer;
    expect(isAesContainer(received)).toBe(true);
    expect(aesGcmDecrypt(received, { key: aesKey }).length).toBe(0);
  });
  it('forwards a raw-binary file with metadata headers (JSON wire, Cách A)', async () => {
    const key = await createTestApiKey(app, { scopes: ['outbound'] });
    const fileBytes = Buffer.from('%PDF-1.7 fake pdf content for proxy test');
    const sha256 = require('crypto').createHash('sha256').update(fileBytes).digest('hex');
    const before = upstream.requests.length;
    const res = await request
      .post(`${OUTBOUND_PREFIX}out-file-json`)
      .set('X-API-Key', key)
      .set('Content-Type', 'application/pdf')
      .set('X-File-Name', 'invoice.pdf')
      .set('X-File-Content-Type', 'application/pdf')
      .set('X-File-Sha256', sha256)
      .send(fileBytes);
    expect(res.status).toBe(200);
    const forwarded = upstream.requests[before];
    // The partner receives an encrypted JSON envelope, not the raw file.
    const envelope = JSON.parse(forwarded.body.toString('utf8'));
    expect(envelope.container).toBe('NCB1');
    expect(envelope.encoding).toBe('base64');
    expect(envelope.contentType).toBe('application/pdf');
    const decrypted = aesGcmDecrypt(Buffer.from(envelope.ciphertext, 'base64'), { key: aesKey });
    expect(decrypted.equals(fileBytes)).toBe(true);
    // Metadata headers are forwarded alongside the ciphertext.
    expect(String(forwarded.headers['x-file-name'])).toBe('invoice.pdf');
    expect(String(forwarded.headers['x-file-content-type'])).toBe('application/pdf');
    expect(String(forwarded.headers['x-file-sha256'])).toBe(sha256);
    expect(String(forwarded.headers['content-type'])).toBe('application/json');
  });
  it('logs the raw file bytes checksum and size for an outbound file upload', async () => {
    const key = await createTestApiKey(app, { scopes: ['outbound'] });
    const fileBytes = Buffer.from('%PDF-1.7 checksum test file');
    const res = await request
      .post(`${OUTBOUND_PREFIX}out-file-json`)
      .set('X-API-Key', key)
      .set('Content-Type', 'application/pdf')
      .send(fileBytes);
    expect(res.status).toBe(200);
    const requestId = res.headers['x-request-id'];
    const log = await app.db.getRepository('apiRequestLogs').findOne({ filter: { requestId } });
    expect(log).toBeTruthy();
    // requestSha256 hashes the original file bytes (before encryption).
    const sha256Hex = require('crypto').createHash('sha256').update(fileBytes).digest('hex');
    expect(log.get('requestSha256')).toBe(sha256Hex);
    expect(Number(log.get('requestBytes'))).toBe(fileBytes.length);
  });

  it('forwards a POST with no body', async () => {
    const key = await createTestApiKey(app, { scopes: ['outbound'] });
    const before = upstream.requests.length;
    const res = await request.post(`${OUTBOUND_PREFIX}out-plain`).set('X-API-Key', key);
    expect(res.status).toBe(200);
    const forwarded = upstream.requests[before];
    expect(forwarded.method).toBe('POST');
    expect(forwarded.body.length).toBe(0);
  });

  it('preserves URL-encoded query parameters when forwarding', async () => {
    const key = await createTestApiKey(app, { scopes: ['outbound'] });
    const before = upstream.requests.length;
    const res = await request
      .get(`${OUTBOUND_PREFIX}out-get?a=b%20c&arr=1&arr=2&unicode=%E2%9C%93`)
      .set('X-API-Key', key);
    expect(res.status).toBe(200);
    const forwarded = upstream.requests[before];
    expect(forwarded.path).toBe('/echo?a=b%20c&arr=1&arr=2&unicode=%E2%9C%93');
  });
  it('forwards allow-listed upstream response headers (forwardResponseHeaders)', async () => {
    const key = await createTestApiKey(app, { scopes: ['outbound'] });
    const res = await request.get(`${OUTBOUND_PREFIX}out-download`).set('X-API-Key', key);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="invoice.pdf"');
    expect(res.headers['content-type']).toContain('text/plain');
  });

  it('returns a generic error for an unreachable upstream without leaking details', async () => {
    const key = await createTestApiKey(app, { scopes: ['outbound'] });
    const res = await request
      .post(`${OUTBOUND_PREFIX}out-unreachable`)
      .set('X-API-Key', key)
      .set('Content-Type', 'application/json')
      .send('{"unreachable":true}');
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('APIM_UPSTREAM_ERROR');
    expect(res.body.error.message).toBe('Upstream request failed');
    expect(res.text).not.toContain('ECONNREFUSED');
    expect(res.text).not.toContain('127.0.0.1:9');
    // The detail is still recorded in the request log for operators.
    const requestId = res.headers['x-request-id'];
    const log = await app.db.getRepository('apiRequestLogs').findOne({ filter: { requestId } });
    expect(log).toBeTruthy();
    expect(String(log?.get('error'))).toContain('ECONNREFUSED');
    expect(log?.get('status')).toBe('failed');
  });

  it('rejects a key without the outbound scope with 403', async () => {
    const key = await createTestApiKey(app, { scopes: ['inbound'] });
    const res = await request.post(`${OUTBOUND_PREFIX}out-plain`).set('X-API-Key', key).send('{}');
    expect(res.status).toBe(403);
  });

  it('accepts a route-scoped outbound key', async () => {
    const key = await createTestApiKey(app, { scopes: ['outbound:out-plain'] });
    const res = await request
      .post(`${OUTBOUND_PREFIX}out-plain`)
      .set('X-API-Key', key)
      .set('Content-Type', 'application/json')
      .send('{"scoped":true}');
    expect(res.status).toBe(200);
  });

  describe('AES encryption', () => {
    it('encrypts the request to the partner and decrypts the response for the caller', async () => {
      const key = await createTestApiKey(app, { scopes: ['outbound'] });
      const plaintext = Buffer.from(JSON.stringify({ order: 12, amount: 42 }), 'utf8');

      const res = await request
        .post(`${OUTBOUND_PREFIX}out-aes`)
        .set('X-API-Key', key)
        .set('Content-Type', 'application/json')
        .send(plaintext.toString('utf8'));

      expect(res.status).toBe(200);
      // The partner (upstream) must have received the encrypted container, not plaintext.
      const received = upstream.lastRequest?.body as Buffer;
      expect(isAesContainer(received)).toBe(true);
      expect(aesGcmDecrypt(received, { key: aesKey }).equals(plaintext)).toBe(true);
      // The caller receives plaintext back (the echoed container was decrypted).
      expect(res.text).toBe(plaintext.toString('utf8'));
    });

    it('passes a plaintext upstream response through when responseEncrypted is false', async () => {
      const key = await createTestApiKey(app, { scopes: ['outbound'] });
      const res = await request
        .post(`${OUTBOUND_PREFIX}out-aes-plain-resp`)
        .set('X-API-Key', key)
        .set('Content-Type', 'application/json')
        .send('{"plain-resp":true}');
      expect(res.status).toBe(200);
      expect(res.text).toBe('status 200');
      // The request itself was still encrypted on the way out.
      const received = upstream.lastRequest?.body as Buffer;
      expect(isAesContainer(received)).toBe(true);
    });

    it('sniffs application/xml for a decrypted response lacking an envelope content type', async () => {
      const key = await createTestApiKey(app, { scopes: ['outbound'] });
      const xml = '<order id="42"><item>widget</item></order>';
      const res = await request
        .post(`${OUTBOUND_PREFIX}out-aes`)
        .set('X-API-Key', key)
        .set('Content-Type', 'application/xml')
        .send(xml);
      expect(res.status).toBe(200);
      expect(res.text).toBe(xml);
      // The binary wire format cannot carry the plaintext content type, so the
      // gateway must sniff the decrypted bytes (leading "<" -> XML).
      expect(res.headers['content-type']).toContain('application/xml');
    });
  });

  describe('RSA-OAEP hybrid encryption', () => {
    it('encrypts the request to the partner and decrypts the response for the caller', async () => {
      const key = await createTestApiKey(app, { scopes: ['outbound'] });
      const plaintext = Buffer.from(JSON.stringify({ order: 99, amount: 7 }), 'utf8');

      const res = await request
        .post(`${OUTBOUND_PREFIX}out-rsa`)
        .set('X-API-Key', key)
        .set('Content-Type', 'application/json')
        .send(plaintext.toString('utf8'));

      expect(res.status).toBe(200);
      // The partner (upstream) must have received the NCR1 container, not plaintext.
      const received = upstream.lastRequest?.body as Buffer;
      expect(isRsaHybridContainer(received)).toBe(true);
      expect(rsaHybridDecrypt(received, rsaPrivatePem).equals(plaintext)).toBe(true);
      // The echoed container was decrypted with the own private key for the caller.
      expect(res.text).toBe(plaintext.toString('utf8'));
    });

    it('passes a plaintext upstream response through when responseEncrypted is false', async () => {
      const key = await createTestApiKey(app, { scopes: ['outbound'] });
      const res = await request
        .post(`${OUTBOUND_PREFIX}out-rsa-plain-resp`)
        .set('X-API-Key', key)
        .set('Content-Type', 'application/json')
        .send('{"rsa-plain-resp":true}');
      expect(res.status).toBe(200);
      expect(res.text).toBe('status 200');
      // The request itself was still encrypted on the way out.
      const received = upstream.lastRequest?.body as Buffer;
      expect(isRsaHybridContainer(received)).toBe(true);
    });
  });

  describe('PGP encryption', () => {
    it('encrypts a POST request to the partner and decrypts the response', async () => {
      const key = await createTestApiKey(app, { scopes: ['outbound'] });
      const plaintext = Buffer.from(JSON.stringify({ pgp: 'outbound-post' }), 'utf8');
      const res = await request
        .post(`${OUTBOUND_PREFIX}out-pgp`)
        .set('X-API-Key', key)
        .set('Content-Type', 'application/json')
        .send(plaintext.toString('utf8'));
      expect(res.status).toBe(200);
      // The partner receives a PGP-encrypted message, not plaintext.
      const received = upstream.lastRequest?.body as Buffer;
      const decrypted = await decryptAndVerify({
        data: received,
        privateKey: { armored: pgpOwn.pair.privateKey },
      });
      expect(Buffer.from(decrypted.data).equals(plaintext)).toBe(true);
      // The response (echoed ciphertext) is decrypted for the caller.
      expect(res.text).toBe(plaintext.toString('utf8'));
    }, 120000);

    it('encrypts a GET request (empty body) and passes the response through', async () => {
      const key = await createTestApiKey(app, { scopes: ['outbound'] });
      const before = upstream.requests.length;
      const res = await request.get(`${OUTBOUND_PREFIX}out-pgp-get?batch=9`).set('X-API-Key', key);
      expect(res.status).toBe(200);
      const forwarded = upstream.requests[before];
      expect(forwarded.method).toBe('GET');
      expect(forwarded.path).toBe('/echo?batch=9');
      // Empty body still produces a PGP message the partner can decrypt.
      const decrypted = await decryptAndVerify({
        data: forwarded.body as Buffer,
        privateKey: { armored: pgpOwn.pair.privateKey },
      });
      expect(Buffer.from(decrypted.data).length).toBe(0);
    }, 120000);
  });

  describe('RSA-OAEP GET', () => {
    it('encrypts a GET request (empty body) and passes the response through', async () => {
      const key = await createTestApiKey(app, { scopes: ['outbound'] });
      const before = upstream.requests.length;
      const res = await request.get(`${OUTBOUND_PREFIX}out-rsa-get?batch=11`).set('X-API-Key', key);
      expect(res.status).toBe(200);
      const forwarded = upstream.requests[before];
      expect(forwarded.method).toBe('GET');
      expect(forwarded.path).toBe('/echo?batch=11');
      // Empty body still produces an NCR1 container.
      const received = forwarded.body as Buffer;
      expect(isRsaHybridContainer(received)).toBe(true);
      expect(rsaHybridDecrypt(received, rsaPrivatePem).length).toBe(0);
    });
  });

  describe('retry', () => {
    it('retries a flaky upstream and succeeds', async () => {
      const key = await createTestApiKey(app, { scopes: ['outbound'] });
      upstream.flakyRemaining = 1;
      const res = await request
        .post(`${OUTBOUND_PREFIX}out-retry`)
        .set('X-API-Key', key)
        .set('Content-Type', 'application/json')
        .send('{"retry":true}');
      expect(res.status).toBe(200);
      expect(res.text).toBe('recovered');

      const requestId = res.headers['x-request-id'];
      const log = await app.db.getRepository('apiRequestLogs').findOne({ filter: { requestId } });
      expect(Number(log.get('attempt'))).toBe(2);
    });
  });

  describe('authMode route control', () => {
    it("allows a plugin API key on an 'api-key' route", async () => {
      const route = await createTestRoute(app, {
        name: 'authmode-api-key',
        direction: 'outbound',
        method: 'POST',
        targetUrl: `${upstream.baseUrl}/echo`,
        encryptionMode: 'none',
        authMode: 'api-key',
      });
      expect(route.get('authMode')).toBe('api-key');
      const key = await createTestApiKey(app, { scopes: ['outbound:authmode-api-key'] });
      const res = await request
        .post(`${OUTBOUND_PREFIX}authmode-api-key`)
        .set('X-API-Key', key)
        .set('Content-Type', 'application/json')
        .send('{"auth":true}');
      expect(res.status).toBe(200);
    });

    it("rejects a Bearer token on an 'api-key' route (403)", async () => {
      await createTestRoute(app, {
        name: 'authmode-api-key-only',
        direction: 'outbound',
        method: 'POST',
        targetUrl: `${upstream.baseUrl}/echo`,
        encryptionMode: 'none',
        authMode: 'api-key',
      });
      const user = await app.db.getRepository('users').findOne({ filter: { email: process.env.INIT_ROOT_EMAIL } });
      const token = app.authManager.jwt.sign({ userId: user.get('id'), roleName: 'admin' }, { expiresIn: '1h' });
      const res = await request
        .post(`${OUTBOUND_PREFIX}authmode-api-key-only`)
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send('{"auth":true}');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('APIM_FORBIDDEN');
    });

    it("allows an app Bearer token on a 'role' route (ACL role check)", async () => {
      const { registerRouteSnippets } = await import('../services/acl');
      registerRouteSnippets(app.acl, ['authmode-role']);
      await createTestRoute(app, {
        name: 'authmode-role',
        direction: 'outbound',
        method: 'POST',
        targetUrl: `${upstream.baseUrl}/echo`,
        encryptionMode: 'none',
        authMode: 'role',
      });
      const user = await app.db.getRepository('users').findOne({ filter: { email: process.env.INIT_ROOT_EMAIL } });
      const token = app.authManager.jwt.sign({ userId: user.get('id'), roleName: 'admin' }, { expiresIn: '1h' });
      const res = await request
        .post(`${OUTBOUND_PREFIX}authmode-role`)
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send('{"auth":true}');
      expect(res.status).toBe(200);
    });

    it("rejects an API key on a 'role' route (403)", async () => {
      await createTestRoute(app, {
        name: 'authmode-role-only',
        direction: 'outbound',
        method: 'POST',
        targetUrl: `${upstream.baseUrl}/echo`,
        encryptionMode: 'none',
        authMode: 'role',
      });
      const key = await createTestApiKey(app, { scopes: ['outbound:authmode-role-only'] });
      const res = await request
        .post(`${OUTBOUND_PREFIX}authmode-role-only`)
        .set('X-API-Key', key)
        .set('Content-Type', 'application/json')
        .send('{"auth":true}');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('APIM_FORBIDDEN');
    });

    it("rejects an API key on a 'role' route when the role ACL is not granted (403)", async () => {
      const { registerRouteSnippets } = await import('../services/acl');
      registerRouteSnippets(app.acl, ['authmode-role-denied']);
      await createTestRoute(app, {
        name: 'authmode-role-denied',
        direction: 'outbound',
        method: 'POST',
        targetUrl: `${upstream.baseUrl}/echo`,
        encryptionMode: 'none',
        authMode: 'role',
      });
      const user = await app.db.getRepository('users').findOne({ filter: { email: process.env.INIT_ROOT_EMAIL } });
      const token = app.authManager.jwt.sign({ userId: user.get('id'), roleName: 'member' }, { expiresIn: '1h' });
      const res = await request
        .post(`${OUTBOUND_PREFIX}authmode-role-denied`)
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send('{"auth":true}');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('APIM_FORBIDDEN');
    });

    it("accepts both credential types on a 'both' route", async () => {
      const { registerRouteSnippets } = await import('../services/acl');
      registerRouteSnippets(app.acl, ['authmode-both']);
      await createTestRoute(app, {
        name: 'authmode-both',
        direction: 'outbound',
        method: 'POST',
        targetUrl: `${upstream.baseUrl}/echo`,
        encryptionMode: 'none',
        authMode: 'both',
      });
      const key = await createTestApiKey(app, { scopes: ['outbound:authmode-both'] });
      const keyRes = await request
        .post(`${OUTBOUND_PREFIX}authmode-both`)
        .set('X-API-Key', key)
        .set('Content-Type', 'application/json')
        .send('{"auth":true}');
      expect(keyRes.status).toBe(200);
      const user = await app.db.getRepository('users').findOne({ filter: { email: process.env.INIT_ROOT_EMAIL } });
      const token = app.authManager.jwt.sign({ userId: user.get('id'), roleName: 'admin' }, { expiresIn: '1h' });
      const tokenRes = await request
        .post(`${OUTBOUND_PREFIX}authmode-both`)
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send('{"auth":true}');
      expect(tokenRes.status).toBe(200);
    });
    it("returns 401 (APIM_UNAUTHORIZED) with no credential at all on a 'both' route", async () => {
      await createTestRoute(app, {
        name: 'authmode-no-cred',
        direction: 'outbound',
        method: 'POST',
        targetUrl: `${upstream.baseUrl}/echo`,
        encryptionMode: 'none',
        authMode: 'both',
      });
      const res = await request
        .post(`${OUTBOUND_PREFIX}authmode-no-cred`)
        .set('Content-Type', 'application/json')
        .send('{"auth":true}');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('APIM_UNAUTHORIZED');
    });

    it("returns 401 (APIM_UNAUTHORIZED) with no credential at all on a 'role' route", async () => {
      await createTestRoute(app, {
        name: 'authmode-no-cred-role',
        direction: 'outbound',
        method: 'POST',
        targetUrl: `${upstream.baseUrl}/echo`,
        encryptionMode: 'none',
        authMode: 'role',
      });
      const res = await request
        .post(`${OUTBOUND_PREFIX}authmode-no-cred-role`)
        .set('Content-Type', 'application/json')
        .send('{"auth":true}');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('APIM_UNAUTHORIZED');
    });

    it("returns 401 (APIM_UNAUTHORIZED) with no credential at all on an 'api-key' route", async () => {
      await createTestRoute(app, {
        name: 'authmode-no-cred-apikey',
        direction: 'outbound',
        method: 'POST',
        targetUrl: `${upstream.baseUrl}/echo`,
        encryptionMode: 'none',
        authMode: 'api-key',
      });
      const res = await request
        .post(`${OUTBOUND_PREFIX}authmode-no-cred-apikey`)
        .set('Content-Type', 'application/json')
        .send('{"auth":true}');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('APIM_UNAUTHORIZED');
    });
  });

  describe('app Bearer token auth (NocoBase JWT)', () => {
    it('grants access with a valid app token whose role may call the route', async () => {
      const { registerRouteSnippets } = await import('../services/acl');
      registerRouteSnippets(app.acl, ['out-plain']);
      const user = await app.db.getRepository('users').findOne({ filter: { email: process.env.INIT_ROOT_EMAIL } });
      const token = app.authManager.jwt.sign({ userId: user.get('id'), roleName: 'admin' }, { expiresIn: '1h' });
      const res = await request
        .post(`${OUTBOUND_PREFIX}out-plain`)
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send('{"acl":true}');
      expect(res.status).toBe(200);
    });

    it('denies access when the app token role lacks the route grant (403)', async () => {
      const { registerRouteSnippets } = await import('../services/acl');
      registerRouteSnippets(app.acl, ['out-plain']);
      const user = await app.db.getRepository('users').findOne({ filter: { email: process.env.INIT_ROOT_EMAIL } });
      const token = app.authManager.jwt.sign({ userId: user.get('id'), roleName: 'member' }, { expiresIn: '1h' });
      const res = await request
        .post(`${OUTBOUND_PREFIX}out-plain`)
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send('{"acl":true}');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('APIM_FORBIDDEN');
    });

    it('rejects an invalid app token with 401', async () => {
      const res = await request
        .post(`${OUTBOUND_PREFIX}out-plain`)
        .set('Authorization', 'Bearer not-a-real-token')
        .set('Content-Type', 'application/json')
        .send('{"acl":true}');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('APIM_UNAUTHORIZED');
    });

    it('rejects a token without a role (403)', async () => {
      const user = await app.db.getRepository('users').findOne({ filter: { email: process.env.INIT_ROOT_EMAIL } });
      const token = app.authManager.jwt.sign({ userId: user.get('id') }, { expiresIn: '1h' });
      const res = await request
        .post(`${OUTBOUND_PREFIX}out-plain`)
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send('{"acl":true}');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('APIM_FORBIDDEN');
    });

    it('prefers the plugin API key over a Bearer token when both are sent', async () => {
      const key = await createTestApiKey(app, { scopes: ['outbound'] });
      const user = await app.db.getRepository('users').findOne({ filter: { email: process.env.INIT_ROOT_EMAIL } });
      const token = app.authManager.jwt.sign({ userId: user.get('id'), roleName: 'member' }, { expiresIn: '1h' });
      // Legacy key (no role) + member token: the key wins, so the request is allowed.
      const res = await request
        .post(`${OUTBOUND_PREFIX}out-plain`)
        .set('X-API-Key', key)
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send('{"acl":true}');
      expect(res.status).toBe(200);
    });
  });
});
