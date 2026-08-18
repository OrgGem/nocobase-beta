import { randomBytes } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MockServer } from '@nocobase/test';
import { APIM_ACL } from '../../constants';
import { createTestApp, createTestRoute, loginAgent } from './helpers';

function unwrap(res: { body: unknown }): Record<string, unknown> {
  const body = res.body as Record<string, unknown> | undefined;
  if (body && typeof body === 'object' && 'data' in body && body.data && typeof body.data === 'object') {
    return body.data as Record<string, unknown>;
  }
  return (body ?? {}) as Record<string, unknown>;
}

function extractRows(res: { body: unknown }): Record<string, unknown>[] {
  const body = res.body as { data?: unknown } | undefined;
  const data = body?.data;
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === 'object' && Array.isArray((data as { rows?: unknown[] }).rows)) {
    return (data as { rows: Record<string, unknown>[] }).rows;
  }
  return [];
}

describe('plugin-api-manager (smoke)', () => {
  let app: MockServer;
  let agent: Awaited<ReturnType<typeof loginAgent>>;

  beforeAll(async () => {
    app = await createTestApp();
    agent = await loginAgent(app);
  }, 300000);

  afterAll(async () => {
    await app?.destroy();
  });

  it('registers all collections', () => {
    expect(app.db.getCollection('apiPartners')).toBeTruthy();
    expect(app.db.getCollection('apiManagerApiKeys')).toBeTruthy();
    expect(app.db.getCollection('apiRoutes')).toBeTruthy();
    expect(app.db.getCollection('apiRequestLogs')).toBeTruthy();
  });

  it('registers the ACL snippet', () => {
    const snippets = (
      app.acl as unknown as { snippetManager?: { snippets?: Map<string, { name: string; actions: string[] }> } }
    ).snippetManager?.snippets;
    const snippet = snippets?.get(APIM_ACL);
    expect(snippet).toBeDefined();
    expect(snippet?.actions).toEqual(expect.arrayContaining(['apiRoutes:*', 'apiPartners:*']));
  });

  it('encrypts aesSecret at rest (DB value differs from plaintext)', async () => {
    const secret = `secret-${randomBytes(8).toString('hex')}`;
    const route = await createTestRoute(app, {
      name: 'smoke-aes',
      direction: 'outbound',
      targetUrl: 'http://127.0.0.1:9/echo',
      encryptionMode: 'aes-256-gcm',
      aesSecret: secret,
    });
    const stored = await app.db.getRepository('apiRoutes').findOne({ filterByTk: route.get('id') });
    const storedSecret = String(stored?.get('aesSecret'));
    expect(storedSecret).not.toBe(secret);
    // It must be decryptable back to the original via the app aesEncryptor.
    expect(await app.aesEncryptor.decrypt(storedSecret)).toBe(secret);
  });

  it('masks aesSecret in apiRoutes:get responses', async () => {
    const route = await createTestRoute(app, {
      name: 'smoke-mask',
      direction: 'outbound',
      targetUrl: 'http://127.0.0.1:9/echo',
      encryptionMode: 'aes-256-gcm',
      aesSecret: `mask-${randomBytes(8).toString('hex')}`,
    });
    const res = await agent.resource('apiRoutes').get({ filterByTk: route.get('id') });
    expect(res.status).toBe(200);
    const body = unwrap(res);
    expect(body.aesSecret).toBe('••••••••');
  });

  it('masks aesSecret in apiRoutes:list responses', async () => {
    await createTestRoute(app, {
      name: 'smoke-mask-list',
      direction: 'outbound',
      targetUrl: 'http://127.0.0.1:9/echo',
      encryptionMode: 'aes-256-gcm',
      aesSecret: `mask-list-${randomBytes(8).toString('hex')}`,
    });
    const res = await agent.resource('apiRoutes').list({ paginate: false });
    expect(res.status).toBe(200);
    const rows = extractRows(res);
    const masked = rows.filter((r) => typeof r.aesSecret === 'string' && r.aesSecret !== '');
    expect(masked.length).toBeGreaterThan(0);
    for (const row of masked) {
      expect(row.aesSecret).toBe('••••••••');
    }
  });

  it('rejects an invalid targetUrl', async () => {
    await expect(
      createTestRoute(app, {
        name: 'smoke-bad-url',
        direction: 'outbound',
        targetUrl: 'ftp://not-allowed.example.com',
      }),
    ).rejects.toThrow();
  });

  it('clamps retryCount and maxBodyMb to allowed ranges', async () => {
    const route = await createTestRoute(app, {
      name: 'smoke-clamp',
      direction: 'outbound',
      targetUrl: 'http://127.0.0.1:9/echo',
      retryCount: 99,
      maxBodyMb: 5000,
    });
    const stored = await app.db.getRepository('apiRoutes').findOne({ filterByTk: route.get('id') });
    expect(Number(stored?.get('retryCount'))).toBeLessThanOrEqual(5);
    expect(Number(stored?.get('maxBodyMb'))).toBeLessThanOrEqual(100);
  });
});
