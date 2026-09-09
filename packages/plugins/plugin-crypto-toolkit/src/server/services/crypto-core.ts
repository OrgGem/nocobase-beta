import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  KeyObject,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  scryptSync,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
} from 'crypto';

export type RawKeyKind = 'rsa-4096' | 'ed25519';
export type SignAlgorithm = 'rsa-pss-sha256' | 'ed25519';

export interface GeneratedKeyPair {
  publicKey: KeyObject;
  privateKey: KeyObject;
  publicPem: string;
  privatePem: string;
}

export function generateRawKeyPair(kind: RawKeyKind): GeneratedKeyPair {
  const { publicKey, privateKey } =
    kind === 'rsa-4096' ? generateKeyPairSync('rsa', { modulusLength: 4096 }) : generateKeyPairSync('ed25519');
  return {
    publicKey,
    privateKey,
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function fingerprintPublicKey(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return sha256Hex(der);
}

export function publicKeyFromPem(pem: string): KeyObject {
  return createPublicKey(pem);
}

export function privateKeyFromPem(pem: string, passphrase?: string): KeyObject {
  return createPrivateKey(passphrase ? { key: pem, passphrase } : pem);
}

// AES-256-GCM container: magic "NCB1" | mode(1) | [salt(16) when mode=1] | iv(12) | tag(16) | ciphertext
const AES_MAGIC = Buffer.from('NCB1', 'ascii');
const AES_MODE_RAW_KEY = 0x00;
const AES_MODE_PASSPHRASE = 0x01;
const AES_IV_LENGTH = 12;
const AES_TAG_LENGTH = 16;
const AES_SALT_LENGTH = 16;
const AES_KEY_LENGTH = 32;

export interface AesSecret {
  key?: Buffer;
  passphrase?: string;
}

export interface AesGcmParts {
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
  salt?: Buffer;
}

function deriveAesKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, AES_KEY_LENGTH);
}

export function normalizeAesKey(raw: Buffer | string): Buffer {
  const buffer = typeof raw === 'string' ? Buffer.from(raw.trim(), 'base64') : raw;
  if (buffer.length !== AES_KEY_LENGTH) {
    throw new Error(`AES key must be ${AES_KEY_LENGTH} bytes (base64-encoded); got ${buffer.length} bytes`);
  }
  return buffer;
}

export function aesGcmEncryptFields(plaintext: Buffer, secret: AesSecret): AesGcmParts {
  let key: Buffer;
  let salt: Buffer | undefined;
  if (secret.key) {
    key = normalizeAesKey(secret.key);
  } else if (secret.passphrase) {
    salt = randomBytes(AES_SALT_LENGTH);
    key = deriveAesKey(secret.passphrase, salt);
  } else {
    throw new Error('AES encryption requires a key or a passphrase');
  }
  const iv = randomBytes(AES_IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv, tag, ciphertext, salt };
}

export function aesGcmEncrypt(plaintext: Buffer, secret: AesSecret): Buffer {
  return assembleAesContainer(aesGcmEncryptFields(plaintext, secret));
}

export function assembleAesContainer(parts: AesGcmParts): Buffer {
  const header = parts.salt
    ? Buffer.concat([AES_MAGIC, Buffer.from([AES_MODE_PASSPHRASE]), parts.salt])
    : Buffer.concat([AES_MAGIC, Buffer.from([AES_MODE_RAW_KEY])]);
  return Buffer.concat([header, parts.iv, parts.tag, parts.ciphertext]);
}

export function aesGcmDecryptFields(parts: AesGcmParts, secret: AesSecret): Buffer {
  let key: Buffer;
  if (parts.salt) {
    if (!secret.passphrase) throw new Error('This payload was encrypted with a passphrase; provide the passphrase');
    key = deriveAesKey(secret.passphrase, parts.salt);
  } else {
    if (!secret.key) throw new Error('This payload was encrypted with a raw key; provide the AES key');
    key = normalizeAesKey(secret.key);
  }
  const decipher = createDecipheriv('aes-256-gcm', key, parts.iv);
  decipher.setAuthTag(parts.tag);
  return Buffer.concat([decipher.update(parts.ciphertext), decipher.final()]);
}

export function aesGcmDecrypt(payload: Buffer, secret: AesSecret): Buffer {
  if (payload.length < AES_MAGIC.length + 1 + AES_IV_LENGTH + AES_TAG_LENGTH) {
    throw new Error('Payload is too short to be a valid AES-GCM container');
  }
  const magic = payload.subarray(0, AES_MAGIC.length);
  if (!timingSafeEqual(magic, AES_MAGIC)) {
    throw new Error('Payload is not an AES-GCM container produced by this plugin (missing NCB1 header)');
  }
  const mode = payload[AES_MAGIC.length];
  let offset = AES_MAGIC.length + 1;
  let salt: Buffer | undefined;
  if (mode === AES_MODE_RAW_KEY) {
    // raw key — no salt
  } else if (mode === AES_MODE_PASSPHRASE) {
    salt = payload.subarray(offset, offset + AES_SALT_LENGTH);
    offset += AES_SALT_LENGTH;
  } else {
    throw new Error(`Unknown AES container mode 0x${mode.toString(16)}`);
  }
  const iv = payload.subarray(offset, offset + AES_IV_LENGTH);
  offset += AES_IV_LENGTH;
  const tag = payload.subarray(offset, offset + AES_TAG_LENGTH);
  offset += AES_TAG_LENGTH;
  const ciphertext = payload.subarray(offset);
  return aesGcmDecryptFields({ iv, tag, ciphertext, salt }, secret);
}
export function isAesContainer(payload: Buffer): boolean {
  return payload.length >= AES_MAGIC.length && payload.subarray(0, AES_MAGIC.length).equals(AES_MAGIC);
}

// RSA-OAEP hybrid container: RSA can only wrap small payloads, so a random
// AES-256 session key is wrapped with RSA-OAEP-SHA256 and the body is
// encrypted with AES-256-GCM:
// magic "NCR1" | wrappedKeyLen(2, BE) | wrappedKey | iv(12) | tag(16) | ciphertext
const RSA_MAGIC = Buffer.from('NCR1', 'ascii');
const RSA_OAEP_HASH = 'sha256';

export interface RsaHybridParts {
  wrappedKey: Buffer;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

export function rsaOaepWrapSessionKey(publicKeyPem: string, sessionKey: Buffer): Buffer {
  const publicKey = createPublicKey(publicKeyPem);
  if (publicKey.asymmetricKeyType !== 'rsa') {
    throw new Error('RSA-OAEP encryption requires an RSA public key; got ' + publicKey.asymmetricKeyType);
  }
  return publicEncrypt(
    { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: RSA_OAEP_HASH },
    sessionKey,
  );
}

export function rsaOaepUnwrapSessionKey(privateKeyPem: string, wrappedKey: Buffer, passphrase?: string): Buffer {
  const privateKey = createPrivateKey(passphrase ? { key: privateKeyPem, passphrase } : privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'rsa') {
    throw new Error('RSA-OAEP decryption requires an RSA private key; got ' + privateKey.asymmetricKeyType);
  }
  return privateDecrypt(
    { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: RSA_OAEP_HASH },
    wrappedKey,
  );
}

export function rsaHybridEncryptFields(plaintext: Buffer, publicKeyPem: string): RsaHybridParts {
  const sessionKey = randomBytes(AES_KEY_LENGTH);
  const wrappedKey = rsaOaepWrapSessionKey(publicKeyPem, sessionKey);
  const iv = randomBytes(AES_IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', sessionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { wrappedKey, iv, tag, ciphertext };
}

export function rsaHybridEncrypt(plaintext: Buffer, publicKeyPem: string): Buffer {
  return assembleRsaHybridContainer(rsaHybridEncryptFields(plaintext, publicKeyPem));
}

export function assembleRsaHybridContainer(parts: RsaHybridParts): Buffer {
  const lengthPrefix = Buffer.alloc(2);
  lengthPrefix.writeUInt16BE(parts.wrappedKey.length, 0);
  return Buffer.concat([RSA_MAGIC, lengthPrefix, parts.wrappedKey, parts.iv, parts.tag, parts.ciphertext]);
}

export function rsaHybridDecryptFields(parts: RsaHybridParts, privateKeyPem: string, passphrase?: string): Buffer {
  const sessionKey = rsaOaepUnwrapSessionKey(privateKeyPem, parts.wrappedKey, passphrase);
  const decipher = createDecipheriv('aes-256-gcm', sessionKey, parts.iv);
  decipher.setAuthTag(parts.tag);
  return Buffer.concat([decipher.update(parts.ciphertext), decipher.final()]);
}

export function rsaHybridDecrypt(payload: Buffer, privateKeyPem: string, passphrase?: string): Buffer {
  const minLength = RSA_MAGIC.length + 2 + AES_IV_LENGTH + AES_TAG_LENGTH;
  if (payload.length < minLength) {
    throw new Error('Payload is too short to be a valid RSA hybrid container');
  }
  const magic = payload.subarray(0, RSA_MAGIC.length);
  if (magic.length !== RSA_MAGIC.length || !timingSafeEqual(magic, RSA_MAGIC)) {
    throw new Error('Payload is not an RSA hybrid container (missing NCR1 header)');
  }
  let offset = RSA_MAGIC.length;
  const wrappedKeyLength = payload.readUInt16BE(offset);
  offset += 2;
  if (payload.length < offset + wrappedKeyLength + AES_IV_LENGTH + AES_TAG_LENGTH) {
    throw new Error('RSA hybrid container is truncated');
  }
  const wrappedKey = payload.subarray(offset, offset + wrappedKeyLength);
  offset += wrappedKeyLength;
  const iv = payload.subarray(offset, offset + AES_IV_LENGTH);
  offset += AES_IV_LENGTH;
  const tag = payload.subarray(offset, offset + AES_TAG_LENGTH);
  offset += AES_TAG_LENGTH;
  const ciphertext = payload.subarray(offset);
  return rsaHybridDecryptFields({ wrappedKey, iv, tag, ciphertext }, privateKeyPem, passphrase);
}

export function isRsaHybridContainer(payload: Buffer): boolean {
  return payload.length >= RSA_MAGIC.length && payload.subarray(0, RSA_MAGIC.length).equals(RSA_MAGIC);
}

export function signDetached(data: Buffer, algorithm: SignAlgorithm, privateKey: KeyObject): Buffer {
  if (algorithm === 'rsa-pss-sha256') {
    return cryptoSign('sha256', data, {
      key: privateKey,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    });
  }
  return cryptoSign(null, data, privateKey);
}

export function verifyDetached(
  data: Buffer,
  signature: Buffer,
  algorithm: SignAlgorithm,
  publicKey: KeyObject,
): boolean {
  if (algorithm === 'rsa-pss-sha256') {
    return cryptoVerify(
      'sha256',
      data,
      { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
      signature,
    );
  }
  return cryptoVerify(null, data, publicKey, signature);
}
