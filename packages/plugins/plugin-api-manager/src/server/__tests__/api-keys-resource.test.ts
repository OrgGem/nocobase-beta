import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MockServer } from '@nocobase/test';
import { hashApiKey } from '../services/key-manager';
import { createTestApp, createTestApiKey, ensureTestPartner, loginAgent } from './helpers';

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

function errorMessage(res: { body: unknown; text?: string }): string {
  const body = res.body as { errors?: Array<{ message?: string }> } | undefined;
  const first = body?.errors?.[0]?.message;
  if (typeof first === 'string') return first;
  return res.text ?? '';
}

describe('apiManagerApiKeys resource', () => {
  let app: MockServer;
  let agent: Awaited<ReturnType<typeof loginAgent>>;
  let partnerId: number;

  beforeAll(async () => {
    app = await createTestApp();
    agent = await loginAgent(app);
    partnerId = await ensureTestPartner(app);
  }, 300000);

  afterAll(async () => {
    await app?.destroy();
  });

  it('create returns the plaintext key exactly once', async () => {
    const res = await agent.resource('apiManagerApiKeys').create({
      values: { name: 'once-key', scopes: ['inbound'], partnerId, expiresAt: null },
    });
    expect(res.status).toBe(200);
    const body = unwrap(res);
    expect(typeof body.apiKey).toBe('string');
    expect(String(body.apiKey).startsWith('apim_')).toBe(true);
    expect(body.keyHash).toBeUndefined();
    expect(body.keyPrefix).toBe(String(body.apiKey).slice(0, 12));

    // The stored row holds only the hash.
    const row = await app.db.getRepository('apiManagerApiKeys').findOne({ filter: { name: 'once-key' } });
    expect(row).toBeTruthy();
    expect(row?.get('keyHash')).toBe(hashApiKey(String(body.apiKey)));
    expect(String(row?.get('keyHash'))).not.toContain(String(body.apiKey));
  });

  it('create requires a name', async () => {
    const res = await agent.resource('apiManagerApiKeys').create({ values: { scopes: ['inbound'] } });
    expect(res.status).toBe(400);
  });

  it('create rejects an unknown partnerId', async () => {
    const res = await agent.resource('apiManagerApiKeys').create({
      values: { name: 'bad-partner-key', scopes: ['inbound'], partnerId: 999999 },
    });
    expect(res.status).toBe(400);
    expect(errorMessage(res)).toMatch(/does not reference an existing partner/);
  });

  it('create accepts an existing partnerId', async () => {
    const partner = await app.db.getRepository('apiPartners').create({ values: { name: 'key-test-partner' } });
    const res = await agent.resource('apiManagerApiKeys').create({
      values: { name: 'good-partner-key', scopes: ['inbound'], partnerId: partner.get('id') },
    });
    expect(res.status).toBe(200);
    expect(unwrap(res).partnerId).toBe(Number(partner.get('id')));
  });

  it('create rejects malformed scopes', async () => {
    for (const scopes of [['admin'], ['inbound:'], ['inbound:bad name'], ['outbound:*'], []]) {
      const res = await agent.resource('apiManagerApiKeys').create({
        values: { name: `bad-scope-${JSON.stringify(scopes)}`, scopes, partnerId },
      });
      expect(res.status).toBe(400);
    }
  });

  it('create accepts route-scoped scopes', async () => {
    const res = await agent.resource('apiManagerApiKeys').create({
      values: { name: 'scoped-key', scopes: ['inbound:partner-a', 'outbound:sync_orders.v2'], partnerId },
    });
    expect(res.status).toBe(200);
    expect(unwrap(res).scopes).toEqual(['inbound:partner-a', 'outbound:sync_orders.v2']);
  });

  it('list never exposes keyHash', async () => {
    await createTestApiKey(app, { name: 'listed-key', scopes: ['outbound'] });
    const res = await agent.resource('apiManagerApiKeys').list({ paginate: false });
    expect(res.status).toBe(200);
    const rows = extractRows(res);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.keyHash).toBeUndefined();
    }
  });

  it('get never exposes keyHash', async () => {
    await createTestApiKey(app, { name: 'get-key', scopes: ['inbound'] });
    const row = await app.db.getRepository('apiManagerApiKeys').findOne({ filter: { name: 'get-key' } });
    const res = await agent.resource('apiManagerApiKeys').get({ filterByTk: row?.get('id') });
    expect(res.status).toBe(200);
    const body = unwrap(res);
    expect(body.keyHash).toBeUndefined();
    expect(body.name).toBe('get-key');
  });

  it('revoke disables the key and stamps revokedAt', async () => {
    await createTestApiKey(app, { name: 'revoke-me', scopes: ['inbound'] });
    const row = await app.db.getRepository('apiManagerApiKeys').findOne({ filter: { name: 'revoke-me' } });
    const id = row?.get('id');

    const res = await agent.resource('apiManagerApiKeys').revoke({ filterByTk: id });
    expect(res.status).toBe(200);

    const updated = await app.db.getRepository('apiManagerApiKeys').findOne({ filterByTk: id });
    expect(updated?.get('enabled')).toBe(false);
    expect(updated?.get('revokedAt')).toBeTruthy();
  });

  it('revoke returns 404 for a missing key', async () => {
    const res = await agent.resource('apiManagerApiKeys').revoke({ filterByTk: 999999 });
    expect(res.status).toBe(404);
  });

  describe('authMode / no-role keys', () => {
    it('create ignores a roleName field (keys are not role-bound)', async () => {
      const res = await agent.resource('apiManagerApiKeys').create({
        values: { name: 'ignored-role-key', scopes: ['outbound'], roleName: 'admin', partnerId },
      });
      expect(res.status).toBe(200);
      expect(unwrap(res).roleName).toBeUndefined();
    });

    it('create leaves roleName undefined for a plain key', async () => {
      const res = await agent.resource('apiManagerApiKeys').create({
        values: { name: 'plain-key-create', scopes: ['outbound'], partnerId },
      });
      expect(res.status).toBe(200);
      expect(unwrap(res).roleName).toBeUndefined();
    });
  });
});
