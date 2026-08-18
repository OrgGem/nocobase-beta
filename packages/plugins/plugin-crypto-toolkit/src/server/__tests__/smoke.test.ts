import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'crypto';
import { createMockServer } from '@nocobase/test';
import { readAttachmentBuffer } from '../services/attachment-helper';

// Responses from custom resource actions are wrapped by the data-wrapping
// middleware into `{ data: ... }`; tolerate both shapes to stay robust.
function unwrap(res: { body: unknown }): Record<string, any> {
  const body = res.body as Record<string, any> | undefined;
  if (body && typeof body === 'object' && 'data' in body && body.data && typeof body.data === 'object') {
    return body.data as Record<string, any>;
  }
  return (body ?? {}) as Record<string, any>;
}

// The encrypt/decrypt resource actions move payloads through file-manager
// attachments. In some test environments file-manager fails to load (vite-node
// cannot resolve the @aws-sdk -> @smithy/core/serde subpath chain), so skip the
// attachment-based round-trips there; algorithm-level coverage lives in the
// crypto-core and pgp-service unit tests.
let fileManagerLoaded = false;

function requireFileManager(ctx: { skip: () => void }): void {
  if (!fileManagerLoaded) {
    console.warn('skipping: file-manager plugin is not loaded in this environment');
    ctx.skip();
  }
}

describe('plugin-crypto-toolkit', () => {
  let app: Awaited<ReturnType<typeof createMockServer>>;
  let agent: ReturnType<Awaited<ReturnType<typeof createMockServer>>['agent']>;
  let userId: number;

  beforeAll(async () => {
    process.env.INIT_ROOT_EMAIL = 'crypto-test@nocobase.com';
    process.env.INIT_ROOT_PASSWORD = '123456';
    process.env.INIT_ROOT_NICKNAME = 'Crypto Test';
    app = await createMockServer({
      plugins: ['nocobase', 'file-manager', 'plugin-crypto-toolkit'],
    });
    const user = await app.db.getRepository('users').findOne({ filter: { email: process.env.INIT_ROOT_EMAIL } });
    expect(user).toBeTruthy();
    userId = user.get('id') as number;
    agent = await app.agent().login(user);
    fileManagerLoaded = Boolean(app.pm.get('file-manager'));
  }, 300000);

  afterAll(async () => {
    await app?.destroy();
  });

  it('boots and registers collections', async () => {
    expect(app.db.getCollection('cryptoKeys')).toBeTruthy();
    expect(app.db.getCollection('cryptoOperations')).toBeTruthy();
  });

  it('registers ACL snippet', async () => {
    const snippets = (
      app.acl as unknown as { snippetManager?: { snippets?: Map<string, { name: string; actions: string[] }> } }
    ).snippetManager?.snippets;
    const snippet = snippets?.get('pm.plugin-crypto-toolkit');
    expect(snippet).toBeDefined();
    expect(snippet?.actions).toEqual(expect.arrayContaining(['cryptoKeys:*', 'crypto:*']));
  });

  it('cryptoKeys:generate stores the row, returns private material once, and creates env vars', async () => {
    const generated = await agent.resource('cryptoKeys').generate({
      values: {
        name: 'gen-ed-test',
        kind: 'ed25519',
        saveToEnv: true,
        envVarName: 'GEN_ED',
        direction: 'own',
        purpose: 'both',
      },
    });
    expect(generated.status).toBe(200);
    const body = unwrap(generated);
    expect(body.ok).toBe(true);
    expect(body.key.name).toBe('gen-ed-test');
    expect(body.privateMaterial).toMatch(/-----BEGIN PRIVATE KEY-----/);
    expect(body.savedToEnv).toBe(true);

    // Both halves exist as environment variables; the private one is a secret.
    const envRepo = app.db.getRepository('environmentVariables');
    const priv = await envRepo.findOne({ filter: { name: body.envVarName } });
    expect(priv).toBeTruthy();
    expect(String(priv?.get('type'))).toBe('secret');

    // The persisted row references the private env var, not the material itself.
    const row = await app.db.getRepository('cryptoKeys').findOne({ filter: { name: 'gen-ed-test' } });
    expect(row).toBeTruthy();
    expect(String(row?.get('privateEnvVar'))).toBe(body.envVarName);
  });

  it('cryptoKeys:importKey refuses to store private material', async () => {
    const privPem = `-----BEGIN PRIVATE KEY-----
MFICAQEwBQYDK2VwBCIEIH6sXkpDlNV9t9JKEzG2GTHITj1JcDgRGJrtBmkRTkWh
g6Be3SP+TCEhAy+Rw7mKAfCvbSUBAfpx6u6tFk5QYRo=
-----END PRIVATE KEY-----`;
    const response = await agent.resource('cryptoKeys').importKey({
      values: {
        name: 'bad-import',
        direction: 'partner',
        purpose: 'both',
        key: { mode: 'text', text: privPem },
      },
    });
    expect(response.status).toBe(400);
  });

  describe('crypto:encrypt + crypto:decrypt (AES-256-GCM)', () => {
    it('round-trips a text payload with a passphrase secret', async (ctx) => {
      requireFileManager(ctx);
      const plaintext = 'confidential invoice — AES round trip éèỳ';
      const encryptRes = await agent.resource('crypto').encrypt({
        values: {
          algorithm: 'aes-256-gcm',
          payload: { mode: 'text', text: plaintext },
          secret: { passphrase: 'correct horse battery staple' },
        },
      });
      expect(encryptRes.status).toBe(200);
      const enc = unwrap(encryptRes);
      expect(enc.ok).toBe(true);
      expect(enc.algorithm).toBe('aes-256-gcm');
      expect(Number.isInteger(enc.attachmentId)).toBe(true);

      const decryptRes = await agent.resource('crypto').decrypt({
        values: {
          algorithm: 'aes-256-gcm',
          payload: { mode: 'attachment', attachmentId: enc.attachmentId },
          secret: { passphrase: 'correct horse battery staple' },
        },
      });
      expect(decryptRes.status).toBe(200);
      const dec = unwrap(decryptRes);
      expect(dec.ok).toBe(true);

      const { buffer } = await readAttachmentBuffer(app, dec.attachmentId, { ownerId: userId });
      expect(buffer.toString('utf8')).toBe(plaintext);
    });

    it('round-trips with a raw base64 32-byte key', async (ctx) => {
      requireFileManager(ctx);
      const keyB64 = randomBytes(32).toString('base64');
      const plaintext = 'raw key payload';
      const encryptRes = await agent.resource('crypto').encrypt({
        values: {
          algorithm: 'aes-256-gcm',
          payload: { mode: 'text', text: plaintext },
          secret: { key: keyB64 },
        },
      });
      const enc = unwrap(encryptRes);
      expect(encryptRes.status).toBe(200);

      const decryptRes = await agent.resource('crypto').decrypt({
        values: {
          algorithm: 'aes-256-gcm',
          payload: { mode: 'attachment', attachmentId: enc.attachmentId },
          secret: { key: keyB64 },
        },
      });
      const dec = unwrap(decryptRes);
      expect(decryptRes.status).toBe(200);
      const { buffer } = await readAttachmentBuffer(app, dec.attachmentId, { ownerId: userId });
      expect(buffer.toString('utf8')).toBe(plaintext);
    });

    it('fails to decrypt with the wrong passphrase', async (ctx) => {
      requireFileManager(ctx);
      const encryptRes = await agent.resource('crypto').encrypt({
        values: {
          algorithm: 'aes-256-gcm',
          payload: { mode: 'text', text: 'secret' },
          secret: { passphrase: 'right-pass' },
        },
      });
      const enc = unwrap(encryptRes);
      const decryptRes = await agent.resource('crypto').decrypt({
        values: {
          algorithm: 'aes-256-gcm',
          payload: { mode: 'attachment', attachmentId: enc.attachmentId },
          secret: { passphrase: 'wrong-pass' },
        },
      });
      expect(decryptRes.status).not.toBe(200);
    });
  });

  describe('crypto:encrypt + crypto:decrypt (PGP)', () => {
    it('round-trips a text payload using a generated own key', async (ctx) => {
      requireFileManager(ctx);
      const generated = await agent.resource('cryptoKeys').generate({
        values: {
          name: 'pgp-roundtrip',
          kind: 'pgp-curve25519',
          direction: 'own',
          purpose: 'both',
          saveToEnv: true,
          envVarName: 'PGP_RT',
        },
      });
      expect(generated.status).toBe(200);
      const gen = unwrap(generated);
      const keyId = gen.key.id;
      const privateEnvVar = gen.envVarName;
      expect(keyId).toBeTruthy();
      expect(privateEnvVar).toMatch(/_PRIVATE$/);

      const plaintext = 'PGP confidential payload — round trip';
      const encryptRes = await agent.resource('crypto').encrypt({
        values: {
          algorithm: 'pgp',
          payload: { mode: 'text', text: plaintext },
          recipientKeyIds: [keyId],
        },
      });
      expect(encryptRes.status).toBe(200);
      const enc = unwrap(encryptRes);
      expect(enc.ok).toBe(true);
      expect(enc.algorithm).toBe('pgp');

      const decryptRes = await agent.resource('crypto').decrypt({
        values: {
          algorithm: 'pgp',
          payload: { mode: 'attachment', attachmentId: enc.attachmentId },
          privateEnvVar,
        },
      });
      expect(decryptRes.status).toBe(200);
      const dec = unwrap(decryptRes);
      expect(dec.ok).toBe(true);

      const { buffer } = await readAttachmentBuffer(app, dec.attachmentId, { ownerId: userId });
      expect(buffer.toString('utf8')).toBe(plaintext);
    }, 120000);
  });
});
