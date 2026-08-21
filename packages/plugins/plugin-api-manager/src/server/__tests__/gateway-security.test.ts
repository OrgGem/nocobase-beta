import { createHash, createHmac, randomBytes } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MockServer } from '@nocobase/test';
import supertest from 'supertest';
import { INBOUND_PREFIX, OUTBOUND_PREFIX } from '../../constants';
import { verifyJwt } from '../services/jwt';
import { MockUpstream, createRsaKeyFixture, createTestApiKey, createTestApp, createTestRoute } from './helpers';

const HMAC_SECRET = 'gateway-hmac-secret';
const JWT_HS_SECRET = 'gateway-jwt-hs-secret';

function hmacHeaders(secret: string, method: string, path: string, body: Buffer): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString('hex');
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const canonical = [timestamp, nonce, method.toUpperCase(), path, bodyHash].join('\n');
  const signature = createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
  return {
    'X-APIM-Timestamp': timestamp,
    'X-APIM-Nonce': nonce,
    'X-APIM-Signature': signature,
  };
}

describe('gateway security features', () => {
  let app: MockServer;
  let request: ReturnType<typeof supertest>;
  let apiKey: string;
  let rsaOwn: Awaited<ReturnType<typeof createRsaKeyFixture>>;
  let rsaPartner: Awaited<ReturnType<typeof createRsaKeyFixture>>;
  const upstream = new MockUpstream();

  beforeAll(async () => {
    await upstream.start();
    app = await createTestApp();
    request = supertest(app.callback());
    apiKey = await createTestApiKey(app);

    rsaOwn = await createRsaKeyFixture(app, { name: 'jwt-sign-own', direction: 'own' });
    rsaPartner = await createRsaKeyFixture(app, { name: 'jwt-verify-partner', direction: 'partner' });

    // Inbound routes.
    await createTestRoute(app, {
      name: 'sec-hmac-in',
      direction: 'inbound',
      inboundPath: 'hmac-in',
      method: 'POST',
      targetUrl: `${upstream.baseUrl}/echo`,
      hmacVerifyEnabled: true,
      hmacSecret: HMAC_SECRET,
      hmacToleranceSec: 300,
    });
    await createTestRoute(app, {
      name: 'sec-jwt-hs-in',
      direction: 'inbound',
      inboundPath: 'jwt-hs-in',
      method: 'POST',
      targetUrl: `${upstream.baseUrl}/echo`,
      jwtVerifyEnabled: true,
      jwtSecret: JWT_HS_SECRET,
      jwtIssuer: 'partner',
      jwtAudience: 'apim',
    });
    await createTestRoute(app, {
      name: 'sec-jwt-rs-in',
      direction: 'inbound',
      inboundPath: 'jwt-rs-in',
      method: 'POST',
      targetUrl: `${upstream.baseUrl}/echo`,
      jwtVerifyEnabled: true,
      jwtVerifyKeyName: rsaPartner.keyName,
    });
    await createTestRoute(app, {
      name: 'sec-rate-in',
      direction: 'inbound',
      inboundPath: 'rate-in',
      method: 'POST',
      targetUrl: `${upstream.baseUrl}/echo`,
      rateLimitEnabled: true,
      rateLimitMax: 2,
      rateLimitWindowSec: 60,
    });
    await createTestRoute(app, {
      name: 'sec-ip-blocked',
      direction: 'inbound',
      inboundPath: 'ip-blocked',
      method: 'POST',
      targetUrl: `${upstream.baseUrl}/echo`,
      ipAllowlist: ['203.0.113.7'],
    });
    await createTestRoute(app, {
      name: 'sec-ip-allowed',
      direction: 'inbound',
      inboundPath: 'ip-allowed',
      method: 'POST',
      targetUrl: `${upstream.baseUrl}/echo`,
      ipAllowlist: ['127.0.0.1', '::1'],
    });

    // Outbound routes.
    await createTestRoute(app, {
      name: 'sec-hmac-out',
      direction: 'outbound',
      method: 'POST',
      targetUrl: `${upstream.baseUrl}/echo`,
      hmacSignEnabled: true,
      hmacSecret: HMAC_SECRET,
    });
    await createTestRoute(app, {
      name: 'sec-jwt-rs-out',
      direction: 'outbound',
      method: 'POST',
      targetUrl: `${upstream.baseUrl}/echo`,
      jwtSignEnabled: true,
      jwtSignAlgorithm: 'RS256',
      jwtSignKeyName: rsaOwn.keyName,
      jwtIssuer: 'apim',
      jwtAudience: 'backend',
      jwtExpiresInSec: 120,
    });
    await createTestRoute(app, {
      name: 'sec-jwt-hs-out',
      direction: 'outbound',
      method: 'POST',
      targetUrl: `${upstream.baseUrl}/echo`,
      jwtSignEnabled: true,
      jwtSignAlgorithm: 'HS256',
      jwtSecret: JWT_HS_SECRET,
    });
  }, 300000);

  afterAll(async () => {
    await upstream.stop();
    await app.destroy();
  });

  describe('inbound HMAC verification', () => {
    it('accepts a correctly signed request', async () => {
      const bodyStr = JSON.stringify({ ok: true });
      const body = Buffer.from(bodyStr);
      const path = `${INBOUND_PREFIX}hmac-in`;
      const headers = hmacHeaders(HMAC_SECRET, 'POST', path, body);
      const res = await request
        .post(path)
        .set('X-API-Key', apiKey)
        .set(headers)
        .set('Content-Type', 'application/json')
        .send(bodyStr);
      expect(res.status).toBe(200);
    });

    it('rejects a request with a bad signature', async () => {
      const body = Buffer.from(JSON.stringify({ ok: true }));
      const path = `${INBOUND_PREFIX}hmac-in`;
      const headers = hmacHeaders('wrong-secret', 'POST', path, body);
      const res = await request
        .post(path)
        .set('X-API-Key', apiKey)
        .set(headers)
        .set('Content-Type', 'application/json')
        .send(body);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('APIM_HMAC_INVALID');
    });

    it('rejects a request missing HMAC headers', async () => {
      const res = await request
        .post(`${INBOUND_PREFIX}hmac-in`)
        .set('X-API-Key', apiKey)
        .set('Content-Type', 'application/json')
        .send('{}');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('APIM_HMAC_INVALID');
    });

    it('accepts a signature computed over path + query string', async () => {
      const bodyStr = JSON.stringify({ ok: true });
      const body = Buffer.from(bodyStr);
      const path = `${INBOUND_PREFIX}hmac-in?batch=42&urgent=1`;
      const headers = hmacHeaders(HMAC_SECRET, 'POST', path, body);
      const res = await request
        .post(path)
        .set('X-API-Key', apiKey)
        .set(headers)
        .set('Content-Type', 'application/json')
        .send(bodyStr);
      expect(res.status).toBe(200);
    });

    it('rejects a path-only signature when a query string is present', async () => {
      const body = Buffer.from(JSON.stringify({ ok: true }));
      const headers = hmacHeaders(HMAC_SECRET, 'POST', `${INBOUND_PREFIX}hmac-in`, body);
      const res = await request
        .post(`${INBOUND_PREFIX}hmac-in?batch=42`)
        .set('X-API-Key', apiKey)
        .set(headers)
        .set('Content-Type', 'application/json')
        .send(body);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('APIM_HMAC_INVALID');
    });
  });

  describe('inbound JWT verification', () => {
    it('accepts a valid HS256 token', async () => {
      const { signJwt } = await import('../services/jwt');
      const token = signJwt({
        algorithm: 'HS256',
        secret: JWT_HS_SECRET,
        issuer: 'partner',
        audience: 'apim',
        expiresInSec: 60,
      });
      const res = await request
        .post(`${INBOUND_PREFIX}jwt-hs-in`)
        .set('X-API-Key', apiKey)
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send('{}');
      expect(res.status).toBe(200);
    });

    it('accepts a case-variant "bearer" auth scheme (RFC 6750 schemes are case-insensitive)', async () => {
      const { signJwt } = await import('../services/jwt');
      const token = signJwt({
        algorithm: 'HS256',
        secret: JWT_HS_SECRET,
        issuer: 'partner',
        audience: 'apim',
        expiresInSec: 60,
      });
      const res = await request
        .post(`${INBOUND_PREFIX}jwt-hs-in`)
        .set('X-API-Key', apiKey)
        .set('Authorization', `bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send('{}');
      expect(res.status).toBe(200);
    });

    it('rejects an HS256 token with the wrong issuer', async () => {
      const { signJwt } = await import('../services/jwt');
      const token = signJwt({
        algorithm: 'HS256',
        secret: JWT_HS_SECRET,
        issuer: 'attacker',
        audience: 'apim',
        expiresInSec: 60,
      });
      const res = await request
        .post(`${INBOUND_PREFIX}jwt-hs-in`)
        .set('X-API-Key', apiKey)
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send('{}');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('APIM_JWT_INVALID');
    });

    it('accepts a valid RS256 token signed by the partner key', async () => {
      const { signJwt } = await import('../services/jwt');
      const token = signJwt({ algorithm: 'RS256', privateKeyPem: rsaPartner.privatePem, expiresInSec: 60 });
      const res = await request
        .post(`${INBOUND_PREFIX}jwt-rs-in`)
        .set('X-API-Key', apiKey)
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send('{}');
      expect(res.status).toBe(200);
    });

    it('rejects a missing Bearer token', async () => {
      const res = await request
        .post(`${INBOUND_PREFIX}jwt-hs-in`)
        .set('X-API-Key', apiKey)
        .set('Content-Type', 'application/json')
        .send('{}');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('APIM_JWT_INVALID');
    });
  });

  describe('rate limiting', () => {
    it('allows up to the limit then returns 429 with Retry-After', async () => {
      const path = `${INBOUND_PREFIX}rate-in`;
      const first = await request.post(path).set('X-API-Key', apiKey).send('{}');
      expect(first.status).toBe(200);
      const second = await request.post(path).set('X-API-Key', apiKey).send('{}');
      expect(second.status).toBe(200);
      const third = await request.post(path).set('X-API-Key', apiKey).send('{}');
      expect(third.status).toBe(429);
      expect(third.body.error.code).toBe('APIM_RATE_LIMITED');
      expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
    });
  });

  describe('IP allowlist', () => {
    it('rejects a client outside the allowlist', async () => {
      const res = await request.post(`${INBOUND_PREFIX}ip-blocked`).set('X-API-Key', apiKey).send('{}');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('APIM_IP_FORBIDDEN');
    });

    it('allows localhost when it is on the allowlist', async () => {
      const res = await request.post(`${INBOUND_PREFIX}ip-allowed`).set('X-API-Key', apiKey).send('{}');
      expect(res.status).toBe(200);
    });
  });

  describe('outbound HMAC signing', () => {
    it('adds HMAC headers to the forwarded request', async () => {
      const before = upstream.requests.length;
      const res = await request
        .post(`${OUTBOUND_PREFIX}sec-hmac-out`)
        .set('X-API-Key', apiKey)
        .set('Content-Type', 'application/json')
        .send('{"signed":true}');
      expect(res.status).toBe(200);
      const forwarded = upstream.requests[before];
      expect(forwarded.headers['x-apim-timestamp']).toBeDefined();
      expect(forwarded.headers['x-apim-nonce']).toBeDefined();
      expect(forwarded.headers['x-apim-signature']).toMatch(/^[0-9a-f]{64}$/);
    });

    it('signs the target path including the forwarded query string', async () => {
      const before = upstream.requests.length;
      const res = await request
        .post(`${OUTBOUND_PREFIX}sec-hmac-out?batch=7`)
        .set('X-API-Key', apiKey)
        .set('Content-Type', 'application/json')
        .send('{"signed-with-query":true}');
      expect(res.status).toBe(200);
      const forwarded = upstream.requests[before];
      expect(forwarded.path).toBe('/echo?batch=7');
      const timestamp = String(forwarded.headers['x-apim-timestamp']);
      const nonce = String(forwarded.headers['x-apim-nonce']);
      const bodyHash = createHash('sha256').update(forwarded.body).digest('hex');
      const canonical = [timestamp, nonce, 'POST', '/echo?batch=7', bodyHash].join('\n');
      const expected = createHmac('sha256', HMAC_SECRET).update(canonical, 'utf8').digest('hex');
      expect(forwarded.headers['x-apim-signature']).toBe(expected);
    });
  });

  describe('outbound JWT signing', () => {
    it('mints an RS256 Bearer token verifiable with the own public key', async () => {
      const before = upstream.requests.length;
      const res = await request
        .post(`${OUTBOUND_PREFIX}sec-jwt-rs-out`)
        .set('X-API-Key', apiKey)
        .set('Content-Type', 'application/json')
        .send('{}');
      expect(res.status).toBe(200);
      const forwarded = upstream.requests[before];
      const authorization = String(forwarded.headers.authorization ?? '');
      expect(authorization.startsWith('Bearer ')).toBe(true);
      const payload = verifyJwt({
        token: authorization.slice(7),
        algorithms: ['RS256'],
        publicKeyPem: rsaOwn.publicPem,
        issuer: 'apim',
        audience: 'backend',
      });
      expect(payload.iss).toBe('apim');
    });

    it('mints an HS256 Bearer token with the shared secret', async () => {
      const before = upstream.requests.length;
      const res = await request
        .post(`${OUTBOUND_PREFIX}sec-jwt-hs-out`)
        .set('X-API-Key', apiKey)
        .set('Content-Type', 'application/json')
        .send('{}');
      expect(res.status).toBe(200);
      const forwarded = upstream.requests[before];
      const authorization = String(forwarded.headers.authorization ?? '');
      expect(authorization.startsWith('Bearer ')).toBe(true);
      const payload = verifyJwt({ token: authorization.slice(7), algorithms: ['HS256'], secret: JWT_HS_SECRET });
      expect(typeof payload.exp).toBe('number');
    });
  });
});
