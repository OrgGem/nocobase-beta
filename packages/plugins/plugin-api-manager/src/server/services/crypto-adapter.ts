import type { Model } from '@nocobase/database';
import type { Application } from '@nocobase/server';
import { ERROR_CODES, type EncryptionMode, type WireFormat } from '../../constants';
import { aesGcmDecrypt, aesGcmEncrypt, createEnvGetter, type AesSecret } from './crypto-primitives';
import { ApimError } from './errors';
import { decryptAndVerify, encryptAndSign } from './pgp';

export interface EncryptedPayload {
  body: Buffer;
  contentType?: string;
}

interface RouteLike {
  get(name: string): unknown;
}

function routeField(route: RouteLike, name: string): string | undefined {
  const value = route.get(name);
  return value == null || value === '' ? undefined : String(value);
}

function tryBase64To32Bytes(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (!/^[A-Za-z0-9+/=_-]+$/.test(trimmed)) return null;
  try {
    const buffer = Buffer.from(trimmed, 'base64');
    return buffer.length === 32 ? buffer : null;
  } catch {
    return null;
  }
}

async function resolveAesSecret(app: Application, route: RouteLike): Promise<AesSecret> {
  const getEnv = createEnvGetter(app);
  const envVar = routeField(route, 'aesSecretEnvVar');
  let rawSecret: string | undefined;
  if (envVar) {
    rawSecret = getEnv(envVar);
    if (!rawSecret) {
      throw new ApimError(ERROR_CODES.CRYPTO_CONFIG, `AES secret env variable "${envVar}" is not set`, 500);
    }
  } else {
    const encrypted = routeField(route, 'aesSecret');
    if (!encrypted) {
      throw new ApimError(ERROR_CODES.CRYPTO_CONFIG, 'Route has no AES secret configured', 500);
    }
    rawSecret = await app.aesEncryptor.decrypt(encrypted);
  }
  const asKey = tryBase64To32Bytes(rawSecret);
  return asKey ? { key: asKey } : { passphrase: rawSecret };
}

async function findCryptoKey(app: Application, name: string | undefined, label: string): Promise<Model> {
  if (!name) {
    throw new ApimError(ERROR_CODES.CRYPTO_CONFIG, `Route is missing ${label}`, 500);
  }
  const key = await app.db.getRepository('cryptoKeys').findOne({ filter: { name, enabled: true } });
  if (!key) {
    throw new ApimError(ERROR_CODES.CRYPTO_CONFIG, `Crypto Toolkit key "${name}" not found or disabled`, 500);
  }
  return key;
}

async function resolveOwnPrivateKey(
  app: Application,
  keyRecord: Model,
): Promise<{ armored: string; passphrase?: string }> {
  const envVar = keyRecord.get('privateEnvVar');
  const name = String(keyRecord.get('name') ?? '');
  if (!envVar) {
    throw new ApimError(ERROR_CODES.CRYPTO_CONFIG, `Crypto Toolkit key "${name}" has no privateEnvVar`, 500);
  }
  const getEnv = createEnvGetter(app);
  const armored = getEnv(String(envVar));
  if (!armored) {
    throw new ApimError(ERROR_CODES.CRYPTO_CONFIG, `Private key env variable "${envVar}" is not set`, 500);
  }
  const passphrase = getEnv(`${envVar}_PASSPHRASE`);
  return passphrase ? { armored, passphrase } : { armored };
}

function wrapWire(container: Buffer, wireFormat: WireFormat): EncryptedPayload {
  if (wireFormat === 'json') {
    const envelope = JSON.stringify({ encoding: 'base64', ciphertext: container.toString('base64') });
    return { body: Buffer.from(envelope, 'utf8'), contentType: 'application/json' };
  }
  return { body: container, contentType: 'application/octet-stream' };
}

function unwrapWire(raw: Buffer, contentType?: string): Buffer {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('application/json')) {
    try {
      const parsed = JSON.parse(raw.toString('utf8')) as { ciphertext?: unknown };
      if (parsed && typeof parsed.ciphertext === 'string') {
        return Buffer.from(parsed.ciphertext, 'base64');
      }
    } catch {
      // Not a JSON envelope — fall through and treat the raw bytes as the container.
    }
  }
  return raw;
}

export async function encryptPayload(app: Application, route: RouteLike, plaintext: Buffer): Promise<EncryptedPayload> {
  const mode = (routeField(route, 'encryptionMode') ?? 'none') as EncryptionMode;
  const wireFormat = (routeField(route, 'wireFormat') ?? 'binary') as WireFormat;

  if (mode === 'none') {
    return { body: plaintext };
  }

  if (mode === 'aes-256-gcm') {
    const secret = await resolveAesSecret(app, route);
    return wrapWire(aesGcmEncrypt(plaintext, secret), wireFormat);
  }

  if (mode === 'pgp') {
    const recipientKey = await findCryptoKey(app, routeField(route, 'pgpEncryptKeyName'), 'a PGP encrypt key');
    const recipientPublic = String(recipientKey.get('publicMaterial') ?? '');
    if (!recipientPublic) {
      throw new ApimError(ERROR_CODES.CRYPTO_CONFIG, 'PGP encrypt key has no public material', 500);
    }
    let signerKey: { armored: string; passphrase?: string } | undefined;
    const signKeyName = routeField(route, 'pgpSignKeyName');
    if (signKeyName) {
      const signKeyRecord = await findCryptoKey(app, signKeyName, 'a PGP sign key');
      signerKey = await resolveOwnPrivateKey(app, signKeyRecord);
    }
    const ciphertext = await encryptAndSign({
      data: plaintext,
      recipientKeys: [{ armored: recipientPublic }],
      signerKey,
    });
    return wrapWire(Buffer.from(ciphertext), wireFormat);
  }

  throw new ApimError(ERROR_CODES.CRYPTO_CONFIG, `Unknown encryption mode "${mode}"`, 500);
}

export async function decryptPayload(
  app: Application,
  route: RouteLike,
  raw: Buffer,
  contentType?: string,
): Promise<Buffer> {
  const mode = (routeField(route, 'encryptionMode') ?? 'none') as EncryptionMode;
  if (mode === 'none') {
    return raw;
  }

  const container = unwrapWire(raw, contentType);

  if (mode === 'aes-256-gcm') {
    const secret = await resolveAesSecret(app, route);
    try {
      return aesGcmDecrypt(container, secret);
    } catch (error) {
      throw new ApimError(ERROR_CODES.DECRYPT_FAILED, `AES decryption failed: ${(error as Error).message}`, 400);
    }
  }

  if (mode === 'pgp') {
    const decryptKeyRecord = await findCryptoKey(app, routeField(route, 'pgpDecryptKeyName'), 'a PGP decrypt key');
    const privateKey = await resolveOwnPrivateKey(app, decryptKeyRecord);
    const verifyKeyName = routeField(route, 'pgpVerifyKeyName');
    let verificationKeys: Array<{ armored: string }> | undefined;
    if (verifyKeyName) {
      const verifyKeyRecord = await findCryptoKey(app, verifyKeyName, 'a PGP verify key');
      verificationKeys = [{ armored: String(verifyKeyRecord.get('publicMaterial') ?? '') }];
    }
    let result: Awaited<ReturnType<typeof decryptAndVerify>>;
    try {
      result = await decryptAndVerify({ data: container, privateKey, verificationKeys });
    } catch (error) {
      throw new ApimError(ERROR_CODES.DECRYPT_FAILED, `PGP decryption failed: ${(error as Error).message}`, 400);
    }
    if (verificationKeys && result.signatureValid === false) {
      throw new ApimError(ERROR_CODES.SIGNATURE_INVALID, 'PGP signature verification failed', 400);
    }
    return Buffer.from(result.data);
  }

  throw new ApimError(ERROR_CODES.CRYPTO_CONFIG, `Unknown encryption mode "${mode}"`, 500);
}
