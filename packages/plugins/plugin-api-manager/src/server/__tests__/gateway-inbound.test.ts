import { randomBytes } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MockServer } from '@nocobase/test';
import supertest from 'supertest';
import { INBOUND_PREFIX } from '../../constants';
import { aesGcmDecrypt, aesGcmEncrypt, isAesContainer, sha256Hex } from '../services/crypto-primitives';
import {
  MockUpstream,
  binaryParser,
  createPgpKeyFixture,
  createTestApiKey,
  createTestApp,
  createTestRoute,
} from './helpers';
import { decryptAndVerify, encryptAndSign } from '../services/pgp';

describe('gateway inbound', () => {
  let app: MockServer;
  let request: ReturnType<typeof supertest>;
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
    // AES inbound route.
    await createTestRoute(app, {
      name: 'in-aes',
      direction: 'inbound',
      inboundPath: 'aes',
      method: 'POST',
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

  it('returns 405 when the method does not match', async () => {
    const key = await createTestApiKey(app, { scopes: ['inbound'] });
    const res = await request.get(`${INBOUND_PREFIX}plain`).set('X-API-Key', key);
    expect(res.status).toBe(405);
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
});
