/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import crypto from 'crypto';
import fs from 'fs';
import { storagePathJoin } from '@nocobase/utils';

/**
 * Reversible secret storage for SFTP credentials (password / passphrase).
 *
 * NocoBase's `type: 'password'` field is a one-way scrypt HASH and can never
 * be recovered, which made password-based SFTP auth impossible for configs
 * created through the UI. This module encrypts secrets with AES-256-GCM so
 * they can be decrypted at connect time while staying ciphertext at rest.
 *
 * Ciphertext format: `enc:v1:<iv-b64>:<tag-b64>:<data-b64>`
 *
 * Key resolution order:
 * 1. SFTP_STORAGE_SECRET_KEY env var (recommended; required for multi-instance)
 * 2. The app JWT secret file (storage/apps/main/jwt_secret.dat), same source
 *    @nocobase/auth uses — stable across restarts out of the box
 * 3. APP_KEY env var
 * 4. Ephemeral random key (dev only): values written with an ephemeral key
 *    cannot be decrypted after a restart until the env var is configured.
 */

const PREFIX = 'enc:v1:';
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

// The ephemeral key is cached in-process so repeated encrypt/decrypt calls
// within one runtime use the same random key. Persistent key sources
// (env var / JWT secret file / APP_KEY) are re-read on every call so key
// rotation via environment takes effect without a restart of this module.
let ephemeralKey: Buffer | null = null;

export function __resetSecretKeyCacheForTest() {
  ephemeralKey = null;
}

function deriveKeyMaterial(secret: string | Buffer): Buffer {
  if (Buffer.isBuffer(secret)) {
    return secret.length === KEY_LENGTH ? secret : crypto.createHash('sha256').update(secret).digest();
  }
  return crypto.createHash('sha256').update(secret, 'utf8').digest();
}

function resolveSecretKey(): { key: Buffer; ephemeral: boolean } {
  const envKey = process.env.SFTP_STORAGE_SECRET_KEY?.trim();
  if (envKey) {
    return { key: deriveKeyMaterial(envKey), ephemeral: false };
  }

  try {
    const jwtSecretPath = storagePathJoin('apps', 'main', 'jwt_secret.dat');
    if (fs.existsSync(jwtSecretPath)) {
      const fileKey = fs.readFileSync(jwtSecretPath);
      if (fileKey.length > 0) {
        return { key: deriveKeyMaterial(fileKey), ephemeral: false };
      }
    }
  } catch {
    // fall through to APP_KEY / ephemeral
  }

  const appKey = process.env.APP_KEY?.trim();
  if (appKey && appKey !== 'your-secret-key' && appKey !== 'test-key') {
    return { key: deriveKeyMaterial(appKey), ephemeral: false };
  }

  if (!ephemeralKey) {
    ephemeralKey = crypto.randomBytes(KEY_LENGTH);
  }
  return { key: ephemeralKey, ephemeral: true };
}

/**
 * Report whether the currently resolved encryption key is ephemeral.
 * Exported for diagnostics/logging.
 */
export function getSecretKeyInfo(): { ephemeral: boolean } {
  return { ephemeral: resolveSecretKey().ephemeral };
}

export function isEncrypted(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export function encryptSecret(plainText: string): string {
  const { key } = resolveSecretKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptSecret(value: string): string {
  if (!isEncrypted(value)) {
    // Legacy plaintext or unknown format — return as-is so callers keep working.
    return value;
  }

  const parts = value.slice(PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new Error('[sftp-private] Invalid encrypted secret format');
  }

  const [ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', resolveSecretKey().key, Buffer.from(ivB64, 'base64'), {
    authTagLength: 16,
  });
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Encrypt a secret before persisting it. Values already encrypted are left
 * untouched so repeated saves do not double-encrypt. Empty values pass through.
 */
export function encryptSecretIfPlain(value: unknown): unknown {
  if (typeof value !== 'string' || value === '' || isEncrypted(value)) {
    return value;
  }
  return encryptSecret(value);
}

/**
 * Decrypt a secret read from the database. Non-encrypted values (legacy
 * plaintext or empty) pass through unchanged.
 */
export function decryptSecretIfNeeded(value: unknown): unknown {
  if (typeof value !== 'string' || !isEncrypted(value)) {
    return value;
  }
  return decryptSecret(value);
}
