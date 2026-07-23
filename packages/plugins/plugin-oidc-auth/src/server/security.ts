import { timingSafeEqual } from 'crypto';
import type { Context } from '@nocobase/actions';
import { randomState } from 'openid-client';

export const OIDC_TRANSACTION_TTL = 10 * 60 * 1000;

export type OidcTransaction = {
  app: string;
  authenticator: string;
  browserBinding: string;
  codeVerifier: string;
  createdAt: number;
  nonce: string;
  redirectUri: string;
  returnTo: string;
  state: string;
};

function transactionKey(state: string) {
  return `oidc-plus:transaction:${state}`;
}

export function normalizeInternalRedirect(value: unknown, fallback = '/admin') {
  if (typeof value !== 'string' || !value) return fallback;
  const hasControlCharacter = Array.from(value).some((character) => character.charCodeAt(0) < 32);
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || hasControlCharacter) {
    return fallback;
  }
  const url = new URL(value, 'https://nocobase.invalid');
  if (url.origin !== 'https://nocobase.invalid') return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}

export function appendInternalQuery(path: string, values: Record<string, string>) {
  const url = new URL(normalizeInternalRedirect(path), 'https://nocobase.invalid');
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function createRoutedState(appName: string) {
  const appHint = Buffer.from(appName, 'utf8').toString('base64url');
  return `${appHint}.${randomState()}`;
}

export function readAppHint(state: string | null) {
  if (!state) return null;
  try {
    const [encoded] = state.split('.', 1);
    const appName = Buffer.from(encoded, 'base64url').toString('utf8');
    return /^[a-zA-Z0-9_-]{1,64}$/.test(appName) ? appName : null;
  } catch {
    return null;
  }
}

export function transactionCookieName(state: string) {
  return `oidc_plus_tx_${state.replace(/[^a-zA-Z0-9]/g, '').slice(-32)}`;
}

export function isSecureRequest(ctx: Pick<Context, 'headers' | 'protocol'> & { secure?: boolean }) {
  // Koa validates the `secure` cookie option against ctx.secure. Prefer that
  // value so a missing proxy trust configuration never causes a 500 response.
  if (typeof ctx.secure === 'boolean') return ctx.secure;
  const forwardedProto = ctx.headers?.['x-forwarded-proto'];
  const protocol = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto || ctx.protocol;
  return protocol === 'https';
}

export async function storeTransaction(ctx: Context, transaction: OidcTransaction) {
  await ctx.app.cache.set(transactionKey(transaction.state), transaction, OIDC_TRANSACTION_TTL);
  ctx.cookies.set(transactionCookieName(transaction.state), transaction.browserBinding, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(ctx),
    maxAge: OIDC_TRANSACTION_TTL,
    overwrite: true,
  });
}

function equalSecret(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export async function consumeTransaction(ctx: Context, state: string) {
  const key = transactionKey(state);
  const transaction = await ctx.app.cache.get<OidcTransaction>(key);
  await ctx.app.cache.del(key);
  const cookieName = transactionCookieName(state);
  const browserBinding = ctx.cookies.get(cookieName);
  ctx.cookies.set(cookieName, null, { overwrite: true });
  if (!transaction || transaction.state !== state || !browserBinding) return null;
  if (!equalSecret(browserBinding, transaction.browserBinding)) return null;
  if (Date.now() - transaction.createdAt > OIDC_TRANSACTION_TTL) return null;
  return transaction;
}

export function logoutIdTokenCookieName(authenticator: string) {
  return `oidc_plus_id_${authenticator.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40)}`;
}
