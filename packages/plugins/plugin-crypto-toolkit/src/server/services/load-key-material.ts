import { Application } from '@nocobase/server';
import { detectKeyMaterial, DetectedKeyMaterial } from './key-format-detect';
import { createEnvGetter } from './resolve-env';
import { readAttachmentBuffer } from './attachment-helper';

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
    throw new Error(
      `Exactly one of {text, attachmentId, envVar} must be provided (got: ${provided.join(', ') || 'none'})`,
    );
  }
}

async function loadFromEnv(app: Application, envVar: string): Promise<Buffer> {
  const getter = createEnvGetter(app);
  const value = getter(envVar);
  if (value === undefined || value === null) {
    throw new Error(`Environment variable "${envVar}" is not set`);
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
      throw new Error('text input is empty');
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

  throw new Error('input mode must be text, attachment, or env');
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
