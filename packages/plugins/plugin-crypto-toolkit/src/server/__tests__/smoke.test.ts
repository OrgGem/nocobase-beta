import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'crypto';
import { createMockServer } from '@nocobase/test';
import { readAttachmentBuffer } from '../services/attachment-helper';
import { generateRawKeyPair } from '../services/crypto-core';
import { createSelfSigned } from '../services/cert-service';

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

  it('cryptoKeys:generate creates a PGP key (regression: dynamic openpgp import interop)', async () => {
    const generated = await agent.resource('cryptoKeys').generate({
      values: {
        name: 'gen-pgp-test',
        kind: 'pgp-curve25519',
        direction: 'own',
        purpose: 'both',
      },
    });
    expect(generated.status).toBe(200);
    const body = unwrap(generated);
    expect(body.ok).toBe(true);
    expect(body.key.fingerprint).toMatch(/^[0-9A-F]{40}$/);
    expect(body.privateMaterial).toContain('-----BEGIN PGP PRIVATE KEY BLOCK-----');
    expect(body.publicMaterial).toContain('-----BEGIN PGP PUBLIC KEY BLOCK-----');
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
      expect(decryptRes.status).toBe(400);
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

  it('crypto:checksum computes sha-256 over a text payload', async () => {
    const res = await agent.resource('crypto').checksum({
      values: { algorithm: 'sha-256', payload: { mode: 'text', text: 'checksum me' } },
    });
    expect(res.status).toBe(200);
    const body = unwrap(res);
    expect(body.ok).toBe(true);
    expect(body.value).toBe(createHash('sha256').update('checksum me', 'utf8').digest('hex'));
    expect(body.size).toBe(Buffer.byteLength('checksum me'));
  });

  // These guards must fire with clean 400s regardless of file-manager availability.
  describe('format guards (no file-manager needed)', () => {
    it('crypto:verify rejects an OpenPGP key row for non-PGP algorithms with 400', async () => {
      const generated = await agent.resource('cryptoKeys').generate({
        values: { name: 'guard-pgp-key', kind: 'pgp-curve25519', direction: 'own', purpose: 'both' },
      });
      expect(generated.status).toBe(200);
      const keyId = unwrap(generated).key.id;

      const res = await agent.resource('crypto').verify({
        values: {
          algorithm: 'ed25519',
          payload: { mode: 'text', text: 'payload' },
          signature: { mode: 'text', text: 'not-a-real-signature' },
          verifyKeyId: keyId,
        },
      });
      expect(res.status).toBe(400);
    });

    it('crypto:encrypt rejects a non-OpenPGP recipient with 400', async () => {
      const generated = await agent.resource('cryptoKeys').generate({
        values: { name: 'guard-pem-key', kind: 'ed25519', direction: 'own', purpose: 'both' },
      });
      expect(generated.status).toBe(200);
      const keyId = unwrap(generated).key.id;

      const res = await agent.resource('crypto').encrypt({
        values: {
          algorithm: 'pgp',
          payload: { mode: 'text', text: 'payload' },
          recipientKeyIds: [keyId],
        },
      });
      expect(res.status).toBe(400);
    });

    it('crypto:createCsr rejects a PGP private key with 400', async () => {
      const generated = await agent.resource('cryptoKeys').generate({
        values: {
          name: 'guard-csr-pgp',
          kind: 'pgp-curve25519',
          direction: 'own',
          purpose: 'both',
          saveToEnv: true,
          envVarName: 'GUARD_CSR_PGP',
        },
      });
      expect(generated.status).toBe(200);
      const envVarName = unwrap(generated).envVarName;

      const res = await agent.resource('crypto').createCsr({
        values: { privateEnvVar: envVarName, subject: { commonName: 'guard-test' } },
      });
      expect(res.status).toBe(400);
    });

    it('cryptoKeys:importKey rejects an X.509 certificate with 400', async () => {
      const { privatePem } = generateRawKeyPair('ed25519');
      const cert = await createSelfSigned({
        subject: { commonName: 'guard-cert' },
        privateKeyPem: privatePem,
        validDays: 1,
      });
      const res = await agent.resource('cryptoKeys').importKey({
        values: {
          name: 'guard-cert-import',
          direction: 'partner',
          purpose: 'both',
          key: { mode: 'text', text: cert.certPem },
        },
      });
      expect(res.status).toBe(400);
    });

    it('cryptoKeys:importKey rejects garbage PGP armor with 400', async () => {
      const res = await agent.resource('cryptoKeys').importKey({
        values: {
          name: 'guard-garbage-pgp',
          direction: 'partner',
          purpose: 'both',
          key: {
            mode: 'text',
            text: '-----BEGIN PGP PUBLIC KEY BLOCK-----\n\ngarbage\n-----END PGP PUBLIC KEY BLOCK-----',
          },
        },
      });
      expect(res.status).toBe(400);
    });
  });

  describe('validation error status codes (P0/P1 fixes)', () => {
    it('crypto:sign missing privateEnvVar returns 400 (not 500)', async () => {
      const res = await agent.resource('crypto').sign({
        values: {
          algorithm: 'ed25519',
          payload: { mode: 'text', text: 'x' },
        },
      });
      expect(res.status).toBe(400);
    });

    it('crypto:sign rejects an unknown algorithm with 400', async () => {
      const res = await agent.resource('crypto').sign({
        values: {
          algorithm: 'bogus-alg',
          payload: { mode: 'text', text: 'x' },
          privateEnvVar: 'CRYPTO_TOOLKIT_NOPE_PRIVATE',
        },
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/Unsupported algorithm/);
    });

    it('crypto:verify rejects an unknown algorithm with 400', async () => {
      const res = await agent.resource('crypto').verify({
        values: {
          algorithm: 'bogus-alg',
          verifyKeyId: 1,
          payload: { mode: 'text', text: 'x' },
          signature: { mode: 'text', text: 'y' },
        },
      });
      expect(res.status).toBe(400);
    });

    it('crypto:encrypt rejects an unknown algorithm with 400', async () => {
      const res = await agent.resource('crypto').encrypt({
        values: {
          algorithm: 'bogus-alg',
          payload: { mode: 'text', text: 'x' },
        },
      });
      expect(res.status).toBe(400);
    });
  });

  describe('crypto:sign + crypto:verify round-trips', () => {
    it('round-trips an ed25519 signature with an SSH-generated key (OpenSSH conversion)', async (ctx) => {
      requireFileManager(ctx);
      const generated = await agent.resource('cryptoKeys').generate({
        values: {
          name: 'ssh-sign-key',
          kind: 'ssh-ed25519',
          direction: 'own',
          purpose: 'both',
          saveToEnv: true,
          envVarName: 'SSH_SIGN',
        },
      });
      expect(generated.status).toBe(200);
      const gen = unwrap(generated);
      expect(gen.envVarName).toMatch(/_PRIVATE$/);

      const plaintext = 'ssh key signing payload';
      const signRes = await agent.resource('crypto').sign({
        values: {
          algorithm: 'ed25519',
          payload: { mode: 'text', text: plaintext },
          privateEnvVar: gen.envVarName,
        },
      });
      expect(signRes.status).toBe(200);
      const signed = unwrap(signRes);

      const verifyRes = await agent.resource('crypto').verify({
        values: {
          algorithm: 'ed25519',
          payload: { mode: 'text', text: plaintext },
          signature: { mode: 'attachment', attachmentId: signed.attachmentId },
          verifyKeyId: gen.key.id,
        },
      });
      expect(verifyRes.status).toBe(200);
      expect(unwrap(verifyRes).valid).toBe(true);
    }, 120000);

    it('round-trips a pgp-detached signature and detects tampering', async (ctx) => {
      requireFileManager(ctx);
      const generated = await agent.resource('cryptoKeys').generate({
        values: {
          name: 'pgp-sign-key',
          kind: 'pgp-curve25519',
          direction: 'own',
          purpose: 'both',
          saveToEnv: true,
          envVarName: 'PGP_SIGN',
        },
      });
      expect(generated.status).toBe(200);
      const gen = unwrap(generated);

      const plaintext = 'pgp detached signing payload';
      const signRes = await agent.resource('crypto').sign({
        values: {
          algorithm: 'pgp-detached',
          payload: { mode: 'text', text: plaintext },
          privateEnvVar: gen.envVarName,
        },
      });
      expect(signRes.status).toBe(200);
      const signed = unwrap(signRes);

      const verifyRes = await agent.resource('crypto').verify({
        values: {
          algorithm: 'pgp-detached',
          payload: { mode: 'text', text: plaintext },
          signature: { mode: 'attachment', attachmentId: signed.attachmentId },
          verifyKeyId: gen.key.id,
        },
      });
      expect(verifyRes.status).toBe(200);
      expect(unwrap(verifyRes).valid).toBe(true);

      const tampered = await agent.resource('crypto').verify({
        values: {
          algorithm: 'pgp-detached',
          payload: { mode: 'text', text: 'tampered payload' },
          signature: { mode: 'attachment', attachmentId: signed.attachmentId },
          verifyKeyId: gen.key.id,
        },
      });
      expect(tampered.status).toBe(200);
      expect(unwrap(tampered).valid).toBe(false);
    }, 120000);
  });
});
