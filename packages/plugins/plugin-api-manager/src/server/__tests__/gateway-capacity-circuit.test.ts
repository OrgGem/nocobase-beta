import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MockServer } from '@nocobase/test';
import supertest from 'supertest';
import { OUTBOUND_PREFIX } from '../../constants';
import { MockUpstream, createTestApiKey, createTestApp, createTestRoute } from './helpers';

describe('gateway capacity + circuit breaker (integration)', () => {
  let app: MockServer;
  let request: ReturnType<typeof supertest>;
  const upstream = new MockUpstream();

  beforeAll(async () => {
    await upstream.start();
    app = await createTestApp();
    request = supertest(app.callback());

    await createTestRoute(app, {
      name: 'cb-delay',
      direction: 'outbound',
      method: 'GET',
      targetUrl: `${upstream.baseUrl}/delay/120`,
      encryptionMode: 'none',
    });

    await createTestRoute(app, {
      name: 'cb-unreachable',
      direction: 'outbound',
      method: 'POST',
      targetUrl: 'http://127.0.0.1:9/unused',
      encryptionMode: 'none',
    });
  });

  afterAll(async () => {
    await upstream.stop();
    // Restore env that these tests mutate.
    delete process.env.APIM_MAX_CONCURRENT_REQUESTS;
    delete process.env.APIM_QUEUE_ENABLED;
    delete process.env.APIM_QUEUE_SIZE;
    delete process.env.APIM_CIRCUIT_BREAKER_FAILURE_THRESHOLD;
    delete process.env.APIM_CIRCUIT_BREAKER_OPEN_DURATION_MS;
  });

  it('queues excess concurrent requests and admits them with X-APIM-Queued-Ms', async () => {
    process.env.APIM_MAX_CONCURRENT_REQUESTS = '1';
    process.env.APIM_QUEUE_ENABLED = 'true';
    process.env.APIM_QUEUE_SIZE = '10';

    const key = await createTestApiKey(app, { scopes: ['outbound'] });
    const opts = { set: { 'X-API-Key': key } };

    const first = request.get(`${OUTBOUND_PREFIX}cb-delay`).set('X-API-Key', key);
    const second = request.get(`${OUTBOUND_PREFIX}cb-delay`).set('X-API-Key', key);

    void opts; // keep the shape explicit below

    const [a, b] = await Promise.all([first, second]);

    expect([a.status, b.status].sort()).toEqual([200, 200]);
    // Exactly one request should have waited behind the other.
    const queuedFlags = [a.headers['x-apim-queued-ms'], b.headers['x-apim-queued-ms']];
    expect(queuedFlags.filter((v) => v !== undefined).length).toBe(1);
    const queuedMs = Number(queuedFlags.find((v) => v !== undefined));
    expect(queuedMs).toBeGreaterThanOrEqual(0);
  });

  it('rejects immediately when queueing is disabled and capacity is exhausted', async () => {
    process.env.APIM_MAX_CONCURRENT_REQUESTS = '1';
    process.env.APIM_QUEUE_ENABLED = 'false';

    const key = await createTestApiKey(app, { scopes: ['outbound'] });

    const [a, b] = await Promise.all([
      request.get(`${OUTBOUND_PREFIX}cb-delay`).set('X-API-Key', key),
      request.get(`${OUTBOUND_PREFIX}cb-delay`).set('X-API-Key', key),
    ]);

    // One should succeed, the other should be rejected once it cannot queue.
    const statuses = [a.status, b.status].sort();
    expect(statuses).toContain(200);
    expect(statuses).toContain(429);
  });

  it('opens the circuit after consecutive upstream failures and rejects fast', async () => {
    process.env.APIM_CIRCUIT_BREAKER_FAILURE_THRESHOLD = '2';
    process.env.APIM_CIRCUIT_BREAKER_OPEN_DURATION_MS = '5000';

    const key = await createTestApiKey(app, { scopes: ['outbound'] });
    const url = `${OUTBOUND_PREFIX}cb-unreachable`;

    const r1 = await request.post(url).set('X-API-Key', key).send('{}');
    expect(r1.status).toBe(502);
    expect(r1.body.error.code).toBe('APIM_UPSTREAM_ERROR');

    const r2 = await request.post(url).set('X-API-Key', key).send('{}');
    expect(r2.status).toBe(502);
    expect(r2.body.error.code).toBe('APIM_UPSTREAM_ERROR');

    // Third request is rejected by the open circuit without reaching upstream.
    const r3 = await request.post(url).set('X-API-Key', key).send('{}');
    expect(r3.status).toBe(503);
    expect(r3.body.error.code).toBe('APIM_CIRCUIT_OPEN');
    expect(r3.headers['retry-after']).toBeDefined();
  });
});
