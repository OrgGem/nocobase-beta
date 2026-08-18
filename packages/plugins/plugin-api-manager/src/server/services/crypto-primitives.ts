import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto';

// AES-256-GCM container, byte-compatible with plugin-crypto-toolkit's crypto-core
// so payloads are interchangeable between the two plugins:
// magic "NCB1" | mode(1) | [salt(16) when mode=1] | iv(12) | tag(16) | ciphertext
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

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function normalizeAesKey(raw: Buffer | string): Buffer {
  const buffer = typeof raw === 'string' ? Buffer.from(raw.trim(), 'base64') : raw;
  if (buffer.length !== AES_KEY_LENGTH) {
    throw new Error(`AES key must be ${AES_KEY_LENGTH} bytes (base64-encoded); got ${buffer.length} bytes`);
  }
  return buffer;
}

function deriveAesKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, AES_KEY_LENGTH);
}

export function aesGcmEncrypt(plaintext: Buffer, secret: AesSecret): Buffer {
  let key: Buffer;
  let header: Buffer;
  if (secret.key) {
    key = normalizeAesKey(secret.key);
    header = Buffer.concat([AES_MAGIC, Buffer.from([AES_MODE_RAW_KEY])]);
  } else if (secret.passphrase) {
    const salt = randomBytes(AES_SALT_LENGTH);
    key = deriveAesKey(secret.passphrase, salt);
    header = Buffer.concat([AES_MAGIC, Buffer.from([AES_MODE_PASSPHRASE]), salt]);
  } else {
    throw new Error('AES encryption requires a key or a passphrase');
  }
  const iv = randomBytes(AES_IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([header, iv, tag, ciphertext]);
}

export function aesGcmDecrypt(payload: Buffer, secret: AesSecret): Buffer {
  if (payload.length < AES_MAGIC.length + 1 + AES_IV_LENGTH + AES_TAG_LENGTH) {
    throw new Error('Payload is too short to be a valid AES-GCM container');
  }
  const magic = payload.subarray(0, AES_MAGIC.length);
  if (magic.length !== AES_MAGIC.length || !timingSafeEqual(magic, AES_MAGIC)) {
    throw new Error('Payload is not an AES-GCM container (missing NCB1 header)');
  }
  const mode = payload[AES_MAGIC.length];
  let offset = AES_MAGIC.length + 1;
  let key: Buffer;
  if (mode === AES_MODE_RAW_KEY) {
    if (!secret.key) throw new Error('This payload was encrypted with a raw key; provide the AES key');
    key = normalizeAesKey(secret.key);
  } else if (mode === AES_MODE_PASSPHRASE) {
    if (!secret.passphrase) throw new Error('This payload was encrypted with a passphrase; provide the passphrase');
    const salt = payload.subarray(offset, offset + AES_SALT_LENGTH);
    offset += AES_SALT_LENGTH;
    key = deriveAesKey(secret.passphrase, salt);
  } else {
    throw new Error(`Unknown AES container mode 0x${mode.toString(16)}`);
  }
  const iv = payload.subarray(offset, offset + AES_IV_LENGTH);
  offset += AES_IV_LENGTH;
  const tag = payload.subarray(offset, offset + AES_TAG_LENGTH);
  offset += AES_TAG_LENGTH;
  const ciphertext = payload.subarray(offset);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function isAesContainer(payload: Buffer): boolean {
  return payload.length >= AES_MAGIC.length && payload.subarray(0, AES_MAGIC.length).equals(AES_MAGIC);
}

// Environment variable resolution, mirroring plugin-crypto-toolkit's createEnvGetter:
// NocoBase secret env vars (DB-stored) are read from app.environment first, then process.env.
export type EnvVariableGetter = (name: string) => string | undefined;

interface EnvironmentServiceLike {
  getVariable?: (name: string) => unknown;
  getVariables?: () => Record<string, unknown> | undefined;
}

interface AppWithEnvironment {
  environment?: EnvironmentServiceLike;
}

export function createEnvGetter(app: unknown): EnvVariableGetter {
  return (name: string) => {
    const envService = (app as AppWithEnvironment | undefined)?.environment;
    let value: unknown;
    if (envService) {
      if (typeof envService.getVariable === 'function') {
        value = envService.getVariable(name);
      }
      if (value == null && typeof envService.getVariables === 'function') {
        value = envService.getVariables()?.[name];
      }
    }
    if (value != null) return String(value);
    const fromProcess = process.env[name];
    return fromProcess == null ? undefined : fromProcess;
  };
}
