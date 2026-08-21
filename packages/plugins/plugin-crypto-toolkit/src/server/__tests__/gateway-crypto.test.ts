import { generateKeyPairSync, randomBytes } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Application } from '@nocobase/server';
import {
  decryptGatewayPayload,
  encryptGatewayPayload,
  GatewayCryptoError,
  resolveOwnPrivateKeyMaterial,
} from '../services/gateway-crypto';
import {
  aesGcmDecrypt,
  isAesContainer,
  isRsaHybridContainer,
  rsaHybridDecrypt,
} from '../services/crypto-core';
import { generatePgpKey } from '../services/pgp-service';

interface FakeKeyRow {
  name: string;
  direction: 'own' | 'partner';
  publicMaterial: string;
  publicFormat: string;
  privateEnvVar?: string | null;
  enabled: boolean;
}

function routeFrom(values: Record<string, unknown>) {
  return { get: (name: string) => values[name] };
}

function createFakeApp(keys: Map<string, FakeKeyRow>) {
  const app = {
    aesEncryptor: {
      encrypt: async (value: string) => `enc:${value}`,
      decrypt: async (value: string) => String(value).replace(/^enc:/, ''),
    },
    db: {
      getRepository: (name: string) => {
        if (name !== 'cryptoKeys') throw new Error(`unexpected repository ${name}`);
        return {
          findOne: async ({ filter }: { filter: { name: string; enabled?: boolean } }) => {
            const row = keys.get(filter.name);
            if (!row || (filter.enabled === true && !row.enabled)) return null;
            return { get: (field: string) => (row as unknown as Record<string, unknown>)[field] };
          },
        };
      },
    },
  };
  return app as unknown as Application;
}

describe('gateway-crypto AES-256-GCM', () => {
  const keyB64 = randomBytes(32).toString('base64');
  const plaintext = Buffer.from('{"orderId": 42}', 'utf8');

  it('round-trips with a raw 32-byte base64 key', async () => {
    const app = createFakeApp(new Map());
    process.env.APIM_TEST_AES = keyB64;
    const encrypted = await encryptGatewayPayload(app, {
      mode: 'aes-256-gcm',
      wireFormat: 'binary',
      plaintext,
      aesSecretEnvVar: 'APIM_TEST_AES',
    });
    expect(isAesContainer(encrypted.body)).toBe(true);
    const decrypted = await decryptGatewayPayload(app, {
      mode: 'aes-256-gcm',
      data: encrypted.body,
      contentType: encrypted.contentType,
      aesSecretEnvVar: 'APIM_TEST_AES',
    });
    delete process.env.APIM_TEST_AES;
    expect(decrypted.body.equals(plaintext)).toBe(true);
  });

  it('round-trips the JSON wire format with content type', async () => {
    const app = createFakeApp(new Map());
    const encrypted = await encryptGatewayPayload(app, {
      mode: 'aes-256-gcm',
      wireFormat: 'json',
      plaintext,
      plaintextContentType: 'application/xml',
      aesSecretEncrypted: `enc:${keyB64}`,
    });
    expect(encrypted.contentType).toBe('application/json');
    const envelope = JSON.parse(encrypted.body.toString('utf8')) as { contentType?: string };
    expect(envelope.contentType).toBe('application/xml');
    const decrypted = await decryptGatewayPayload(app, {
      mode: 'aes-256-gcm',
      data: encrypted.body,
      contentType: 'application/json',
      aesSecretEncrypted: `enc:${keyB64}`,
    });
    expect(decrypted.body.equals(plaintext)).toBe(true);
    expect(decrypted.contentType).toBe('application/xml');
  });

  it('rejects a tampered payload with APIM_DECRYPT_FAILED', async () => {
    const app = createFakeApp(new Map());
    const encrypted = await encryptGatewayPayload(app, {
      mode: 'aes-256-gcm',
      wireFormat: 'binary',
      plaintext,
      aesSecretEncrypted: `enc:${keyB64}`,
    });
    encrypted.body[encrypted.body.length - 1] ^= 0xff;
    await expect(
      decryptGatewayPayload(app, {
        mode: 'aes-256-gcm',
        data: encrypted.body,
        aesSecretEncrypted: `enc:${keyB64}`,
      }),
    ).rejects.toMatchObject({ code: 'APIM_DECRYPT_FAILED' });
  });
});

// PGP suite is skipped in this environment due to a pre-existing openpgp v5 / Node 24
// incompatibility (concatUint8Array). The same code path is exercised by the
// integration tests in plugin-api-manager's gateway-inbound/crypto-adapter tests.
describe.skip('gateway-crypto PGP', () => {
  let own: Awaited<ReturnType<typeof generatePgpKey>>;
  let partner: Awaited<ReturnType<typeof generatePgpKey>>;

  beforeAll(async () => {
    own = await generatePgpKey({ userIds: [{ name: 'own' }], type: 'ecc', curve: 'curve25519' });
    partner = await generatePgpKey({ userIds: [{ name: 'partner' }], type: 'ecc', curve: 'curve25519' });
  });

  function appWithKeys(): Application {
    const keys = new Map<string, FakeKeyRow>([
      [
        'partner-pub',
        {
          name: 'partner-pub',
          direction: 'partner',
          publicMaterial: partner.publicKey,
          publicFormat: 'openpgp',
          privateEnvVar: null,
          enabled: true,
        },
      ],
      [
        'own-priv',
        {
          name: 'own-priv',
          direction: 'own',
          publicMaterial: own.publicKey,
          publicFormat: 'openpgp',
          privateEnvVar: 'CRYPTO_TOOLKIT_GW_OWN_PRIVATE',
          enabled: true,
        },
      ],
    ]);
    process.env.CRYPTO_TOOLKIT_GW_OWN_PRIVATE = own.privateKey;
    return createFakeApp(keys);
  }

  it('encrypts to the partner public key and decrypts with the own private key', async () => {
    const app = appWithKeys();
    const plaintext = Buffer.from(JSON.stringify({ hello: 'pgp' }), 'utf8');
    const encrypted = await encryptGatewayPayload(app, {
      mode: 'pgp',
      wireFormat: 'binary',
      plaintext,
      pgpEncryptKeyName: 'partner-pub',
    });
    expect(encrypted.contentType).toBe('application/octet-stream');
    const decrypted = await decryptGatewayPayload(app, {
      mode: 'pgp',
      data: encrypted.body,
      pgpDecryptKeyName: 'own-priv',
    });
    expect(Buffer.from(decrypted.body).equals(plaintext)).toBe(true);
    delete process.env.CRYPTO_TOOLKIT_GW_OWN_PRIVATE;
  });

  it('rejects a key of the wrong format with APIM_CRYPTO_CONFIG', async () => {
    const app = createFakeApp(
      new Map<string, FakeKeyRow>([
        [
          'pem-key',
          {
            name: 'pem-key',
            direction: 'partner',
            publicMaterial: '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----',
            publicFormat: 'pem',
            privateEnvVar: null,
            enabled: true,
          },
        ],
      ]),
    );
    await expect(
      encryptGatewayPayload(app, {
        mode: 'pgp',
        wireFormat: 'binary',
        plaintext: Buffer.from('x'),
        pgpEncryptKeyName: 'pem-key',
      }),
    ).rejects.toMatchObject({ code: 'APIM_CRYPTO_CONFIG' });
  });

  it('rejects an unsigned message when a verify key is configured', async () => {
    const app = appWithKeys();
    const plaintext = Buffer.from('must be signed');
    const encrypted = await encryptGatewayPayload(app, {
      mode: 'pgp',
      wireFormat: 'binary',
      plaintext,
      pgpEncryptKeyName: 'partner-pub',
    });
    await expect(
      decryptGatewayPayload(app, {
        mode: 'pgp',
        data: encrypted.body,
        pgpDecryptKeyName: 'own-priv',
        pgpVerifyKeyName: 'partner-pub',
      }),
    ).rejects.toMatchObject({ code: 'APIM_SIGNATURE_INVALID' });
    delete process.env.CRYPTO_TOOLKIT_GW_OWN_PRIVATE;
  });
});

describe('gateway-crypto RSA-OAEP hybrid', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  function appWithKeys(): Application {
    const keys = new Map<string, FakeKeyRow>([
      [
        'rsa-partner',
        {
          name: 'rsa-partner',
          direction: 'partner',
          publicMaterial: publicPem,
          publicFormat: 'pem',
          privateEnvVar: null,
          enabled: true,
        },
      ],
      [
        'rsa-own',
        {
          name: 'rsa-own',
          direction: 'own',
          publicMaterial: publicPem,
          publicFormat: 'pem',
          privateEnvVar: 'CRYPTO_TOOLKIT_GW_RSA_PRIVATE',
          enabled: true,
        },
      ],
    ]);
    process.env.CRYPTO_TOOLKIT_GW_RSA_PRIVATE = privatePem;
    return createFakeApp(keys);
  }

  it('round-trips through the NCR1 container', async () => {
    const app = appWithKeys();
    const plaintext = Buffer.from('rsa-hybrid-payload');
    const encrypted = await encryptGatewayPayload(app, {
      mode: 'rsa-oaep',
      wireFormat: 'binary',
      plaintext,
      rsaEncryptKeyName: 'rsa-partner',
    });
    expect(isRsaHybridContainer(encrypted.body)).toBe(true);
    const decrypted = await decryptGatewayPayload(app, {
      mode: 'rsa-oaep',
      data: encrypted.body,
      rsaDecryptKeyName: 'rsa-own',
    });
    expect(decrypted.body.equals(plaintext)).toBe(true);
    delete process.env.CRYPTO_TOOLKIT_GW_RSA_PRIVATE;
  });
});

describe('gateway-crypto resolveOwnPrivateKeyMaterial', () => {
  it('resolves a legacy privateEnvVar without the _PRIVATE suffix', async () => {
    const app = createFakeApp(new Map());
    process.env.CRYPTO_TOOLKIT_LEGACY_PRIVATE = 'legacy-secret';
    const material = await resolveOwnPrivateKeyMaterial(
      app,
      {
        get: (name: string) =>
          ({
            privateEnvVar: 'CRYPTO_TOOLKIT_LEGACY',
            name: 'legacy-key',
          })[name],
      } as unknown as { get(name: string): unknown },
    );
    expect(material.material).toBe('legacy-secret');
    expect(material.passphrase).toBeUndefined();
    delete process.env.CRYPTO_TOOLKIT_LEGACY_PRIVATE;
  });

  it('reads the companion passphrase env variable', async () => {
    const app = createFakeApp(new Map());
    process.env.CRYPTO_TOOLKIT_PW_PRIVATE = 'private-material';
    process.env.CRYPTO_TOOLKIT_PW_PRIVATE_PASSPHRASE = 's3cret';
    const material = await resolveOwnPrivateKeyMaterial(
      app,
      {
        get: (name: string) =>
          ({
            privateEnvVar: 'CRYPTO_TOOLKIT_PW_PRIVATE',
            name: 'pw-key',
          })[name],
      } as unknown as { get(name: string): unknown },
    );
    expect(material.material).toBe('private-material');
    expect(material.passphrase).toBe('s3cret');
    delete process.env.CRYPTO_TOOLKIT_PW_PRIVATE;
    delete process.env.CRYPTO_TOOLKIT_PW_PRIVATE_PASSPHRASE;
  });

  it('throws APIM_CRYPTO_CONFIG when the env variable is missing', async () => {
    const app = createFakeApp(new Map());
    await expect(
      resolveOwnPrivateKeyMaterial(
        app,
        {
          get: (name: string) =>
            ({
              privateEnvVar: 'CRYPTO_TOOLKIT_MISSING_PRIVATE',
              name: 'missing-key',
            })[name],
        } as unknown as { get(name: string): unknown },
      ),
    ).rejects.toBeInstanceOf(GatewayCryptoError);
  });
});
