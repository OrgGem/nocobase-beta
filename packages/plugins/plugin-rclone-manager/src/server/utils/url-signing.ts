// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import fs from 'node:fs';
import { storagePathJoin } from '@nocobase/utils';

const DEFAULT_TTL_MS = 10 * 60 * 1000;

const cachedFileSecrets = new Map<string, Buffer>();
let ephemeralSecret: Buffer | null = null;
let warnedEphemeral = false;

export function __resetSigningSecretForTest(): void {
  cachedFileSecrets.clear();
  ephemeralSecret = null;
  warnedEphemeral = false;
}

const PLACEHOLDER_SECRETS = new Set(['your-secret-key', 'test-key']);

function normalizeSecretInput(secret: string | Buffer | null | undefined): Buffer | null {
  if (!secret) {
    return null;
  }
  if (Buffer.isBuffer(secret)) {
    return secret.length > 0 ? crypto.createHash('sha256').update(secret).digest() : null;
  }
  const trimmed = secret.trim();
  if (!trimmed || PLACEHOLDER_SECRETS.has(trimmed)) {
    return null;
  }
  return crypto.createHash('sha256').update(trimmed, 'utf8').digest();
}

function resolveSigningSecret(appSecret?: string | Buffer | null, appName?: string): Buffer {
  // Shared cluster environment variables take priority over AuthManager's default secret (which may come from a pod-local jwt_secret.dat).
  const envSecret = normalizeSecretInput(process.env.RCLONE_STREAM_URL_SECRET);
  if (envSecret) {
    return envSecret;
  }

  const jwtEnvSecret = normalizeSecretInput(process.env.JWT_SECRET);
  if (jwtEnvSecret) {
    return jwtEnvSecret;
  }

  const appKey = normalizeSecretInput(process.env.APP_KEY);
  if (appKey) {
    return appKey;
  }

  // Active app JWT secret when no shared cluster env var is configured.
  const runtimeAppSecret = normalizeSecretInput(appSecret);
  if (runtimeAppSecret) {
    return runtimeAppSecret;
  }

  const appKeyName = appName || 'main';
  const cachedFile = cachedFileSecrets.get(appKeyName);
  if (cachedFile) {
    return cachedFile;
  }

  try {
    const jwtSecretPath = storagePathJoin('apps', appKeyName, 'jwt_secret.dat');
    if (fs.existsSync(jwtSecretPath)) {
      const raw = fs.readFileSync(jwtSecretPath);
      if (raw.length > 0) {
        const digest = crypto.createHash('sha256').update(raw).digest();
        cachedFileSecrets.set(appKeyName, digest);
        return digest;
      }
    }
  } catch {
    // Fall through to ephemeral key
  }

  if (!ephemeralSecret) {
    ephemeralSecret = crypto.randomBytes(32);
    if (!warnedEphemeral) {
      warnedEphemeral = true;
      console.warn(
        '[plugin-rclone-manager] RCLONE_STREAM_URL_SECRET / JWT_SECRET / APP_KEY not configured; using per-process ephemeral download signing key (not shared across HA nodes).',
      );
    }
  }
  return ephemeralSecret;
}

export interface RcloneSignedStreamPayload {
  connectionId: number;
  fs: string;
  remote: string;
  isDir: boolean;
  mode: 'inline' | 'attachment';
  expires: number;
}

function serializePayload(payload: RcloneSignedStreamPayload): string {
  return JSON.stringify([
    payload.connectionId,
    payload.fs,
    payload.remote,
    payload.isDir ? 1 : 0,
    payload.mode,
    payload.expires,
  ]);
}

export function signStreamPayload(
  payload: RcloneSignedStreamPayload,
  options?: { appSecret?: string | Buffer | null; appName?: string },
): string {
  return crypto
    .createHmac('sha256', resolveSigningSecret(options?.appSecret, options?.appName))
    .update(serializePayload(payload), 'utf8')
    .digest('hex');
}

export function verifyStreamSignature(
  payload: RcloneSignedStreamPayload,
  signature: string,
  options?: { appSecret?: string | Buffer | null; appName?: string },
): boolean {
  if (!signature || typeof signature !== 'string' || !Number.isFinite(payload.expires)) {
    return false;
  }
  if (Date.now() > payload.expires) {
    return false;
  }
  const expected = signStreamPayload(payload, options);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

export function createSignedDownloadQuery(
  input: Omit<RcloneSignedStreamPayload, 'expires'> & {
    ttlMs?: number;
    appSecret?: string | Buffer | null;
    appName?: string;
  },
): string {
  const expires = Date.now() + (input.ttlMs ?? DEFAULT_TTL_MS);
  const payload: RcloneSignedStreamPayload = {
    connectionId: input.connectionId,
    fs: input.fs,
    remote: input.remote,
    isDir: input.isDir,
    mode: input.mode,
    expires,
  };
  const sig = signStreamPayload(payload, { appSecret: input.appSecret, appName: input.appName });
  const params = new URLSearchParams({
    connectionId: String(payload.connectionId),
    fs: payload.fs,
    remote: payload.remote,
    isDir: payload.isDir ? '1' : '0',
    mode: payload.mode,
    expires: String(payload.expires),
    sig,
  });
  return params.toString();
}

export function buildContentDisposition(filename: string, mode: 'inline' | 'attachment'): string {
  const dispositionType = mode === 'inline' ? 'inline' : 'attachment';
  const safeName = String(filename || 'download').trim() || 'download';
  const asciiFallback = safeName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_') || 'download';
  const encoded = encodeURIComponent(safeName).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${dispositionType}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}
