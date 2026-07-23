import { describe, expect, it, vi } from 'vitest';
import {
  appendInternalQuery,
  consumeTransaction,
  createRoutedState,
  normalizeInternalRedirect,
  readAppHint,
  isSecureRequest,
  storeTransaction,
} from '../security';
import type { OidcTransaction } from '../security';

type StoredValue = { value: unknown; ttl?: number };

function createContext() {
  const values = new Map<string, StoredValue>();
  const cookies = new Map<string, string>();
  const ctx = {
    app: {
      cache: {
        async set(key: string, value: unknown, ttl?: number) {
          values.set(key, { value, ttl });
        },
        async get<T>(key: string): Promise<T | undefined> {
          return values.get(key)?.value as T | undefined;
        },
        async del(key: string) {
          values.delete(key);
        },
      },
    },
    cookies: {
      set: vi.fn((key: string, value: string | null) => {
        if (value === null) cookies.delete(key);
        else cookies.set(key, value);
      }),
      get(key: string) {
        return cookies.get(key);
      },
    },
  };
  return { ctx, values, cookies };
}

describe('OIDC security helpers', () => {
  it('uses forwarded HTTPS when deciding whether cookies may be secure', () => {
    expect(isSecureRequest({ headers: { 'x-forwarded-proto': 'https' }, protocol: 'http' } as never)).toBe(true);
    expect(isSecureRequest({ headers: {}, protocol: 'http' } as never)).toBe(false);
  });
  it.each(['https://evil.example/capture', '//evil.example/capture', '/\\evil.example', 'javascript:alert(1)'])(
    'rejects an unsafe return URL: %s',
    (value) => {
      expect(normalizeInternalRedirect(value)).toBe('/admin');
    },
  );

  it('preserves a safe internal path and appends query without corrupting existing parameters', () => {
    expect(appendInternalQuery('/admin?page=1#details', { token: 'a&b' })).toBe('/admin?page=1&token=a%26b#details');
  });

  it('round-trips only valid application routing hints', () => {
    const state = createRoutedState('sub_app');
    expect(readAppHint(state)).toBe('sub_app');
    expect(readAppHint(`${Buffer.from('../bad').toString('base64url')}.state`)).toBeNull();
  });

  it('binds a one-time transaction to the browser cookie', async () => {
    const { ctx } = createContext();
    const transaction: OidcTransaction = {
      app: 'main',
      authenticator: 'company-oidc',
      browserBinding: 'browser-secret',
      codeVerifier: 'verifier',
      createdAt: Date.now(),
      nonce: 'nonce',
      redirectUri: 'https://nocobase.example/api/oidc:redirect',
      returnTo: '/admin',
      state: createRoutedState('main'),
    };
    await storeTransaction(ctx as never, transaction);

    expect(await consumeTransaction(ctx as never, transaction.state)).toEqual(transaction);
    expect(await consumeTransaction(ctx as never, transaction.state)).toBeNull();
  });

  it('rejects a transaction presented by a different browser', async () => {
    const { ctx, cookies } = createContext();
    const transaction: OidcTransaction = {
      app: 'main',
      authenticator: 'company-oidc',
      browserBinding: 'browser-secret',
      codeVerifier: 'verifier',
      createdAt: Date.now(),
      nonce: 'nonce',
      redirectUri: 'https://nocobase.example/api/oidc:redirect',
      returnTo: '/admin',
      state: createRoutedState('main'),
    };
    await storeTransaction(ctx as never, transaction);
    const cookieCalls = ctx.cookies.set.mock.calls;
    const cookieName = cookieCalls[0][0];
    cookies.set(cookieName, 'different-browser');

    expect(await consumeTransaction(ctx as never, transaction.state)).toBeNull();
  });
});
