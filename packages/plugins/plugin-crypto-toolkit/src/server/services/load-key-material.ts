import { Application } from '@nocobase/server';
import { detectKeyMaterial, DetectedKeyMaterial } from './key-format-detect';
import { createEnvGetter } from './resolve-env';
import { readAttachmentBuffer } from './attachment-helper';
import { CryptoToolkitHttpError } from '../http-error';

function badRequest(message: string): never {
  throw new CryptoToolkitHttpError(400, 'CRYPTOTOOLKIT_BAD_REQUEST', message);
}

/**
 * One of three input shapes. Exactly one of `text`, `attachmentId`, `envVar` is set.
 *
 * - `text`: raw text the user pasted (PEM block, OpenSSH line, PGP armor).
 * - `attachmentId`: an existing attachment record id whose content is the key material.
 * - `envVar`: name of a NocoBase environment variable holding the key material
 *   (private keys MUST use `envVar`; public keys MAY). Resolved server-side.
 */
export type KeyMaterialInput =
  | { mode: 'text'; text: string }
  | { mode: 'attachment'; attachmentId: number | string }
  | { mode: 'env'; envVar: string };

export interface LoadedKeyMaterial {
  /** Raw bytes that were inspected — useful when the caller wants to log a fingerprint or hash. */
  buffer: Buffer;
  /** Normalized detection result. */
  detected: DetectedKeyMaterial;
  /** Where the material came from (used for operation logging). */
  source: 'text' | 'attachment' | 'env';
}

export interface LoadMaterialOptions {
  attachmentOwnerId: number;
  maxBytes?: number;
}

function assertSingleMode(input: KeyMaterialInput): void {
  const provided = ['text', 'attachmentId', 'envVar'].filter(
    (k) => (input as Record<string, unknown>)[k] !== undefined && (input as Record<string, unknown>)[k] !== '',
  );
  if (provided.length !== 1) {
    badRequest(`Exactly one of {text, attachmentId, envVar} must be provided (got: ${provided.join(', ') || 'none'})`);
  }
}

const ALLOWED_ENV_PREFIX = 'CRYPTO_TOOLKIT_';

async function loadFromEnv(app: Application, envVar: string): Promise<Buffer> {
  // Only Crypto Toolkit-managed variables may be read as key material; arbitrary
  // environment variables (DB_PASSWORD, APP_SECRET, ...) must not be exposed
  // through the crypto operations API.
  if (!envVar.startsWith(ALLOWED_ENV_PREFIX)) {
    badRequest(`Environment variable "${envVar}" is not a Crypto Toolkit variable`);
  }
  const getter = createEnvGetter(app);
  const value = getter(envVar);
  if (value === undefined || value === null) {
    badRequest(`Environment variable "${envVar}" is not set`);
  }
  return Buffer.from(value, 'utf8');
}
async function loadFromAttachment(
  app: Application,
  attachmentId: number | string,
  options: LoadMaterialOptions,
): Promise<Buffer> {
  const { buffer } = await readAttachmentBuffer(app, attachmentId, {
    ownerId: options.attachmentOwnerId,
    maxBytes: options.maxBytes,
  });
  return buffer;
}

/**
 * Load user-provided bytes without interpreting them as key material. This is
 * used by crypto operations, which must accept arbitrary files such as PDFs,
 * images, and previously encrypted payloads.
 */
export async function loadRawMaterial(
  app: Application,
  input: KeyMaterialInput,
  options: LoadMaterialOptions,
): Promise<Pick<LoadedKeyMaterial, 'buffer' | 'source'>> {
  assertSingleMode(input);

  if (input.mode === 'text') {
    if (typeof input.text !== 'string' || input.text.length === 0) {
      badRequest('text input is empty');
    }
    return { buffer: Buffer.from(input.text, 'utf8'), source: 'text' };
  }

  if (input.mode === 'attachment') {
    return {
      buffer: await loadFromAttachment(app, input.attachmentId, options),
      source: 'attachment',
    };
  }

  if (input.mode === 'env') {
    return { buffer: await loadFromEnv(app, input.envVar), source: 'env' };
  }

  badRequest('input mode must be text, attachment, or env');
}

/**
 * Resolve a `KeyMaterialInput` into bytes + detected metadata. Always runs the
 * detection chain so the caller can branch on `detected.kind` / `detected.format`.
 */
export async function loadKeyMaterial(
  app: Application,
  input: KeyMaterialInput,
  options: LoadMaterialOptions,
): Promise<LoadedKeyMaterial> {
  const { buffer, source } = await loadRawMaterial(app, input, options);

  const detected = await detectKeyMaterial(buffer);
  return { buffer, detected, source };
}
