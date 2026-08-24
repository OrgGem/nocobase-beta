import { describe, expect, it } from 'vitest';
import {
  buildHmacHeaders,
  HMAC_NONCE_HEADER,
  HMAC_SIGNATURE_HEADER,
  HMAC_TIMESTAMP_HEADER,
  NonceCache,
  verifyHmacHeaders,
} from '../services/hmac-signer';

const SECRET = 'test-hmac-secret';

function signAndVerify(overrides: Partial<Parameters<typeof verifyHmacHeaders>[0]> = {}) {
  const body = Buffer.from(JSON.stringify({ hello: 'world' }));
  const headers = buildHmacHeaders({ secret: SECRET, method: 'POST', path: '/api/apim/inbound/orders', body });
  verifyHmacHeaders({
    secret: SECRET,
    method: 'POST',
    path: '/api/apim/inbound/orders',
    body,
    headers,
    toleranceSec: 300,
    nonceCache: new NonceCache(),
    ...overrides,
  });
}

describe('hmac-signer', () => {
  it('signs and verifies a request roundtrip', () => {
    expect(() => signAndVerify()).not.toThrow();
  });

  it('verifies with lowercase header names', () => {
    const body = Buffer.from('payload');
    const headers = buildHmacHeaders({ secret: SECRET, method: 'POST', path: '/x', body });
    const lowered: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) lowered[key.toLowerCase()] = value;
    expect(() =>
      verifyHmacHeaders({
        secret: SECRET,
        method: 'POST',
        path: '/x',
        body,
        headers: lowered,
        toleranceSec: 300,
        nonceCache: new NonceCache(),
      }),
    ).not.toThrow();
  });

  it('rejects a tampered body', () => {
    const body = Buffer.from('original');
    const headers = buildHmacHeaders({ secret: SECRET, method: 'POST', path: '/x', body });
    expect(() =>
      verifyHmacHeaders({
        secret: SECRET,
        method: 'POST',
        path: '/x',
        body: Buffer.from('tampered'),
        headers,
        toleranceSec: 300,
        nonceCache: new NonceCache(),
      }),
    ).toThrow(/signature mismatch/);
  });

  it('rejects a wrong secret', () => {
    const body = Buffer.from('data');
    const headers = buildHmacHeaders({ secret: SECRET, method: 'POST', path: '/x', body });
    expect(() =>
      verifyHmacHeaders({
        secret: 'other-secret',
        method: 'POST',
        path: '/x',
        body,
        headers,
        toleranceSec: 300,
        nonceCache: new NonceCache(),
      }),
    ).toThrow(/signature mismatch/);
  });

  it('rejects a timestamp outside the tolerance window', () => {
    const body = Buffer.from('data');
    const headers = buildHmacHeaders({ secret: SECRET, method: 'POST', path: '/x', body });
    headers[HMAC_TIMESTAMP_HEADER] = String(Math.floor(Date.now() / 1000) - 9999);
    expect(() =>
      verifyHmacHeaders({
        secret: SECRET,
        method: 'POST',
        path: '/x',
        body,
        headers,
        toleranceSec: 300,
        nonceCache: new NonceCache(),
      }),
    ).toThrow(/tolerance/);
  });

  it('rejects missing headers', () => {
    expect(() =>
      verifyHmacHeaders({
        secret: SECRET,
        method: 'POST',
        path: '/x',
        body: Buffer.alloc(0),
        headers: {},
        toleranceSec: 300,
        nonceCache: new NonceCache(),
      }),
    ).toThrow(/Missing HMAC/);
  });

  it('rejects a replayed nonce', () => {
    const body = Buffer.from('data');
    const headers = buildHmacHeaders({ secret: SECRET, method: 'POST', path: '/x', body });
    const nonceCache = new NonceCache();
    const input = {
      secret: SECRET,
      method: 'POST',
      path: '/x',
      body,
      headers,
      toleranceSec: 300,
      nonceCache,
    };
    expect(() => verifyHmacHeaders(input)).not.toThrow();
    expect(() => verifyHmacHeaders(input)).toThrow(/Replayed/);
  });

  it('nonce cache expires entries after TTL', async () => {
    const cache = new NonceCache();
    cache.add('nonce-1', 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cache.has('nonce-1')).toBe(false);
  });

  it('nonce cache evicts oldest entries when full', () => {
    const cache = new NonceCache(2);
    cache.add('a', 60);
    cache.add('b', 60);
    cache.add('c', 60);
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
    expect(cache.has('c')).toBe(true);
  });

  it('nonce cache prunes expired entries on has()', async () => {
    const cache = new NonceCache();
    cache.add('expire-me', 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cache.has('expire-me')).toBe(false);
  });

  it('nonce cache prunes expired entries on add()', async () => {
    const cache = new NonceCache(3);
    cache.add('old', 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    cache.add('new', 60);
    expect(cache.has('old')).toBe(false);
    expect(cache.has('new')).toBe(true);
  });

  it('nonce cache does not evict valid entries below max size', () => {
    const cache = new NonceCache(5);
    cache.add('x', 60);
    cache.add('y', 60);
    cache.add('z', 60);
    expect(cache.has('x')).toBe(true);
    expect(cache.has('y')).toBe(true);
    expect(cache.has('z')).toBe(true);
  });

  it('nonce cache keeps live entries without sweeping until capacity', () => {
    const cache = new NonceCache(3);
    cache.add('a', 1);
    cache.add('b', 1);
    cache.add('c', 1);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(true);
    expect(cache.has('c')).toBe(true);
    cache.add('d', 1);
    expect(cache.size).toBe(3);
    expect(cache.has('a')).toBe(false);
  });

  it('sweeps expired entries when at capacity instead of evicting them', async () => {
    const cache = new NonceCache(2);
    cache.add('expired', 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    cache.add('live', 60);
    expect(cache.has('expired')).toBe(false);
    expect(cache.has('live')).toBe(true);
    expect(cache.size).toBe(1);
  });

  it('exposes size for diagnostics', () => {
    const cache = new NonceCache(10);
    expect(cache.size).toBe(0);
    cache.add('x', 60);
    expect(cache.size).toBe(1);
  });

  it('produces distinct nonces per call', () => {
    const body = Buffer.alloc(0);
    const first = buildHmacHeaders({ secret: SECRET, method: 'GET', path: '/x', body });
    const second = buildHmacHeaders({ secret: SECRET, method: 'GET', path: '/x', body });
    expect(first[HMAC_NONCE_HEADER]).not.toBe(second[HMAC_NONCE_HEADER]);
    expect(first[HMAC_SIGNATURE_HEADER]).toMatch(/^[0-9a-f]{64}$/);
  });
});
