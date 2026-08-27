import { randomBytes } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MockServer } from '@nocobase/test';
import supertest from 'supertest';
import { INBOUND_PREFIX } from '../../constants';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  isAesContainer,
  isRsaHybridContainer,
  rsaHybridDecrypt,
  rsaHybridEncrypt,
  sha256Hex,
} from '../../../../plugin-crypto-toolkit/src/server/services/crypto-core';
import {
  MockUpstream,
  binaryParser,
  createPgpKeyFixture,
  createRsaKeyFixture,
  createTestApiKey,
  createTestApp,
  createTestRoute,
} from './helpers';
import { decryptAndVerify, encryptAndSign } from '../../../../plugin-crypto-toolkit/src/server/services/pgp-service';

describe('gateway inbound', () => {
  let app: MockServer;
  let request: ReturnType<typeof supertest>;
  let rsaOwnPublicPem: string;
  let rsaPartnerPrivatePem: string;
  const upstream = new MockUpstream();
  const aesKeyB64 = randomBytes(32).toString('base64');
  const aesKey = Buffer.from(aesKeyB64, 'base64');

  beforeAll(async () => {
    await upstream.start();
    app = await createTestApp();
    request = supertest(app.callback());

    // Plain inbound route (no encryption).
    await createTestRoute(app, {
      name: 'in-plain',
      direction: 'inbound',
      inboundPath: 'plain',
      method: 'POST',
      targetUrl: `${upstream.baseUrl}/echo`,
      encryptionMode: 'none',
    });
    // GET inbound route: query-only requests, no body.
    await createTestRoute(app, {
      name: 'in-get',
      direction: 'inbound',
      inboundPath: 'get',
      method: 'GET',
      targetUrl: `${upstream.baseUrl}/echo`,
      encryptionMode: 'none',
    });
    // AES inbound route.
    // Inbound raw-binary file route: partner sends encrypted JSON envelope + metadata headers.
    await createTestRoute(app, {
      name: 'in-file-json',
      direction: 'inbound',
      inboundPath: 'file-json',
      method: 'POST',
      targetUrl: `${upstream.baseUrl}/echo`,
      encryptionMode: 'aes-256-gcm',
      wireFormat: 'json',
      aesSecret: aesKeyB64,
      forwardHeaders: ['x-file-name', 'x-file-content-type', 'x-file-sha256'],
    });
    // Inbound binary-wire file route: partner sends raw NCB1 container (no envelope).
    await createTestRoute(app, {
      name: 'in-file-binary',
      direction: 'inbound',
      inboundPath: 'file-binary',
      method: 'POST',
      targetUrl: `${upstream.baseUrl}/echo`,
      encryptionMode: 'aes-256-gcm',
      wireFormat: 'binary',
      aesSecret: aesKeyB64,
      forwardHeaders: ['x-file-name', 'x-file-sha256'],
    });
    // AES inbound route.
    await createTestRoute(app, {
      name: 'in-aes',
      direction: 'inbound',
      inboundPath: 'aes',
      targetUrl: `${upstream.baseUrl}/echo`,
      encryptionMode: 'aes-256-gcm',
      wireFormat: 'binary',
      aesSecret: aesKeyB64,
    });
    // AES route that stores payloads in logs.
    await createTestRoute(app, {
      name: 'in-aes-log',
      direction: 'inbound',
      inboundPath: 'aes-log',
      method: 'POST',
      targetUrl: `${upstream.baseUrl}/echo`,
      encryptionMode: 'aes-256-gcm',
      wireFormat: 'binary',
      aesSecret: aesKeyB64,
      logPayloads: true,
    });
    // Disabled route.
    await createTestRoute(app, {
      name: 'in-disabled',
      direction: 'inbound',
      inboundPath: 'disabled',
      method: 'POST',
      targetUrl: `${upstream.baseUrl}/echo`,
      enabled: false,
    });
    // Small body cap route.
    await createTestRoute(app, {
      name: 'in-small',
      direction: 'inbound',
      inboundPath: 'small',
      method: 'POST',
      targetUrl: `${upstream.baseUrl}/echo`,
      maxBodyMb: 1,
    });

    // RSA hybrid inbound routes: the own key decrypts requests, the partner
    // key encrypts responses (unless responseEncrypted is false).
    const rsaOwn = await createRsaKeyFixture(app, { name: 'rsa-in-own', direction: 'own' });
    const rsaPartner = await createRsaKeyFixture(app, { name: 'rsa-in-partner', direction: 'partner' });
    rsaOwnPublicPem = rsaOwn.publicPem;
    rsaPartnerPrivatePem = rsaPartner.privatePem;
    await createTestRoute(app, {
      name: 'in-rsa',
      direction: 'inbound',
      inboundPath: 'rsa',
      method: 'POST',
      targetUrl: `${upstream.baseUrl}/echo`,
      encryptionMode: 'rsa-oaep',
      wireFormat: 'binary',
      rsaDecryptKeyName: rsaOwn.keyName,
      rsaEncryptKeyName: rsaPartner.keyName,
    });
    await createTestRoute(app, {
      name: 'in-rsa-plain-resp',
      direction: 'inbound',
      inboundPath: 'rsa-plain-resp',
      method: 'POST',
      targetUrl: `${upstream.baseUrl}/echo`,
      encryptionMode: 'rsa-oaep',
      wireFormat: 'binary',
      rsaDecryptKeyName: rsaOwn.keyName,
      responseEncrypted: false,
    });
  }, 300000);

  afterAll(async () => {
    await upstream.stop();
    await app?.destroy();
  });

  it('forwards an unencrypted request and passes the response through', async () => {
    const key = await createTestApiKey(app, { scopes: ['inbound'] });
    const payload = JSON.stringify({ hello: 'world' });
    const res = await request
      .post(`${INBOUND_PREFIX}plain`)
      .set('X-API-Key', key)
      .set('Content-Type', 'application/json')
      .send(payload);
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.text).toBe(payload);
    expect(upstream.lastRequest?.body.toString('utf8')).toBe(payload);
  });

  it('returns 404 for an unknown inbound path', async () => {
    const key = await createTestApiKey(app, { scopes: ['inbound'] });
    const res = await request.post(`${INBOUND_PREFIX}nope`).set('X-API-Key', key).send('{}');
    expect(res.status).toBe(404);
  });

  it('returns 404 for a disabled route', async () => {
    const key = await createTestApiKey(app, { scopes: ['inbound'] });
    const res = await request.post(`${INBOUND_PREFIX}disabled`).set('X-API-Key', key).send('{}');
    expect(res.status).toBe(404);
  });


  it('normalizes a trailing slash on the inbound path', async () => {
    const key = await createTestApiKey(app, { scopes: ['inbound'] });
    const res = await request.post(`${INBOUND_PREFIX}plain/`).set('X-API-Key', key).send('{}');
    expect(res.status).toBe(200);
    expect(res.text).toBe('plain-ok');
  });

  it('normalizes multiple trailing slashes on the inbound path', async () => {
    const key = await createTestApiKey(app, { scopes: ['inbound'] });
    const res = await request.post(`${INBOUND_PREFIX}plain///`).set('X-API-Key', key).send('{}');
    expect(res.status).toBe(200);
  });
  it('returns 405 when the method does not match', async () => {
    const key = await createTestApiKey(app, { scopes: ['inbound'] });
    const res = await request.get(`${INBOUND_PREFIX}plain`).set('X-API-Key', key);
    expect(res.status).toBe(405);
    expect(res.body.error.code).toBe('APIM_METHOD_NOT_ALLOWED');
  });

  it('forwards the caller query string to the target', async () => {
    const key = await createTestApiKey(app, { scopes: ['inbound'] });
    const res = await request
      .post(`${INBOUND_PREFIX}plain?batch=5&urgent=1`)
      .set('X-API-Key', key)
      .set('Content-Type', 'application/json')
      .send('{"q":true}');
    expect(res.status).toBe(200);
    expect(upstream.lastRequest?.path).toBe('/echo?batch=5&urgent=1');
  });
  it('forwards a GET request with query-only params (inbound)', async () => {
    const key = await createTestApiKey(app, { scopes: ['inbound'] });
    const before = upstream.requests.length;
    const res = await request.get(`${INBOUND_PREFIX}get?batch=5&urgent=1`).set('X-API-Key', key);
    expect(res.status).toBe(200);
    const forwarded = upstream.requests[before];
    expect(forwarded.method).toBe('GET');
    expect(forwarded.path).toBe('/echo?batch=5&urgent=1');
    expect(forwarded.body.length).toBe(0);
  });
  it('decrypts an inbound encrypted file envelope and forwards the file with metadata headers', async () => {
    const key = await createTestApiKey(app, { scopes: ['inbound'] });
    const fileBytes = Buffer.from('%PDF-1.7 partner-sent invoice data');
    // Partner encrypts the file into a JSON envelope using the shared secret.
    const container = aesGcmEncrypt(fileBytes, { key: aesKey });
    const envelope = JSON.stringify({
      container: 'NCB1',
      encoding: 'base64',
      ciphertext: container.toString('base64'),
      contentType: 'application/pdf',
    });
    const before = upstream.requests.length;
    const res = await request
      .post(`${INBOUND_PREFIX}file-json`)
      .set('X-API-Key', key)
      .set('Content-Type', 'application/json')
      .set('X-File-Name', 'partner-invoice.pdf')
      .set('X-File-Content-Type', 'application/pdf')
      .set('X-File-Sha256', 'abc123')
      .send(envelope);
    expect(res.status).toBe(200);
    const forwarded = upstream.requests[before];
    expect(forwarded.body.equals(fileBytes)).toBe(true);
    expect(String(forwarded.headers['content-type'])).toContain('application/pdf');
    expect(String(forwarded.headers['x-file-name'])).toBe('partner-invoice.pdf');
    expect(String(forwarded.headers['x-file-content-type'])).toBe('application/pdf');
    expect(String(forwarded.headers['x-file-sha256'])).toBe('abc123');
  });

  it('decrypts an inbound binary-wire file and forwards plaintext + sniffed content-type + headers', async () => {
    const key = await createTestApiKey(app, { scopes: ['inbound'] });
    const fileBytes = Buffer.from('%PDF-1.7 binary wire file content');
    const container = aesGcmEncrypt(fileBytes, { key: aesKey });
    const before = upstream.requests.length;
    const res = await request
      .post(`${INBOUND_PREFIX}file-binary`)
      .set('X-API-Key', key)
      .set('Content-Type', 'application/octet-stream')
      .set('X-File-Name', 'file-binary.pdf')
      .set('X-File-Sha256', 'binary-file-sha')
      .send(container);
    expect(res.status).toBe(200);
    const forwarded = upstream.requests[before];
    expect(forwarded.body.equals(fileBytes)).toBe(true);
    expect(String(forwarded.headers['content-type'])).toContain('application/octet-stream');
    expect(String(forwarded.headers['x-file-name'])).toBe('file-binary.pdf');
    expect(String(forwarded.headers['x-file-sha256'])).toBe('binary-file-sha');
  });

  describe('API key auth', () => {
    it('rejects a missing key with 401', async () => {
      const res = await request.post(`${INBOUND_PREFIX}plain`).send('{}');
      expect(res.status).toBe(401);
    });

    it('rejects an invalid key with 401', async () => {
      const res = await request.post(`${INBOUND_PREFIX}plain`).set('X-API-Key', 'apim_bogus').send('{}');
      expect(res.status).toBe(401);
    });

    it('rejects an expired key with 401', async () => {
      const key = await createTestApiKey(app, { scopes: ['inbound'], expiresAt: new Date(Date.now() - 60000) });
      const res = await request.post(`${INBOUND_PREFIX}plain`).set('X-API-Key', key).send('{}');
      expect(res.status).toBe(401);
    });

    it('rejects a disabled key with 401', async () => {
      const key = await createTestApiKey(app, { scopes: ['inbound'], enabled: false });
      const res = await request.post(`${INBOUND_PREFIX}plain`).set('X-API-Key', key).send('{}');
      expect(res.status).toBe(401);
    });

    it('rejects a key without the inbound scope with 403', async () => {
      const key = await createTestApiKey(app, { scopes: ['outbound'] });
      const res = await request.post(`${INBOUND_PREFIX}plain`).set('X-API-Key', key).send('{}');
      expect(res.status).toBe(403);
    });

    it('rejects a route-scoped key aimed at a different route with 403', async () => {
      const key = await createTestApiKey(app, { scopes: ['inbound:other-route'] });
      const res = await request.post(`${INBOUND_PREFIX}plain`).set('X-API-Key', key).send('{}');
      expect(res.status).toBe(403);
    });

    it('accepts a route-scoped key matching the route', async () => {
      const key = await createTestApiKey(app, { scopes: ['inbound:in-plain'] });
      const res = await request
        .post(`${INBOUND_PREFIX}plain`)
        .set('X-API-Key', key)
        .set('Content-Type', 'application/json')
        .send('{"ok":true}');
      expect(res.status).toBe(200);
    });
  });

  describe('AES encryption', () => {
    it('decrypts the inbound request and encrypts the response', async () => {
      const key = await createTestApiKey(app, { scopes: ['inbound'] });
      const plaintext = Buffer.from(JSON.stringify({ order: 7, total: 99.5 }), 'utf8');
      const container = aesGcmEncrypt(plaintext, { key: aesKey });
      expect(isAesContainer(container)).toBe(true);

      const res = await request
        .post(`${INBOUND_PREFIX}aes`)
        .set('X-API-Key', key)
        .set('Content-Type', 'application/octet-stream')
        .buffer(true)
        .parse(binaryParser)
        .send(container);

      expect(res.status).toBe(200);
      // The proxy must have decrypted before forwarding: upstream sees plaintext.
      expect(upstream.lastRequest?.body.equals(plaintext)).toBe(true);
      // The response is an AES container that decrypts to the upstream echo (plaintext).
      const responseBody = res.body as Buffer;
      expect(isAesContainer(responseBody)).toBe(true);
      const decrypted = aesGcmDecrypt(responseBody, { key: aesKey });
      expect(decrypted.equals(plaintext)).toBe(true);
    });

    it('returns 400 when the inbound ciphertext cannot be decrypted', async () => {
      const key = await createTestApiKey(app, { scopes: ['inbound'] });
      const garbage = Buffer.concat([Buffer.from('NCB1'), randomBytes(64)]);
      const res = await request
        .post(`${INBOUND_PREFIX}aes`)
        .set('X-API-Key', key)
        .set('Content-Type', 'application/octet-stream')
        .send(garbage);
      expect(res.status).toBe(400);
      expect(res.body?.error?.code).toBe('APIM_DECRYPT_FAILED');
    });

    it('sniffs the forwarded content type when the envelope carries none (XML)', async () => {
      const key = await createTestApiKey(app, { scopes: ['inbound'] });
      const xml = Buffer.from('<ping id="7"/>', 'utf8');
      const container = aesGcmEncrypt(xml, { key: aesKey });
      const res = await request
        .post(`${INBOUND_PREFIX}aes`)
        .set('X-API-Key', key)
        .set('Content-Type', 'application/octet-stream')
        .buffer(true)
        .parse(binaryParser)
        .send(container);
      expect(res.status).toBe(200);
      expect(upstream.lastRequest?.body.equals(xml)).toBe(true);
      // The binary wire format carries no plaintext content type, so the proxy
      // must sniff the decrypted bytes (leading "<" -> XML) before forwarding.
      expect(String(upstream.lastRequest?.headers['content-type'])).toContain('application/xml');
    });
  });

  describe('body size cap', () => {
    it('returns 413 for an oversized body', async () => {
      const key = await createTestApiKey(app, { scopes: ['inbound'] });
      const big = randomBytes(1.5 * 1024 * 1024); // > 1 MB cap
      const res = await request
        .post(`${INBOUND_PREFIX}small`)
        .set('X-API-Key', key)
        .set('Content-Type', 'application/octet-stream')
        .send(big);
      expect(res.status).toBe(413);
    });
  });

  describe('audit logging', () => {
    it('records sha256, sizes and duration without payloads by default', async () => {
      const key = await createTestApiKey(app, { scopes: ['inbound'] });
      const payload = JSON.stringify({ audit: 'no-payload' });
      const res = await request
        .post(`${INBOUND_PREFIX}plain`)
        .set('X-API-Key', key)
        .set('Content-Type', 'application/json')
        .send(payload);
      expect(res.status).toBe(200);
      const requestId = res.headers['x-request-id'];
      expect(requestId).toBeTruthy();

      const log = await app.db.getRepository('apiRequestLogs').findOne({ filter: { requestId } });
      expect(log).toBeTruthy();
      expect(log.get('status')).toBe('ok');
      expect(log.get('direction')).toBe('inbound');
      expect(log.get('routeName')).toBe('in-plain');
      expect(log.get('httpStatus')).toBe(200);
      expect(log.get('upstreamStatus')).toBe(200);
      expect(log.get('requestSha256')).toBe(sha256Hex(Buffer.from(payload, 'utf8')));
      expect(Number(log.get('requestBytes'))).toBe(Buffer.byteLength(payload));
      expect(Number(log.get('durationMs'))).toBeGreaterThanOrEqual(0);
      expect(log.get('requestPayload')).toBeNull();
      expect(log.get('responsePayload')).toBeNull();
    });

    it('stores payloads when logPayloads is enabled', async () => {
      const key = await createTestApiKey(app, { scopes: ['inbound'] });
      const plaintext = Buffer.from(JSON.stringify({ audit: 'with-payload' }), 'utf8');
      const container = aesGcmEncrypt(plaintext, { key: aesKey });
      const res = await request
        .post(`${INBOUND_PREFIX}aes-log`)
        .set('X-API-Key', key)
        .set('Content-Type', 'application/octet-stream')
        .buffer(true)
        .parse(binaryParser)
        .send(container);
      expect(res.status).toBe(200);
      const requestId = res.headers['x-request-id'];

      const log = await app.db.getRepository('apiRequestLogs').findOne({ filter: { requestId } });
      expect(log).toBeTruthy();
      expect(log.get('requestPayload')).toBeTruthy();
      expect(log.get('responsePayload')).toBeTruthy();
      // Stored request payload is the raw (encrypted) bytes the partner sent.
      const storedRequest = Buffer.from(String(log.get('requestPayload')), 'base64');
      expect(storedRequest.equals(container)).toBe(true);
    });

    it('records rejected auth attempts', async () => {
      const res = await request.post(`${INBOUND_PREFIX}plain`).send('{}');
      expect(res.status).toBe(401);
      const requestId = res.headers['x-request-id'];
      const log = await app.db.getRepository('apiRequestLogs').findOne({ filter: { requestId } });
      expect(log).toBeTruthy();
      expect(log.get('status')).toBe('rejected');
      expect(log.get('httpStatus')).toBe(401);
    });
  });

  describe('PGP encryption', () => {
    it('decrypts the inbound request and encrypts the response', async () => {
      // Own key: the proxy decrypts partner requests and signs/encrypts responses.
      const own = await createPgpKeyFixture(app, { name: 'pgp-in-own', direction: 'own' });
      // Partner key: the partner signs requests; the proxy encrypts responses to it.
      const partner = await createPgpKeyFixture(app, { name: 'pgp-in-partner', direction: 'partner' });

      await createTestRoute(app, {
        name: 'in-pgp',
        direction: 'inbound',
        inboundPath: 'pgp',
        method: 'POST',
        targetUrl: `${upstream.baseUrl}/echo`,
        encryptionMode: 'pgp',
        wireFormat: 'binary',
        pgpDecryptKeyName: own.keyName,
        pgpVerifyKeyName: partner.keyName,
        pgpEncryptKeyName: partner.keyName,
        pgpSignKeyName: own.keyName,
      });
      const key = await createTestApiKey(app, { scopes: ['inbound'] });

      const plaintext = Buffer.from(JSON.stringify({ pgp: 'inbound' }), 'utf8');
      // Partner encrypts to the proxy's own key and signs with the partner key.
      const ciphertext = await encryptAndSign({
        data: plaintext,
        recipientKeys: [{ armored: own.pair.publicKey }],
        signerKey: { armored: partner.pair.privateKey },
      });

      const res = await request
        .post(`${INBOUND_PREFIX}pgp`)
        .set('X-API-Key', key)
        .set('Content-Type', 'application/octet-stream')
        .buffer(true)
        .parse(binaryParser)
        .send(Buffer.from(ciphertext));

      expect(res.status).toBe(200);
      // Upstream received the decrypted plaintext.
      expect(upstream.lastRequest?.body.equals(plaintext)).toBe(true);

      // Partner decrypts the response with its private key and verifies the proxy signature.
      const decrypted = await decryptAndVerify({
        data: res.body as Buffer,
        privateKey: { armored: partner.pair.privateKey },
        verificationKeys: [{ armored: own.pair.publicKey }],
      });
      expect(Buffer.from(decrypted.data).equals(plaintext)).toBe(true);
      expect(decrypted.signatureValid).toBe(true);
    }, 120000);
  });

  describe('RSA-OAEP hybrid encryption', () => {
    it('decrypts the inbound request and encrypts the response', async () => {
      const key = await createTestApiKey(app, { scopes: ['inbound'] });
      const plaintext = Buffer.from(JSON.stringify({ rsa: 'inbound' }), 'utf8');
      // The partner encrypts to the proxy's own public key.
      const container = rsaHybridEncrypt(plaintext, rsaOwnPublicPem);
      expect(isRsaHybridContainer(container)).toBe(true);

      const res = await request
        .post(`${INBOUND_PREFIX}rsa`)
        .set('X-API-Key', key)
        .set('Content-Type', 'application/octet-stream')
        .buffer(true)
        .parse(binaryParser)
        .send(container);

      expect(res.status).toBe(200);
      // The proxy must have decrypted before forwarding: upstream sees plaintext.
      expect(upstream.lastRequest?.body.equals(plaintext)).toBe(true);
      // The response is an NCR1 container that the partner decrypts with its private key.
      const responseBody = res.body as Buffer;
      expect(isRsaHybridContainer(responseBody)).toBe(true);
      expect(rsaHybridDecrypt(responseBody, rsaPartnerPrivatePem).equals(plaintext)).toBe(true);
    });

    it('returns a plaintext response when responseEncrypted is false', async () => {
      const key = await createTestApiKey(app, { scopes: ['inbound'] });
      const plaintext = Buffer.from(JSON.stringify({ rsa: 'plain-resp' }), 'utf8');
      const container = rsaHybridEncrypt(plaintext, rsaOwnPublicPem);

      const res = await request
        .post(`${INBOUND_PREFIX}rsa-plain-resp`)
        .set('X-API-Key', key)
        .set('Content-Type', 'application/octet-stream')
        .buffer(true)
        .parse(binaryParser)
        .send(container);

      expect(res.status).toBe(200);
      // The request was still decrypted before forwarding.
      expect(upstream.lastRequest?.body.equals(plaintext)).toBe(true);
      // The response comes back as plaintext, not an NCR1 container.
      const responseBody = res.body as Buffer;
      expect(isRsaHybridContainer(responseBody)).toBe(false);
      expect(responseBody.equals(plaintext)).toBe(true);
    });
  });

  describe('authMode route control', () => {
    it("allows a plugin API key on an 'api-key' inbound route", async () => {
      await createTestRoute(app, {
        name: 'in-authmode-api-key',
        direction: 'inbound',
        inboundPath: 'authmode-api-key',
        method: 'POST',
        targetUrl: `${upstream.baseUrl}/echo`,
        encryptionMode: 'none',
        authMode: 'api-key',
      });
      const key = await createTestApiKey(app, { scopes: ['inbound:in-authmode-api-key'] });
      const res = await request
        .post(`${INBOUND_PREFIX}authmode-api-key`)
        .set('X-API-Key', key)
        .set('Content-Type', 'application/json')
        .send('{"auth":true}');
      expect(res.status).toBe(200);
    });

    it("rejects a Bearer token on an 'api-key' inbound route (403)", async () => {
      await createTestRoute(app, {
        name: 'in-authmode-api-key-only',
        direction: 'inbound',
        inboundPath: 'authmode-api-key-only',
        method: 'POST',
        targetUrl: `${upstream.baseUrl}/echo`,
        encryptionMode: 'none',
        authMode: 'api-key',
      });
      const user = await app.db.getRepository('users').findOne({ filter: { email: process.env.INIT_ROOT_EMAIL } });
      const token = app.authManager.jwt.sign({ userId: user.get('id'), roleName: 'admin' }, { expiresIn: '1h' });
      const res = await request
        .post(`${INBOUND_PREFIX}authmode-api-key-only`)
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send('{"auth":true}');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('APIM_FORBIDDEN');
    });

    it("rejects an API key on a 'role' inbound route (403)", async () => {
      await createTestRoute(app, {
        name: 'in-authmode-role-only',
        direction: 'inbound',
        inboundPath: 'authmode-role-only',
        method: 'POST',
        targetUrl: `${upstream.baseUrl}/echo`,
        encryptionMode: 'none',
        authMode: 'role',
      });
      const key = await createTestApiKey(app, { scopes: ['inbound:in-authmode-role-only'] });
      const res = await request
        .post(`${INBOUND_PREFIX}authmode-role-only`)
        .set('X-API-Key', key)
        .set('Content-Type', 'application/json')
        .send('{"auth":true}');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('APIM_FORBIDDEN');
    });
  });

  describe('app Bearer token auth (NocoBase JWT) - inbound', () => {
    it('grants access with a valid app token whose role may call the route', async () => {
      const { registerRouteSnippets } = await import('../services/acl');
      registerRouteSnippets(app.acl, ['in-plain']);
      const user = await app.db.getRepository('users').findOne({ filter: { email: process.env.INIT_ROOT_EMAIL } });
      const token = app.authManager.jwt.sign({ userId: user.get('id'), roleName: 'admin' }, { expiresIn: '1h' });
      const res = await request
        .post(`${INBOUND_PREFIX}plain`)
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send('{"acl":true}');
      expect(res.status).toBe(200);
    });

    it('denies access when the app token role lacks the route grant (403)', async () => {
      const { registerRouteSnippets } = await import('../services/acl');
      registerRouteSnippets(app.acl, ['in-plain']);
      const user = await app.db.getRepository('users').findOne({ filter: { email: process.env.INIT_ROOT_EMAIL } });
      const token = app.authManager.jwt.sign({ userId: user.get('id'), roleName: 'member' }, { expiresIn: '1h' });
      const res = await request
        .post(`${INBOUND_PREFIX}plain`)
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send('{"acl":true}');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('APIM_FORBIDDEN');
    });

    it('rejects an invalid app token with 401', async () => {
      const res = await request
        .post(`${INBOUND_PREFIX}plain`)
        .set('Authorization', 'Bearer not-a-real-token')
        .set('Content-Type', 'application/json')
        .send('{"acl":true}');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('APIM_UNAUTHORIZED');
    });
  });
});
