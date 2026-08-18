import { randomBytes } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MockServer } from '@nocobase/test';
import supertest from 'supertest';
import { OUTBOUND_PREFIX } from '../../constants';
import { aesGcmDecrypt, isAesContainer } from '../services/crypto-primitives';
import { MockUpstream, createTestApiKey, createTestApp, createTestRoute } from './helpers';

describe('gateway outbound', () => {
  let app: MockServer;
  let request: ReturnType<typeof supertest>;
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
    await createTestRoute(app, {
      name: 'out-aes',
      direction: 'outbound',
      method: 'POST',
      targetUrl: `${upstream.baseUrl}/echo`,
      encryptionMode: 'aes-256-gcm',
      wireFormat: 'binary',
      aesSecret: aesKeyB64,
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
});
