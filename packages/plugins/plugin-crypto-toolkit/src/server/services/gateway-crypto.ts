import { createPublicKey } from 'crypto';
import type { Application } from '@nocobase/server';
import type { Model } from '@nocobase/database';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  rsaHybridDecrypt,
  rsaHybridEncrypt,
  type AesSecret,
} from './crypto-core';
import { createEnvGetter } from './resolve-env';
import { decryptAndVerify, encryptAndSign } from './pgp-service';

export type GatewayEncryptionMode = 'none' | 'aes-256-gcm' | 'pgp' | 'rsa-oaep';
export type GatewayWireFormat = 'binary' | 'json';

export interface GatewayEncryptedPayload {
  body: Buffer;
  contentType?: string;
}

export interface GatewayDecryptedPayload {
  body: Buffer;
  /** Plaintext content type carried by the JSON wire envelope, when present. */
  contentType?: string;
}

export interface GatewayEncryptOptions {
  mode: GatewayEncryptionMode;
  wireFormat: GatewayWireFormat;
  plaintext: Buffer;
  /** Plaintext content type to carry through the JSON envelope. */
  plaintextContentType?: string;
  /** Name of an environment variable holding the AES secret. */
  aesSecretEnvVar?: string;
  /** AES secret encrypted at rest via the application AES encryptor. */
  aesSecretEncrypted?: string;
  /** cryptoKeys row name holding the recipient public key. */
  pgpEncryptKeyName?: string;
  /** cryptoKeys row name holding the own sign key (private material in env). */
  pgpSignKeyName?: string;
  /** cryptoKeys row name holding the partner RSA public key. */
  rsaEncryptKeyName?: string;
}

export interface GatewayDecryptOptions {
  mode: GatewayEncryptionMode;
  /** Raw wire bytes (binary container or JSON envelope). */
  data: Buffer;
  /** Content type of the incoming wire body, used to detect a JSON envelope. */
  contentType?: string;
  aesSecretEnvVar?: string;
  aesSecretEncrypted?: string;
  pgpDecryptKeyName?: string;
  /** When set, unsigned messages are rejected with a typed error. */
  pgpVerifyKeyName?: string;
  rsaDecryptKeyName?: string;
}

export interface GatewayPrivateKeyMaterial {
  /** ASCII-armored private key or PEM. */
  material: string;
  passphrase?: string;
}

/** Error thrown for payload/key configuration problems in the gateway flow. */
export class GatewayCryptoError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, message: string, httpStatus = 500) {
    super(message);
    this.name = 'GatewayCryptoError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function routeField(route: { get(name: string): unknown }, name: string): string | undefined {
  const value = route.get(name);
  return value == null || value === '' ? undefined : String(value);
}

function optionField(options: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = options[name];
    if (value != null && value !== '') return String(value);
  }
  return undefined;
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

/**
 * Resolve an AES secret from a route record. The route may reference either
 * `aesSecretEnvVar` (name of an env variable) or `aesSecret` (encrypted at
 * rest via the application AES encryptor, masked in admin responses).
 */
export async function resolveAesSecret(
  app: Application,
  route: { get(name: string): unknown },
): Promise<AesSecret> {
  const getEnv = createEnvGetter(app);
  const envVar = routeField(route, 'aesSecretEnvVar');
  let rawSecret: string | undefined;
  if (envVar) {
    rawSecret = getEnv(envVar);
    if (!rawSecret) {
      throw new GatewayCryptoError('APIM_CRYPTO_CONFIG', `AES secret env variable "${envVar}" is not set`, 500);
    }
  } else {
    const encrypted = routeField(route, 'aesSecret') ?? routeField(route, 'aesSecretEncrypted');
    if (!encrypted) {
      throw new GatewayCryptoError('APIM_CRYPTO_CONFIG', 'Route has no AES secret configured', 500);
    }
    rawSecret = await app.aesEncryptor.decrypt(encrypted);
  }
  const asKey = tryBase64To32Bytes(rawSecret);
  return asKey ? { key: asKey } : { passphrase: rawSecret };
}

async function findCryptoKey(app: Application, name: string | undefined, label: string): Promise<Model> {
  if (!name) {
    throw new GatewayCryptoError('APIM_CRYPTO_CONFIG', `Route is missing ${label}`, 500);
  }
  const key = await app.db.getRepository('cryptoKeys').findOne({ filter: { name, enabled: true } });
  if (!key) {
    throw new GatewayCryptoError('APIM_CRYPTO_CONFIG', `Crypto Toolkit key "${name}" not found or disabled`, 500);
  }
  return key;
}

/**
 * Resolve the own private key material for a cryptoKeys row. The private
 * material lives in a Crypto Toolkit-managed environment variable:
 *   - the row stores `privateEnvVar` (with or without the `_PRIVATE` suffix —
 *     legacy rows may omit it);
 *   - the companion variable `<envVar>_PASSPHRASE` may hold the passphrase
 *     (toolkit writes it when a key is generated with a passphrase).
 */
export async function resolveOwnPrivateKeyMaterial(
  app: Application,
  keyRecord: Model,
): Promise<GatewayPrivateKeyMaterial> {
  const envVar = String(keyRecord.get('privateEnvVar') ?? '');
  const name = String(keyRecord.get('name') ?? '');
  if (!envVar) {
    throw new GatewayCryptoError('APIM_CRYPTO_CONFIG', `Crypto Toolkit key "${name}" has no privateEnvVar`, 500);
  }
  const resolvedEnvVar = envVar.endsWith('_PRIVATE') ? envVar : `${envVar}_PRIVATE`;
  const getEnv = createEnvGetter(app);
  const material = getEnv(resolvedEnvVar);
  if (!material) {
    throw new GatewayCryptoError('APIM_CRYPTO_CONFIG', `Private key env variable "${resolvedEnvVar}" is not set`, 500);
  }
  const passphrase = getEnv(`${resolvedEnvVar}_PASSPHRASE`);
  return passphrase ? { material, passphrase } : { material };
}

async function resolvePgpRecipientPublic(app: Application, name: string | undefined): Promise<string> {
  const keyRecord = await findCryptoKey(app, name, 'a PGP encrypt/verify key');
  const publicFormat = String(keyRecord.get('publicFormat') ?? '');
  if (publicFormat !== 'openpgp') {
    throw new GatewayCryptoError(
      'APIM_CRYPTO_CONFIG',
      `Crypto Toolkit key "${String(keyRecord.get('name'))}" is not an OpenPGP key (publicFormat="${publicFormat}")`,
      500,
    );
  }
  const armored = String(keyRecord.get('publicMaterial') ?? '');
  if (!armored) {
    throw new GatewayCryptoError('APIM_CRYPTO_CONFIG', 'PGP encrypt/verify key has no public material', 500);
  }
  return armored;
}

async function resolveRsaPublicKey(app: Application, name: string | undefined): Promise<string> {
  const keyRecord = await findCryptoKey(app, name, 'an RSA encrypt key');
  const publicFormat = String(keyRecord.get('publicFormat') ?? '');
  const pem = String(keyRecord.get('publicMaterial') ?? '');
  if (!pem) {
    throw new GatewayCryptoError('APIM_CRYPTO_CONFIG', 'RSA encrypt key has no public material', 500);
  }
  if (publicFormat === 'openssh') {
    // Convert via the same path the toolkit's own operations use; sshpk is
    // loaded lazily to keep this module importable without it.
    const { loadSshpk } = await import('./lazy-loaders');
    try {
      const sshpk = await loadSshpk();
      const parsed = sshpk.parseKey(pem, 'ssh');
      return parsed.toString('pem');
    } catch (error) {
      throw new GatewayCryptoError(
        'APIM_CRYPTO_CONFIG',
        `RSA encrypt key holds an unparseable OpenSSH public key: ${(error as Error).message}`,
        500,
      );
    }
  }
  if (publicFormat !== 'pem') {
    throw new GatewayCryptoError(
      'APIM_CRYPTO_CONFIG',
      `Crypto Toolkit key "${String(keyRecord.get('name'))}" is not a PEM key (publicFormat="${publicFormat}")`,
      500,
    );
  }
  let publicKey;
  try {
    publicKey = createPublicKey(pem);
  } catch (error) {
    throw new GatewayCryptoError(
      'APIM_CRYPTO_CONFIG',
      `RSA encrypt key public material is not a valid PEM key: ${(error as Error).message}`,
      500,
    );
  }
  if (publicKey.asymmetricKeyType !== 'rsa') {
    throw new GatewayCryptoError(
      'APIM_CRYPTO_CONFIG',
      `RSA encrypt key must be an RSA key; got ${publicKey.asymmetricKeyType}`,
      500,
    );
  }
  return pem;
}

async function resolveOwnPgpPrivate(
  app: Application,
  name: string | undefined,
  label: string,
): Promise<{ armored: string; passphrase?: string }> {
  const keyRecord = await findCryptoKey(app, name, label);
  const publicFormat = String(keyRecord.get('publicFormat') ?? '');
  if (publicFormat !== 'openpgp') {
    throw new GatewayCryptoError(
      'APIM_CRYPTO_CONFIG',
      `Crypto Toolkit key "${String(keyRecord.get('name'))}" is not an OpenPGP key (publicFormat="${publicFormat}")`,
      500,
    );
  }
  const { material, passphrase } = await resolveOwnPrivateKeyMaterial(app, keyRecord);
  return { armored: material, passphrase };
}

async function resolveOwnRsaPrivate(
  app: Application,
  name: string | undefined,
  label: string,
): Promise<{ pem: string; passphrase?: string }> {
  const keyRecord = await findCryptoKey(app, name, label);
  const publicFormat = String(keyRecord.get('publicFormat') ?? '');
  if (publicFormat !== 'pem' && publicFormat !== 'openssh') {
    throw new GatewayCryptoError(
      'APIM_CRYPTO_CONFIG',
      `Crypto Toolkit key "${String(keyRecord.get('name'))}" is not a PEM key (publicFormat="${publicFormat}")`,
      500,
    );
  }
  const { material, passphrase } = await resolveOwnPrivateKeyMaterial(app, keyRecord);
  if (publicFormat === 'openssh') {
    const { loadSshpk } = await import('./lazy-loaders');
    try {
      const sshpk = await loadSshpk();
      return { pem: sshpk.parsePrivateKey(material, 'openssh').toString('pkcs8'), passphrase };
    } catch (error) {
      throw new GatewayCryptoError(
        'APIM_CRYPTO_CONFIG',
        `Could not convert OpenSSH private key to PEM: ${(error as Error).message}`,
        500,
      );
    }
  }
  return { pem: material, passphrase };
}

function wrapWire(
  container: Buffer,
  wireFormat: GatewayWireFormat,
  containerLabel: string,
  plaintextContentType?: string,
): GatewayEncryptedPayload {
  if (wireFormat === 'json') {
    const envelope: Record<string, string> = {
      container: containerLabel,
      encoding: 'base64',
      ciphertext: container.toString('base64'),
    };
    // Carry the plaintext content type so the decrypting side can restore it
    // after unwrapping (the binary wire format has no place to store it).
    if (plaintextContentType) {
      envelope.contentType = plaintextContentType;
    }
    return { body: Buffer.from(JSON.stringify(envelope), 'utf8'), contentType: 'application/json' };
  }
  return { body: container, contentType: 'application/octet-stream' };
}

function unwrapWire(raw: Buffer, contentType?: string): { container: Buffer; plaintextContentType?: string } {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('application/json')) {
    try {
      const parsed = JSON.parse(raw.toString('utf8')) as { ciphertext?: unknown; contentType?: unknown };
      if (parsed && typeof parsed.ciphertext === 'string') {
        const plaintextContentType =
          typeof parsed.contentType === 'string' && parsed.contentType.trim() !== ''
            ? parsed.contentType
            : undefined;
        return { container: Buffer.from(parsed.ciphertext, 'base64'), plaintextContentType };
      }
    } catch {
      // Not a JSON envelope — fall through and treat the raw bytes as the container.
    }
  }
  return { container: raw };
}

/**
 * Encrypt a plaintext payload for the gateway wire, mirroring the formats the
 * toolkit's own operations produce (NCB1, OpenPGP binary, NCR1).
 */
export async function encryptGatewayPayload(
  app: Application,
  options: GatewayEncryptOptions,
): Promise<GatewayEncryptedPayload> {
  const { mode, wireFormat, plaintext, plaintextContentType } = options;
  if (mode === 'none') {
    return { body: plaintext };
  }

  if (mode === 'aes-256-gcm') {
    const secret = await resolveAesSecret(app, { get: (n) => (options as Record<string, unknown>)[n] });
    return wrapWire(aesGcmEncrypt(plaintext, secret), wireFormat, 'NCB1', plaintextContentType);
  }

  if (mode === 'pgp') {
    const recipientPublic = await resolvePgpRecipientPublic(app, options.pgpEncryptKeyName);
    let signerKey: { armored: string; passphrase?: string } | undefined;
    if (options.pgpSignKeyName) {
      signerKey = await resolveOwnPgpPrivate(app, options.pgpSignKeyName, 'a PGP sign key');
    }
    const ciphertext = await encryptAndSign({
      data: plaintext,
      recipientKeys: [{ armored: recipientPublic }],
      signerKey,
    });
    return wrapWire(Buffer.from(ciphertext), wireFormat, 'openpgp', plaintextContentType);
  }

  if (mode === 'rsa-oaep') {
    const publicKeyPem = await resolveRsaPublicKey(app, options.rsaEncryptKeyName);
    return wrapWire(rsaHybridEncrypt(plaintext, publicKeyPem), wireFormat, 'NCR1', plaintextContentType);
  }

  throw new GatewayCryptoError('APIM_CRYPTO_CONFIG', `Unknown encryption mode "${mode}"`, 500);
}

/**
 * Decrypt a wire payload for the gateway. Both wire formats are accepted
 * regardless of the route's configured format.
 */
export async function decryptGatewayPayload(
  app: Application,
  options: GatewayDecryptOptions,
): Promise<GatewayDecryptedPayload> {
  const { mode, data, contentType } = options;
  if (mode === 'none') {
    return { body: data };
  }

  const { container, plaintextContentType } = unwrapWire(data, contentType);

  if (mode === 'aes-256-gcm') {
    const secret = await resolveAesSecret(app, { get: (n) => (options as Record<string, unknown>)[n] });
    try {
      return { body: aesGcmDecrypt(container, secret), contentType: plaintextContentType };
    } catch (error) {
      throw new GatewayCryptoError('APIM_DECRYPT_FAILED', `AES decryption failed: ${(error as Error).message}`, 400);
    }
  }

  if (mode === 'pgp') {
    const privateKey = await resolveOwnPgpPrivate(app, options.pgpDecryptKeyName, 'a PGP decrypt key');
    let verificationKeys: Array<{ armored: string }> | undefined;
    if (options.pgpVerifyKeyName) {
      const armored = await resolvePgpRecipientPublic(app, options.pgpVerifyKeyName);
      verificationKeys = [{ armored }];
    }
    let result: Awaited<ReturnType<typeof decryptAndVerify>>;
    try {
      result = await decryptAndVerify({ data: container, privateKey, verificationKeys });
    } catch (error) {
      throw new GatewayCryptoError('APIM_DECRYPT_FAILED', `PGP decryption failed: ${(error as Error).message}`, 400);
    }
    if (verificationKeys && result.signatureValid !== true) {
      throw new GatewayCryptoError(
        'APIM_SIGNATURE_INVALID',
        result.signatureValid === false ? 'PGP signature verification failed' : 'PGP message is not signed',
        400,
      );
    }
    return { body: Buffer.from(result.data), contentType: plaintextContentType };
  }

  if (mode === 'rsa-oaep') {
    const privateKey = await resolveOwnRsaPrivate(app, options.rsaDecryptKeyName, 'an RSA decrypt key');
    try {
      return {
        body: rsaHybridDecrypt(container, privateKey.pem, privateKey.passphrase),
        contentType: plaintextContentType,
      };
    } catch (error) {
      throw new GatewayCryptoError('APIM_DECRYPT_FAILED', `RSA decryption failed: ${(error as Error).message}`, 400);
    }
  }

  throw new GatewayCryptoError('APIM_CRYPTO_CONFIG', `Unknown encryption mode "${mode}"`, 500);
}
