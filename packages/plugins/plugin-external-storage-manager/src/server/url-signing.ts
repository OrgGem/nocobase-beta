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
 * Stateless signed download URLs for extStorage:download.
 *
 * Previously the browser appended the user's long-lived JWT to every
 * download/preview URL (`?token=...`), leaking the credential into browser
 * history, proxy logs, and Referer headers. Signed URLs replace that with an
 * HMAC over (directoryId, path, mode, expiry): short-lived, scope-bound, and
 * verifiable without server-side state — the same trust model as S3
 * presigned URLs.
 *
 * Secret resolution order:
 * 1. EXT_STORAGE_URL_SECRET env var (recommended for multi-instance)
 * 2. The app JWT secret file (storage/apps/main/jwt_secret.dat)
 * 3. APP_KEY env var
 * 4. Ephemeral random key (URLs invalidate on restart; a warning is logged)
 */

const DEFAULT_URL_TTL_SECONDS = 600;

let cachedSecret: Buffer | null = null;
let ephemeralSecret: Buffer | null = null;

export function __resetUrlSigningCacheForTest() {
  cachedSecret = null;
  ephemeralSecret = null;
}

function resolveSecret(): Buffer {
  if (cachedSecret) {
    return cachedSecret;
  }

  const envSecret = process.env.EXT_STORAGE_URL_SECRET?.trim();
  if (envSecret) {
    cachedSecret = crypto.createHash('sha256').update(envSecret, 'utf8').digest();
    return cachedSecret;
  }

  try {
    const jwtSecretPath = storagePathJoin('apps', 'main', 'jwt_secret.dat');
    if (fs.existsSync(jwtSecretPath)) {
      const fileKey = fs.readFileSync(jwtSecretPath);
      if (fileKey.length > 0) {
        cachedSecret = crypto.createHash('sha256').update(fileKey).digest();
        return cachedSecret;
      }
    }
  } catch {
    // fall through
  }

  const appKey = process.env.APP_KEY?.trim();
  if (appKey && appKey !== 'your-secret-key' && appKey !== 'test-key') {
    cachedSecret = crypto.createHash('sha256').update(appKey, 'utf8').digest();
    return cachedSecret;
  }

  if (!ephemeralSecret) {
    ephemeralSecret = crypto.randomBytes(32);
  }
  return ephemeralSecret;
}

export function getUrlSigningInfo(): { ephemeral: boolean } {
  const saved = cachedSecret;
  cachedSecret = null;
  const secret = resolveSecret();
  const ephemeral = ephemeralSecret !== null && secret === ephemeralSecret;
  cachedSecret = saved;
  return { ephemeral };
}

export interface SignedUrlPayload {
  directoryId: number | string;
  path: string;
  mode: 'inline' | 'attachment';
  /** Expiry as unix ms. */
  expires: number;
}

function payloadToString(payload: SignedUrlPayload): string {
  return `${payload.directoryId}|${payload.path}|${payload.mode}|${payload.expires}`;
}

export function signDownloadPayload(payload: SignedUrlPayload): string {
  return crypto.createHmac('sha256', resolveSecret()).update(payloadToString(payload)).digest('hex');
}

export function verifyDownloadSignature(payload: SignedUrlPayload, signature: string): boolean {
  if (typeof signature !== 'string' || signature.length === 0) {
    return false;
  }
  const expected = signDownloadPayload(payload);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

export function getDefaultUrlTtlSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.EXT_STORAGE_SIGNED_URL_TTL_SEC);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_URL_TTL_SECONDS;
  }
  return Math.floor(raw);
}

/**
 * Build a ready-to-use signed download URL for a file entry.
 */
export function buildSignedDownloadUrl(params: {
  directoryId: number | string;
  path: string;
  mode?: 'inline' | 'attachment';
  ttlSeconds?: number;
  now?: number;
}): string {
  const now = params.now ?? Date.now();
  const ttl = params.ttlSeconds ?? getDefaultUrlTtlSeconds();
  const payload: SignedUrlPayload = {
    directoryId: params.directoryId,
    path: params.path,
    mode: params.mode ?? 'inline',
    expires: now + ttl * 1000,
  };
  const search = new URLSearchParams({
    directoryId: String(payload.directoryId),
    path: payload.path,
    mode: payload.mode,
    expires: String(payload.expires),
    signature: signDownloadPayload(payload),
  });
  return `/api/extStorage:download?${search.toString()}`;
}
