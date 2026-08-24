import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';

export const HMAC_TIMESTAMP_HEADER = 'X-APIM-Timestamp';
export const HMAC_NONCE_HEADER = 'X-APIM-Nonce';
export const HMAC_SIGNATURE_HEADER = 'X-APIM-Signature';

export interface HmacSignInput {
  secret: string;
  method: string;
  path: string;
  body: Buffer;
}

export interface HmacVerifyInput extends HmacSignInput {
  headers: Record<string, string | string[] | undefined>;
  toleranceSec: number;
  nonceCache: NonceCache;
}

function canonicalString(timestamp: string, nonce: string, method: string, path: string, body: Buffer): string {
  const bodyHash = createHash('sha256').update(body).digest('hex');
  return [timestamp, nonce, method.toUpperCase(), path, bodyHash].join('\n');
}

function hmacHex(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data, 'utf8').digest('hex');
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Builds the HMAC signing headers for an outbound request.
 * Canonical string: timestamp \n nonce \n METHOD \n path \n sha256hex(body)
 */
export function buildHmacHeaders(input: HmacSignInput): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString('hex');
  const signature = hmacHex(input.secret, canonicalString(timestamp, nonce, input.method, input.path, input.body));
  return {
    [HMAC_TIMESTAMP_HEADER]: timestamp,
    [HMAC_NONCE_HEADER]: nonce,
    [HMAC_SIGNATURE_HEADER]: signature,
  };
}

/**
 * Verifies the HMAC signing headers on an inbound request.
 * Throws an Error with a descriptive message when verification fails.
 */
export function verifyHmacHeaders(input: HmacVerifyInput): void {
  const timestamp = headerValue(input.headers, HMAC_TIMESTAMP_HEADER);
  const nonce = headerValue(input.headers, HMAC_NONCE_HEADER);
  const signature = headerValue(input.headers, HMAC_SIGNATURE_HEADER);

  if (!timestamp || !nonce || !signature) {
    throw new Error('Missing HMAC signing headers');
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    throw new Error('Invalid HMAC timestamp');
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > input.toleranceSec) {
    throw new Error('HMAC timestamp outside tolerance window');
  }

  if (input.nonceCache.has(nonce)) {
    throw new Error('Replayed HMAC nonce');
  }

  const expected = hmacHex(input.secret, canonicalString(timestamp, nonce, input.method, input.path, input.body));
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(signature, 'utf8');
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    throw new Error('HMAC signature mismatch');
  }

  input.nonceCache.add(nonce, input.toleranceSec);
}

/**
 * In-memory nonce cache with lazy TTL eviction and a bounded size.
 *
 * Lookups only delete the entry they touch (O(1) amortized), so the HMAC hot
 * path never scans the whole map. A full sweep of expired entries only runs
 * when the cache is at capacity and a new nonce needs room, keeping memory
 * bounded without per-request cost.
 *
 * NOTE: This cache is process-local. In multi-instance deployments each pod
 * maintains its own nonce set, so replay protection only applies within a
 * single instance. Use a shared store (e.g. Redis) when horizontal scaling
 * is required.
 */
export class NonceCache {
  private entries = new Map<string, number>();
  private readonly maxSize: number;

  constructor(maxSize = 10000) {
    this.maxSize = maxSize;
  }

  has(nonce: string): boolean {
    const expiry = this.entries.get(nonce);
    if (expiry == null) return false;
    if (expiry < Date.now()) {
      this.entries.delete(nonce);
      return false;
    }
    return true;
  }

  add(nonce: string, ttlSec: number): void {
    if (this.entries.size >= this.maxSize) {
      this.sweepExpired();
    }
    if (this.entries.size >= this.maxSize) {
      // Still full after sweeping: drop the oldest insertion to make room.
      const oldest = this.entries.keys().next().value;
      if (oldest != null) this.entries.delete(oldest);
    }
    this.entries.set(nonce, Date.now() + ttlSec * 1000);
  }

  /** Size of the live map (used by tests and diagnostics). */
  get size(): number {
    return this.entries.size;
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [nonce, expiry] of this.entries) {
      if (expiry < now) this.entries.delete(nonce);
    }
  }
}
