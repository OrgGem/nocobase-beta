import { randomBytes } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MockServer } from '@nocobase/test';
import { APIM_ACL } from '../../constants';
import { createTestApp, createTestRoute, createRsaKeyFixture, loginAgent } from './helpers';

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

  it('grants apiRoutes:test via the plugin snippet, not to every logged-in user', () => {
    const acl = app.acl;
    const withSnippet = acl.define({ role: 'apim-with-snippet' });
    withSnippet.snippets.add(APIM_ACL);
    expect(acl.can({ role: 'apim-with-snippet', resource: 'apiRoutes', action: 'test' })).toBeTruthy();

    const withoutSnippet = acl.define({ role: 'apim-without-snippet' });
    expect(acl.can({ role: 'apim-without-snippet', resource: 'apiRoutes', action: 'test' })).toBeNull();
  });

  it('denies apiRoutes:test over HTTP for logged-in users without the snippet', async () => {
    const user = await app.db.getRepository('users').create({
      values: { email: 'no-snippet@apim.test', nickname: 'No Snippet' },
    });
    const plainAgent = await app.agent().login(user);
    const route = await createTestRoute(app, {
      name: 'smoke-acl-denied',
      direction: 'outbound',
      targetUrl: 'http://127.0.0.1:9/echo',
    });
    const res = await plainAgent.resource('apiRoutes').test({ filterByTk: route.get('id') });
    expect(res.status).toBe(403);
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

  it('clamps timeoutMs and retryDelayMs to allowed ranges', async () => {
    const route = await createTestRoute(app, {
      name: 'smoke-clamp-time',
      direction: 'outbound',
      targetUrl: 'http://127.0.0.1:9/echo',
      timeoutMs: 1,
      retryDelayMs: 999999,
    });
    const stored = await app.db.getRepository('apiRoutes').findOne({ filterByTk: route.get('id') });
    expect(Number(stored?.get('timeoutMs'))).toBe(100);
    expect(Number(stored?.get('retryDelayMs'))).toBe(60000);
  });

  it('rejects route names with characters outside [A-Za-z0-9._-]', async () => {
    const badNames = ['has space', 'with/slash', 'qu?ery', 'hash#tag', 'semi;colon', 'unicode-ä'];
    let index = 0;
    for (const bad of badNames) {
      index += 1;
      await expect(
        createTestRoute(app, {
          name: bad,
          direction: 'outbound',
          targetUrl: 'http://127.0.0.1:9/echo',
          description: `bad-name-${index}`,
        }),
      ).rejects.toThrow(/Route name/);
    }
  });

  it('rejects inboundPaths with unsafe segments or characters', async () => {
    const badPaths = ['/leading', 'has space', 'with?query', 'with#frag', 'a/../b', '..', 'a//b', 'a/./b'];
    let index = 0;
    for (const bad of badPaths) {
      index += 1;
      await expect(
        createTestRoute(app, {
          name: `smoke-in-bad-${index}`,
          direction: 'inbound',
          targetUrl: 'http://127.0.0.1:9/echo',
          inboundPath: bad,
        }),
      ).rejects.toThrow(/inboundPath/);
    }
  });

  it('allows nested inboundPaths', async () => {
    const route = await createTestRoute(app, {
      name: 'smoke-in-nested',
      direction: 'inbound',
      targetUrl: 'http://127.0.0.1:9/echo',
      inboundPath: 'partner/v1/webhook',
    });
    expect(route.get('inboundPath')).toBe('partner/v1/webhook');
  });

  it('rejects an inbound route without inboundPath', async () => {
    await expect(
      createTestRoute(app, {
        name: 'smoke-in-no-path',
        direction: 'inbound',
        targetUrl: 'http://127.0.0.1:9/echo',
        inboundPath: '',
      }),
    ).rejects.toThrow(/inboundPath is required/);
  });

  it('rejects a duplicate inboundPath among inbound routes', async () => {
    await createTestRoute(app, {
      name: 'smoke-in-first',
      direction: 'inbound',
      targetUrl: 'http://127.0.0.1:9/echo',
      inboundPath: 'dup-path',
    });
    await expect(
      createTestRoute(app, {
        name: 'smoke-in-second',
        direction: 'inbound',
        targetUrl: 'http://127.0.0.1:9/echo',
        inboundPath: 'dup-path',
      }),
    ).rejects.toThrow(/already used by inbound route/);
  });

  it('allows updating an inbound route without changing its inboundPath', async () => {
    const route = await createTestRoute(app, {
      name: 'smoke-in-update',
      direction: 'inbound',
      targetUrl: 'http://127.0.0.1:9/echo',
      inboundPath: 'update-path',
    });
    await app.db.getRepository('apiRoutes').update({
      filterByTk: route.get('id'),
      values: { description: 'updated' },
    });
    const stored = await app.db.getRepository('apiRoutes').findOne({ filterByTk: route.get('id') });
    expect(stored?.get('description')).toBe('updated');
    expect(stored?.get('inboundPath')).toBe('update-path');
  });

  it('rejects an AES route without a secret or env variable', async () => {
    await expect(
      createTestRoute(app, {
        name: 'smoke-aes-nosecret',
        direction: 'outbound',
        targetUrl: 'http://127.0.0.1:9/echo',
        encryptionMode: 'aes-256-gcm',
      }),
    ).rejects.toThrow(/aesSecret or aesSecretEnvVar/);
  });

  it('rejects a PGP route without encrypt and decrypt keys', async () => {
    await expect(
      createTestRoute(app, {
        name: 'smoke-pgp-nokeys',
        direction: 'outbound',
        targetUrl: 'http://127.0.0.1:9/echo',
        encryptionMode: 'pgp',
      }),
    ).rejects.toThrow(/pgpEncryptKeyName/);
  });

  it('defaults responseEncrypted to true', async () => {
    const route = await createTestRoute(app, {
      name: 'smoke-resp-default',
      direction: 'outbound',
      targetUrl: 'http://127.0.0.1:9/echo',
    });
    expect(route.get('responseEncrypted')).toBe(true);
  });

  it('rejects an outbound RSA route without an encrypt key', async () => {
    await expect(
      createTestRoute(app, {
        name: 'smoke-rsa-nokeys',
        direction: 'outbound',
        targetUrl: 'http://127.0.0.1:9/echo',
        encryptionMode: 'rsa-oaep',
      }),
    ).rejects.toThrow(/rsaEncryptKeyName/);
  });

  it('rejects an outbound RSA route with encrypted responses but no decrypt key', async () => {
    const partner = await createRsaKeyFixture(app, { name: 'rsa-val-partner', direction: 'partner' });
    await expect(
      createTestRoute(app, {
        name: 'smoke-rsa-nodecrypt',
        direction: 'outbound',
        targetUrl: 'http://127.0.0.1:9/echo',
        encryptionMode: 'rsa-oaep',
        rsaEncryptKeyName: partner.keyName,
        responseEncrypted: true,
      }),
    ).rejects.toThrow(/rsaDecryptKeyName/);
  });

  it('allows an outbound RSA route without a decrypt key when responses are plaintext', async () => {
    const partner = await createRsaKeyFixture(app, { name: 'rsa-val-plain', direction: 'partner' });
    const route = await createTestRoute(app, {
      name: 'smoke-rsa-plain-resp',
      direction: 'outbound',
      targetUrl: 'http://127.0.0.1:9/echo',
      encryptionMode: 'rsa-oaep',
      rsaEncryptKeyName: partner.keyName,
      responseEncrypted: false,
    });
    const stored = await app.db.getRepository('apiRoutes').findOne({ filterByTk: route.get('id') });
    expect(stored?.get('rsaDecryptKeyName')).toBeNull();
  });

  it('rejects an inbound RSA route without a decrypt key', async () => {
    await expect(
      createTestRoute(app, {
        name: 'smoke-rsa-in-nodecrypt',
        direction: 'inbound',
        targetUrl: 'http://127.0.0.1:9/echo',
        inboundPath: 'rsa-in-nokey',
        encryptionMode: 'rsa-oaep',
      }),
    ).rejects.toThrow(/rsaDecryptKeyName/);
  });

  it('clears stale RSA key names when encryptionMode switches away from rsa-oaep', async () => {
    const partner = await createRsaKeyFixture(app, { name: 'rsa-val-stale', direction: 'partner' });
    const route = await createTestRoute(app, {
      name: 'smoke-rsa-stale',
      direction: 'outbound',
      targetUrl: 'http://127.0.0.1:9/echo',
      encryptionMode: 'rsa-oaep',
      rsaEncryptKeyName: partner.keyName,
      responseEncrypted: false,
    });
    await app.db.getRepository('apiRoutes').update({
      filterByTk: route.get('id'),
      values: { encryptionMode: 'none' },
    });
    const stored = await app.db.getRepository('apiRoutes').findOne({ filterByTk: route.get('id') });
    expect(stored?.get('rsaEncryptKeyName')).toBeNull();
  });

  it('clears stale aesSecret when encryptionMode switches away from aes-256-gcm', async () => {
    const route = await createTestRoute(app, {
      name: 'smoke-stale-secret',
      direction: 'outbound',
      targetUrl: 'http://127.0.0.1:9/echo',
      encryptionMode: 'aes-256-gcm',
      aesSecret: `stale-${randomBytes(8).toString('hex')}`,
    });
    await app.db.getRepository('apiRoutes').update({
      filterByTk: route.get('id'),
      values: { encryptionMode: 'none' },
    });
    const stored = await app.db.getRepository('apiRoutes').findOne({ filterByTk: route.get('id') });
    expect(stored?.get('aesSecret')).toBeNull();
  });
});
