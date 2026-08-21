import { generateKeyPairSync, randomBytes } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Application } from '@nocobase/server';
import { ERROR_CODES } from '../../constants';
import { decryptPayload, encryptPayload } from '../services/crypto-adapter';
import {
  aesGcmDecrypt,
  isAesContainer,
  isRsaHybridContainer,
  rsaHybridDecrypt,
  rsaHybridEncrypt,
} from '../../../../plugin-crypto-toolkit/src/server/services/crypto-core';
import { ApimError } from '../services/errors';
import {
  decryptGatewayPayload,
  encryptGatewayPayload,
  resolveAesSecret,
  resolveOwnPrivateKeyMaterial,
  type GatewayDecryptOptions,
  type GatewayEncryptOptions,
} from '../../../../plugin-crypto-toolkit/src/server/services/gateway-crypto';
import { generatePgpKey } from '../../../../plugin-crypto-toolkit/src/server/services/pgp-service';

interface FakeKeyRow {
  name: string;
  direction: 'own' | 'partner';
  publicMaterial: string;
  publicFormat?: string;
  privateEnvVar?: string | null;
  enabled: boolean;
}

function routeFrom(values: Record<string, unknown>) {
  return { get: (name: string) => values[name] };
}

function createFakeApp() {
  const keys = new Map<string, FakeKeyRow>();
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
  // The real gateway-crypto service functions are bound to the fake app so
  // crypto-adapter exercises the actual toolkit implementation through pm.get.
  const toolkit = {
    encryptPayload: (options: GatewayEncryptOptions) => encryptGatewayPayload(app as unknown as Application, options),
    decryptPayload: (options: GatewayDecryptOptions) => decryptGatewayPayload(app as unknown as Application, options),
    resolveAesSecret: (route: { get(name: string): unknown }) => resolveAesSecret(app as unknown as Application, route),
    resolveOwnPrivateKeyMaterial: (keyRecord: { get(name: string): unknown }) =>
      resolveOwnPrivateKeyMaterial(app as unknown as Application, keyRecord as never),
    getEnvVal: (name: string) => process.env[name],
  };
  const appWithPm = {
    ...app,
    pm: { get: (name: string) => (name === 'crypto-toolkit' ? toolkit : undefined) },
  };
  return { app: appWithPm as unknown as Application, keys };
}

describe('crypto-adapter (AES-256-GCM)', () => {
  const keyB64 = randomBytes(32).toString('base64');
  const plaintext = Buffer.from('{"orderId": 42, "note": "éè"}', 'utf8');

  it('round-trips with a 32-byte base64 key', async () => {
    const { app } = createFakeApp();
    const route = routeFrom({ encryptionMode: 'aes-256-gcm', wireFormat: 'binary', aesSecret: `enc:${keyB64}` });
    const encrypted = await encryptPayload(app, route, plaintext);
    expect(isAesContainer(encrypted.body)).toBe(true);
    expect(encrypted.contentType).toBe('application/octet-stream');
    const decrypted = await decryptPayload(app, route, encrypted.body, encrypted.contentType);
    expect(decrypted.body.equals(plaintext)).toBe(true);
  });

  it('round-trips in passphrase mode', async () => {
    const { app } = createFakeApp();
    const route = routeFrom({
      encryptionMode: 'aes-256-gcm',
      wireFormat: 'binary',
      aesSecret: 'enc:correct horse battery staple',
    });
    const encrypted = await encryptPayload(app, route, plaintext);
    expect(isAesContainer(encrypted.body)).toBe(true);
    const decrypted = await decryptPayload(app, route, encrypted.body);
    expect(decrypted.body.equals(plaintext)).toBe(true);
  });

  it('round-trips the JSON wire format envelope', async () => {
    const { app } = createFakeApp();
    const route = routeFrom({ encryptionMode: 'aes-256-gcm', wireFormat: 'json', aesSecret: `enc:${keyB64}` });
    const encrypted = await encryptPayload(app, route, plaintext);
    expect(encrypted.contentType).toBe('application/json');
    const envelope = JSON.parse(encrypted.body.toString('utf8')) as {
      container: string;
      encoding: string;
      ciphertext: string;
    };
    expect(envelope.container).toBe('NCB1');
    expect(envelope.encoding).toBe('base64');
    expect(isAesContainer(Buffer.from(envelope.ciphertext, 'base64'))).toBe(true);
    const decrypted = await decryptPayload(app, route, encrypted.body, 'application/json');
    expect(decrypted.body.equals(plaintext)).toBe(true);
  });

  it('carries the plaintext content type through the JSON envelope', async () => {
    const { app } = createFakeApp();
    const route = routeFrom({ encryptionMode: 'aes-256-gcm', wireFormat: 'json', aesSecret: `enc:${keyB64}` });
    const encrypted = await encryptPayload(app, route, plaintext, 'application/xml');
    const envelope = JSON.parse(encrypted.body.toString('utf8')) as { contentType?: string };
    expect(envelope.contentType).toBe('application/xml');
    const decrypted = await decryptPayload(app, route, encrypted.body, 'application/json');
    expect(decrypted.body.equals(plaintext)).toBe(true);
    expect(decrypted.contentType).toBe('application/xml');
  });

  it('omits contentType from the envelope when the plaintext type is unknown', async () => {
    const { app } = createFakeApp();
    const route = routeFrom({ encryptionMode: 'aes-256-gcm', wireFormat: 'json', aesSecret: `enc:${keyB64}` });
    const encrypted = await encryptPayload(app, route, plaintext);
    const envelope = JSON.parse(encrypted.body.toString('utf8')) as { contentType?: string };
    expect(envelope.contentType).toBeUndefined();
    const decrypted = await decryptPayload(app, route, encrypted.body, 'application/json');
    expect(decrypted.contentType).toBeUndefined();
  });

  it('does not carry a content type in the binary wire format', async () => {
    const { app } = createFakeApp();
    const route = routeFrom({ encryptionMode: 'aes-256-gcm', wireFormat: 'binary', aesSecret: `enc:${keyB64}` });
    const encrypted = await encryptPayload(app, route, plaintext, 'application/xml');
    const decrypted = await decryptPayload(app, route, encrypted.body, encrypted.contentType);
    expect(decrypted.body.equals(plaintext)).toBe(true);
    expect(decrypted.contentType).toBeUndefined();
  });

  it('decrypts a JSON envelope even when the route wireFormat is binary', async () => {
    const { app } = createFakeApp();
    const route = routeFrom({ encryptionMode: 'aes-256-gcm', wireFormat: 'binary', aesSecret: `enc:${keyB64}` });
    const container = await encryptPayload(app, route, plaintext);
    const envelope = Buffer.from(
      JSON.stringify({ encoding: 'base64', ciphertext: container.body.toString('base64') }),
      'utf8',
    );
    const decrypted = await decryptPayload(app, route, envelope, 'application/json; charset=utf-8');
    expect(decrypted.body.equals(plaintext)).toBe(true);
  });

  it('decrypts raw binary even when the route wireFormat is json', async () => {
    const { app } = createFakeApp();
    const binaryRoute = routeFrom({ encryptionMode: 'aes-256-gcm', wireFormat: 'binary', aesSecret: `enc:${keyB64}` });
    const container = await encryptPayload(app, binaryRoute, plaintext);
    const jsonRoute = routeFrom({ encryptionMode: 'aes-256-gcm', wireFormat: 'json', aesSecret: `enc:${keyB64}` });
    const decrypted = await decryptPayload(app, jsonRoute, container.body, 'application/octet-stream');
    expect(decrypted.body.equals(plaintext)).toBe(true);
  });

  it('detects tampering', async () => {
    const { app } = createFakeApp();
    const route = routeFrom({ encryptionMode: 'aes-256-gcm', wireFormat: 'binary', aesSecret: `enc:${keyB64}` });
    const encrypted = await encryptPayload(app, route, plaintext);
    const tampered = Buffer.from(encrypted.body);
    tampered[tampered.length - 1] ^= 0x01;
    await expect(decryptPayload(app, route, tampered)).rejects.toThrow();
  });

  it('rejects the wrong key', async () => {
    const { app } = createFakeApp();
    const route = routeFrom({ encryptionMode: 'aes-256-gcm', wireFormat: 'binary', aesSecret: `enc:${keyB64}` });
    const encrypted = await encryptPayload(app, route, plaintext);
    const wrongRoute = routeFrom({
      encryptionMode: 'aes-256-gcm',
      wireFormat: 'binary',
      aesSecret: `enc:${randomBytes(32).toString('base64')}`,
    });
    await expect(decryptPayload(app, wrongRoute, encrypted.body)).rejects.toThrow();
  });

  it('prefers the env variable over the stored secret', async () => {
    const { app } = createFakeApp();
    process.env.APIM_ADAPTER_AES_ENV = keyB64;
    try {
      const route = routeFrom({
        encryptionMode: 'aes-256-gcm',
        wireFormat: 'binary',
        aesSecret: 'enc:some-other-passphrase',
        aesSecretEnvVar: 'APIM_ADAPTER_AES_ENV',
      });
      const encrypted = await encryptPayload(app, route, plaintext);
      // Decrypt directly with the raw key: proves the env var (key mode) was used,
      // not the stored passphrase.
      const decrypted = aesGcmDecrypt(encrypted.body, { key: Buffer.from(keyB64, 'base64') });
      expect(decrypted.equals(plaintext)).toBe(true);
    } finally {
      delete process.env.APIM_ADAPTER_AES_ENV;
    }
  });

  it('throws APIM_CRYPTO_CONFIG when no secret is configured', async () => {
    const { app } = createFakeApp();
    const route = routeFrom({ encryptionMode: 'aes-256-gcm', wireFormat: 'binary' });
    await expect(encryptPayload(app, route, plaintext)).rejects.toMatchObject({
      code: ERROR_CODES.CRYPTO_CONFIG,
    });
  });

  it('throws APIM_CRYPTO_CONFIG when the env variable is unset', async () => {
    const { app } = createFakeApp();
    const route = routeFrom({
      encryptionMode: 'aes-256-gcm',
      wireFormat: 'binary',
      aesSecretEnvVar: 'APIM_ADAPTER_MISSING_ENV',
    });
    await expect(encryptPayload(app, route, plaintext)).rejects.toMatchObject({
      code: ERROR_CODES.CRYPTO_CONFIG,
    });
  });

  it('passes plaintext through when encryptionMode is none', async () => {
    const { app } = createFakeApp();
    const route = routeFrom({ encryptionMode: 'none' });
    const encrypted = await encryptPayload(app, route, plaintext);
    expect(encrypted.body.equals(plaintext)).toBe(true);
    const decrypted = await decryptPayload(app, route, plaintext);
    expect(decrypted.body.equals(plaintext)).toBe(true);
  });
});

describe('crypto-adapter (PGP)', () => {
  let ownKey: Awaited<ReturnType<typeof generatePgpKey>>;
  let partnerKey: Awaited<ReturnType<typeof generatePgpKey>>;

  beforeAll(async () => {
    ownKey = await generatePgpKey({
      userIds: [{ name: 'Own', email: 'own@apim.test' }],
      type: 'ecc',
      curve: 'curve25519',
    });
    partnerKey = await generatePgpKey({
      userIds: [{ name: 'Partner', email: 'partner@apim.test' }],
      type: 'ecc',
      curve: 'curve25519',
    });
  }, 120000);

  afterAll(() => {
    delete process.env.APIM_PGP_OWN_PRIVATE;
    delete process.env.APIM_PGP_OWN_PRIVATE_PASSPHRASE;
  });

  function setupOwnKey(keys: Map<string, FakeKeyRow>) {
    process.env.APIM_PGP_OWN_PRIVATE = ownKey.privateKey;
    keys.set('own-main', {
      name: 'own-main',
      direction: 'own',
      publicMaterial: ownKey.publicKey,
      publicFormat: 'openpgp',
      privateEnvVar: 'APIM_PGP_OWN_PRIVATE',
      enabled: true,
    });
  }

  it('round-trips encrypt -> decrypt', async () => {
    const { app, keys } = createFakeApp();
    setupOwnKey(keys);
    const plaintext = Buffer.from('PGP confidential payload');
    const encryptRoute = routeFrom({ encryptionMode: 'pgp', wireFormat: 'binary', pgpEncryptKeyName: 'own-main' });
    const encrypted = await encryptPayload(app, encryptRoute, plaintext);
    expect(encrypted.body.length).toBeGreaterThan(0);
    expect(encrypted.contentType).toBe('application/octet-stream');

    const decryptRoute = routeFrom({ encryptionMode: 'pgp', wireFormat: 'binary', pgpDecryptKeyName: 'own-main' });
    const decrypted = await decryptPayload(app, decryptRoute, encrypted.body);
    expect(decrypted.body.equals(plaintext)).toBe(true);
  });

  it('verifies a valid signature', async () => {
    const { app, keys } = createFakeApp();
    setupOwnKey(keys);
    const plaintext = Buffer.from('signed payload');
    const encryptRoute = routeFrom({
      encryptionMode: 'pgp',
      wireFormat: 'binary',
      pgpEncryptKeyName: 'own-main',
      pgpSignKeyName: 'own-main',
    });
    const encrypted = await encryptPayload(app, encryptRoute, plaintext);

    const decryptRoute = routeFrom({
      encryptionMode: 'pgp',
      wireFormat: 'binary',
      pgpDecryptKeyName: 'own-main',
      pgpVerifyKeyName: 'own-main',
    });
    const decrypted = await decryptPayload(app, decryptRoute, encrypted.body);
    expect(decrypted.body.equals(plaintext)).toBe(true);
  });

  it('rejects when signature verification fails', async () => {
    const { app, keys } = createFakeApp();
    setupOwnKey(keys);
    keys.set('partner-main', {
      name: 'partner-main',
      direction: 'partner',
      publicMaterial: partnerKey.publicKey,
      publicFormat: 'openpgp',
      privateEnvVar: null,
      enabled: true,
    });
    const plaintext = Buffer.from('payload signed by own key');
    const encryptRoute = routeFrom({
      encryptionMode: 'pgp',
      wireFormat: 'binary',
      pgpEncryptKeyName: 'own-main',
      pgpSignKeyName: 'own-main',
    });
    const encrypted = await encryptPayload(app, encryptRoute, plaintext);

    // Verify against the partner key, which did NOT sign the message.
    const decryptRoute = routeFrom({
      encryptionMode: 'pgp',
      wireFormat: 'binary',
      pgpDecryptKeyName: 'own-main',
      pgpVerifyKeyName: 'partner-main',
    });
    await expect(decryptPayload(app, decryptRoute, encrypted.body)).rejects.toMatchObject({
      code: ERROR_CODES.SIGNATURE_INVALID,
    });
  });

  it('rejects an unsigned message when a verify key is configured', async () => {
    const { app, keys } = createFakeApp();
    setupOwnKey(keys);
    const plaintext = Buffer.from('encrypted but not signed');
    // Encrypt WITHOUT signing.
    const encryptRoute = routeFrom({ encryptionMode: 'pgp', wireFormat: 'binary', pgpEncryptKeyName: 'own-main' });
    const encrypted = await encryptPayload(app, encryptRoute, plaintext);

    // A configured verify key must require a valid signature, not merely
    // reject bad signatures — unsigned messages must be rejected too.
    const decryptRoute = routeFrom({
      encryptionMode: 'pgp',
      wireFormat: 'binary',
      pgpDecryptKeyName: 'own-main',
      pgpVerifyKeyName: 'own-main',
    });
    await expect(decryptPayload(app, decryptRoute, encrypted.body)).rejects.toMatchObject({
      code: ERROR_CODES.SIGNATURE_INVALID,
      message: 'PGP message is not signed',
    });
  });

  it('accepts an unsigned message when no verify key is configured', async () => {
    const { app, keys } = createFakeApp();
    setupOwnKey(keys);
    const plaintext = Buffer.from('unsigned is fine without verify key');
    const encryptRoute = routeFrom({ encryptionMode: 'pgp', wireFormat: 'binary', pgpEncryptKeyName: 'own-main' });
    const encrypted = await encryptPayload(app, encryptRoute, plaintext);
    const decryptRoute = routeFrom({ encryptionMode: 'pgp', wireFormat: 'binary', pgpDecryptKeyName: 'own-main' });
    const decrypted = await decryptPayload(app, decryptRoute, encrypted.body);
    expect(Buffer.from(decrypted.body).equals(plaintext)).toBe(true);
  });

  it('round-trips the JSON wire format', async () => {
    const { app, keys } = createFakeApp();
    setupOwnKey(keys);
    const plaintext = Buffer.from('pgp json wire');
    const encryptRoute = routeFrom({ encryptionMode: 'pgp', wireFormat: 'json', pgpEncryptKeyName: 'own-main' });
    const encrypted = await encryptPayload(app, encryptRoute, plaintext);
    expect(encrypted.contentType).toBe('application/json');
    const decryptRoute = routeFrom({ encryptionMode: 'pgp', wireFormat: 'json', pgpDecryptKeyName: 'own-main' });
    const decrypted = await decryptPayload(app, decryptRoute, encrypted.body, 'application/json');
    expect(decrypted.body.equals(plaintext)).toBe(true);
  });

  it('throws APIM_CRYPTO_CONFIG when the encrypt key is missing', async () => {
    const { app } = createFakeApp();
    const route = routeFrom({ encryptionMode: 'pgp', wireFormat: 'binary' });
    await expect(encryptPayload(app, route, Buffer.from('x'))).rejects.toMatchObject({
      code: ERROR_CODES.CRYPTO_CONFIG,
    });
  });

  it('throws APIM_CRYPTO_CONFIG when the key record is disabled', async () => {
    const { app, keys } = createFakeApp();
    keys.set('disabled-key', {
      name: 'disabled-key',
      direction: 'partner',
      publicMaterial: partnerKey.publicKey,
      privateEnvVar: null,
      enabled: false,
    });
    const route = routeFrom({ encryptionMode: 'pgp', wireFormat: 'binary', pgpEncryptKeyName: 'disabled-key' });
    await expect(encryptPayload(app, route, Buffer.from('x'))).rejects.toMatchObject({
      code: ERROR_CODES.CRYPTO_CONFIG,
    });
  });

  it('throws APIM_CRYPTO_CONFIG when the private env var is unset', async () => {
    const { app, keys } = createFakeApp();
    keys.set('own-noenv', {
      name: 'own-noenv',
      direction: 'own',
      publicMaterial: ownKey.publicKey,
      publicFormat: 'openpgp',
      privateEnvVar: 'APIM_PGP_UNSET_ENV_VAR',
      enabled: true,
    });
    const route = routeFrom({ encryptionMode: 'pgp', wireFormat: 'binary', pgpDecryptKeyName: 'own-noenv' });
    await expect(decryptPayload(app, route, Buffer.from('irrelevant'))).rejects.toMatchObject({
      code: ERROR_CODES.CRYPTO_CONFIG,
    });
  });

  it('throws ApimError instances', async () => {
    const { app } = createFakeApp();
    const route = routeFrom({ encryptionMode: 'pgp', wireFormat: 'binary' });
    try {
      await encryptPayload(app, route, Buffer.from('x'));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ApimError);
    }
  });
});

describe('crypto-adapter (RSA-OAEP hybrid)', () => {
  let partnerPublicPem: string;
  let partnerPrivatePem: string;
  let otherPrivatePem: string;

  beforeAll(() => {
    const partner = generateKeyPairSync('rsa', { modulusLength: 2048 });
    partnerPublicPem = partner.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    partnerPrivatePem = partner.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    otherPrivatePem = other.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  });

  afterAll(() => {
    delete process.env.APIM_RSA_PARTNER_PRIVATE;
    delete process.env.APIM_RSA_OTHER_PRIVATE;
  });

  // The decryptor row holds the private half of the partner pair so the
  // round-trip mirrors "encrypt to partner public, partner decrypts".
  function setupPartnerKeys(keys: Map<string, FakeKeyRow>, privatePem: string, envVar: string) {
    process.env[envVar] = privatePem;
    keys.set('rsa-partner', {
      name: 'rsa-partner',
      direction: 'partner',
      publicMaterial: partnerPublicPem,
      publicFormat: 'pem',
      enabled: true,
    });
    keys.set('rsa-decryptor', {
      name: 'rsa-decryptor',
      direction: 'own',
      publicMaterial: partnerPublicPem,
      privateEnvVar: envVar,
      publicFormat: 'pem',
      enabled: true,
    });
  }

  it('round-trips encrypt -> decrypt (binary wire)', async () => {
    const { app, keys } = createFakeApp();
    setupPartnerKeys(keys, partnerPrivatePem, 'APIM_RSA_PARTNER_PRIVATE');
    const plaintext = Buffer.from('RSA hybrid confidential payload');
    const encryptRoute = routeFrom({
      encryptionMode: 'rsa-oaep',
      wireFormat: 'binary',
      rsaEncryptKeyName: 'rsa-partner',
    });
    const encrypted = await encryptPayload(app, encryptRoute, plaintext);
    expect(isRsaHybridContainer(encrypted.body)).toBe(true);
    expect(encrypted.contentType).toBe('application/octet-stream');

    const decryptRoute = routeFrom({
      encryptionMode: 'rsa-oaep',
      wireFormat: 'binary',
      rsaDecryptKeyName: 'rsa-decryptor',
    });
    const decrypted = await decryptPayload(app, decryptRoute, encrypted.body);
    expect(decrypted.body.equals(plaintext)).toBe(true);
  });

  it('round-trips the JSON wire format envelope with the NCR1 label', async () => {
    const { app, keys } = createFakeApp();
    setupPartnerKeys(keys, partnerPrivatePem, 'APIM_RSA_PARTNER_PRIVATE');
    const plaintext = Buffer.from('rsa json wire');
    const encryptRoute = routeFrom({
      encryptionMode: 'rsa-oaep',
      wireFormat: 'json',
      rsaEncryptKeyName: 'rsa-partner',
    });
    const encrypted = await encryptPayload(app, encryptRoute, plaintext);
    expect(encrypted.contentType).toBe('application/json');
    const envelope = JSON.parse(encrypted.body.toString('utf8')) as {
      container: string;
      encoding: string;
      ciphertext: string;
    };
    expect(envelope.container).toBe('NCR1');
    expect(envelope.encoding).toBe('base64');
    expect(isRsaHybridContainer(Buffer.from(envelope.ciphertext, 'base64'))).toBe(true);

    const decryptRoute = routeFrom({
      encryptionMode: 'rsa-oaep',
      wireFormat: 'json',
      rsaDecryptKeyName: 'rsa-decryptor',
    });
    const decrypted = await decryptPayload(app, decryptRoute, encrypted.body, 'application/json');
    expect(decrypted.body.equals(plaintext)).toBe(true);
  });

  it('rejects the wrong private key', async () => {
    const { app, keys } = createFakeApp();
    setupPartnerKeys(keys, otherPrivatePem, 'APIM_RSA_OTHER_PRIVATE');
    const encryptRoute = routeFrom({
      encryptionMode: 'rsa-oaep',
      wireFormat: 'binary',
      rsaEncryptKeyName: 'rsa-partner',
    });
    const encrypted = await encryptPayload(app, encryptRoute, Buffer.from('x'));
    const decryptRoute = routeFrom({
      encryptionMode: 'rsa-oaep',
      wireFormat: 'binary',
      rsaDecryptKeyName: 'rsa-decryptor',
    });
    await expect(decryptPayload(app, decryptRoute, encrypted.body)).rejects.toMatchObject({
      code: ERROR_CODES.DECRYPT_FAILED,
    });
  });

  it('rejects a non-RSA key in the encrypt slot', async () => {
    const { app, keys } = createFakeApp();
    const ed = generateKeyPairSync('ed25519');
    keys.set('ed-key', {
      name: 'ed-key',
      direction: 'partner',
      publicMaterial: ed.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      privateEnvVar: null,
      enabled: true,
    });
    const route = routeFrom({ encryptionMode: 'rsa-oaep', wireFormat: 'binary', rsaEncryptKeyName: 'ed-key' });
    await expect(encryptPayload(app, route, Buffer.from('x'))).rejects.toMatchObject({
      code: ERROR_CODES.CRYPTO_CONFIG,
    });
  });

  it('throws APIM_CRYPTO_CONFIG when the encrypt key is missing', async () => {
    const { app } = createFakeApp();
    const route = routeFrom({ encryptionMode: 'rsa-oaep', wireFormat: 'binary' });
    await expect(encryptPayload(app, route, Buffer.from('x'))).rejects.toMatchObject({
      code: ERROR_CODES.CRYPTO_CONFIG,
    });
  });

  it('throws APIM_CRYPTO_CONFIG when the private env var is unset', async () => {
    const { app, keys } = createFakeApp();
    keys.set('rsa-noenv', {
      name: 'rsa-noenv',
      direction: 'own',
      publicMaterial: partnerPublicPem,
      privateEnvVar: 'APIM_RSA_UNSET_ENV_VAR',
      enabled: true,
    });
    const route = routeFrom({ encryptionMode: 'rsa-oaep', wireFormat: 'binary', rsaDecryptKeyName: 'rsa-noenv' });
    await expect(decryptPayload(app, route, Buffer.from('irrelevant'))).rejects.toMatchObject({
      code: ERROR_CODES.CRYPTO_CONFIG,
    });
  });

  it('supports a passphrase-protected private key (primitives)', () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const encryptedPem = privateKey
      .export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 's3cret' })
      .toString();
    const plaintext = Buffer.from('passphrase-protected key payload');
    const container = rsaHybridEncrypt(plaintext, publicPem);
    expect(() => rsaHybridDecrypt(container, encryptedPem)).toThrow();
    expect(rsaHybridDecrypt(container, encryptedPem, 's3cret').equals(plaintext)).toBe(true);
  });
});



