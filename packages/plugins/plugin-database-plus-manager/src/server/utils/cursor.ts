import { createHmac, timingSafeEqual } from 'node:crypto';

export interface CursorPayload {
  v: 1;
  collection: string;
  sort: string[];
  values: unknown[];
  filterHash: string;
  exp: number;
}

function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

export function createCursor(payload: CursorPayload, secret: string): string {
  const body = encode(JSON.stringify(payload));
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

export function parseCursor(token: string, secret: string, now = Date.now()): CursorPayload {
  const [body, signature] = token.split('.');
  if (!body || !signature || token.length > 8192) throw new Error('Invalid cursor');
  const expected = createHmac('sha256', secret).update(body).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('Invalid cursor');
  const payload = JSON.parse(decode(body)) as CursorPayload;
  if (payload.v !== 1 || !payload.collection || !Array.isArray(payload.sort) || !Array.isArray(payload.values)) {
    throw new Error('Invalid cursor');
  }
  if (!Number.isSafeInteger(payload.exp) || payload.exp <= now) throw new Error('Expired cursor');
  return payload;
}
