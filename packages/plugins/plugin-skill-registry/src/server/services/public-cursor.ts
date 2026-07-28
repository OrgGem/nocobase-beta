import { createHmac, timingSafeEqual } from 'crypto';

import { RegistryError } from '../contracts/errors';
import { isRecord } from '../contracts/types';
import { canonicalJson, sha256 } from './canonical-json';

export interface PublicCursorAnchor {
  publishedAt: string;
  id: string;
}

export interface PublicCursorScope {
  endpoint: 'catalog' | 'versions';
  query: Record<string, string | null>;
}

interface PublicCursorPayload {
  version: 1;
  scopeDigest: string;
  anchor: PublicCursorAnchor;
}

const MAX_CURSOR_LENGTH = 4096;
const CURSOR_PART_PATTERN = /^[A-Za-z0-9_-]+$/;
const SIGNATURE_PATTERN = /^[a-f0-9]{64}$/;

function cursorSecret(): string {
  return process.env.SKILL_REGISTRY_CURSOR_SECRET || process.env.APP_KEY || 'skill-registry-development';
}

function scopeDigest(scope: PublicCursorScope): string {
  return sha256(canonicalJson(scope));
}

function signature(encodedPayload: string): string {
  return createHmac('sha256', cursorSecret()).update(encodedPayload).digest('hex');
}

function invalidCursor(): RegistryError {
  return new RegistryError('INVALID_CURSOR', 400, 'Invalid cursor.');
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function parsePayload(encodedPayload: string): PublicCursorPayload {
  const parsed: unknown = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    typeof parsed.scopeDigest !== 'string' ||
    !isRecord(parsed.anchor) ||
    !isCanonicalTimestamp(parsed.anchor.publishedAt) ||
    typeof parsed.anchor.id !== 'string' ||
    !parsed.anchor.id ||
    parsed.anchor.id.length > 255
  ) {
    throw invalidCursor();
  }
  return {
    version: 1,
    scopeDigest: parsed.scopeDigest,
    anchor: {
      publishedAt: parsed.anchor.publishedAt,
      id: parsed.anchor.id,
    },
  };
}

export function encodePublicCursor(scope: PublicCursorScope, anchor: PublicCursorAnchor): string {
  if (!isCanonicalTimestamp(anchor.publishedAt) || !anchor.id || anchor.id.length > 255) {
    throw invalidCursor();
  }
  const payload: PublicCursorPayload = {
    version: 1,
    scopeDigest: scopeDigest(scope),
    anchor,
  };
  const encodedPayload = Buffer.from(canonicalJson(payload), 'utf8').toString('base64url');
  return `${encodedPayload}.${signature(encodedPayload)}`;
}

export function decodePublicCursor(
  cursor: string | undefined,
  expectedScope: PublicCursorScope,
): PublicCursorAnchor | undefined {
  if (cursor === undefined) {
    return undefined;
  }
  try {
    if (!cursor || cursor.length > MAX_CURSOR_LENGTH) {
      throw invalidCursor();
    }
    const parts = cursor.split('.');
    if (
      parts.length !== 2 ||
      !parts[0] ||
      !CURSOR_PART_PATTERN.test(parts[0]) ||
      !parts[1] ||
      !SIGNATURE_PATTERN.test(parts[1])
    ) {
      throw invalidCursor();
    }
    const [encodedPayload, providedSignature] = parts;
    const expectedSignature = signature(encodedPayload);
    if (!timingSafeEqual(Buffer.from(expectedSignature, 'hex'), Buffer.from(providedSignature, 'hex'))) {
      throw invalidCursor();
    }
    const payload = parsePayload(encodedPayload);
    if (payload.scopeDigest !== scopeDigest(expectedScope)) {
      throw invalidCursor();
    }
    return payload.anchor;
  } catch (error) {
    if (error instanceof RegistryError && error.code === 'INVALID_CURSOR') {
      throw error;
    }
    throw invalidCursor();
  }
}
