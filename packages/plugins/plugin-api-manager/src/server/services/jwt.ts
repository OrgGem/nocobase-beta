import { createHmac, createSign, createVerify, timingSafeEqual } from 'crypto';

export type JwtAlgorithm = 'RS256' | 'HS256';

export interface JwtClaims {
  [key: string]: unknown;
}

export interface JwtSignInput {
  algorithm: JwtAlgorithm;
  /** HS256 shared secret. */
  secret?: string;
  /** RS256 private key PEM. */
  privateKeyPem?: string;
  claims?: JwtClaims;
  issuer?: string;
  audience?: string;
  expiresInSec: number;
}

export interface JwtVerifyInput {
  token: string;
  algorithms: JwtAlgorithm[];
  /** HS256 shared secret. */
  secret?: string;
  /** RS256 public key PEM. */
  publicKeyPem?: string;
  issuer?: string;
  audience?: string;
}

function base64UrlEncode(data: Buffer): string {
  return data.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(data: string): Buffer {
  const padded = data.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, 'base64');
}

function signData(algorithm: JwtAlgorithm, signingInput: string, secret?: string, privateKeyPem?: string): string {
  if (algorithm === 'HS256') {
    if (!secret) throw new Error('HS256 signing requires a secret');
    return base64UrlEncode(createHmac('sha256', secret).update(signingInput, 'utf8').digest());
  }
  if (!privateKeyPem) throw new Error('RS256 signing requires a private key');
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput, 'utf8');
  signer.end();
  return base64UrlEncode(signer.sign(privateKeyPem));
}

/**
 * Signs a JWT (compact JWS) with RS256 or HS256 using node:crypto only.
 */
export function signJwt(input: JwtSignInput): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = { alg: input.algorithm, typ: 'JWT' };
  const payload: JwtClaims = {
    ...(input.claims ?? {}),
    iat: nowSec,
    exp: nowSec + input.expiresInSec,
  };
  if (input.issuer) payload.iss = input.issuer;
  if (input.audience) payload.aud = input.audience;

  const encodedHeader = base64UrlEncode(Buffer.from(JSON.stringify(header), 'utf8'));
  const encodedPayload = base64UrlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = signData(input.algorithm, signingInput, input.secret, input.privateKeyPem);
  return `${signingInput}.${signature}`;
}

/**
 * Verifies a JWT and returns its payload. Throws with a descriptive message on failure.
 */
export function verifyJwt(input: JwtVerifyInput): JwtClaims {
  const parts = input.token.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed JWT');
  }
  const [encodedHeader, encodedPayload, signature] = parts;

  let header: { alg?: unknown };
  let payload: JwtClaims;
  try {
    header = JSON.parse(base64UrlDecode(encodedHeader).toString('utf8')) as { alg?: unknown };
    payload = JSON.parse(base64UrlDecode(encodedPayload).toString('utf8')) as JwtClaims;
  } catch {
    throw new Error('Malformed JWT');
  }

  const alg = header.alg;
  if (typeof alg !== 'string' || !input.algorithms.includes(alg as JwtAlgorithm)) {
    throw new Error(`JWT algorithm "${String(alg)}" is not allowed`);
  }

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  if (alg === 'HS256') {
    if (!input.secret) throw new Error('HS256 verification requires a secret');
    const expected = base64UrlEncode(createHmac('sha256', input.secret).update(signingInput, 'utf8').digest());
    const expectedBuf = Buffer.from(expected, 'utf8');
    const actualBuf = Buffer.from(signature, 'utf8');
    if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
      throw new Error('JWT signature mismatch');
    }
  } else {
    if (!input.publicKeyPem) throw new Error('RS256 verification requires a public key');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(signingInput, 'utf8');
    verifier.end();
    let valid = false;
    try {
      valid = verifier.verify(input.publicKeyPem, base64UrlDecode(signature));
    } catch {
      valid = false;
    }
    if (!valid) throw new Error('JWT signature mismatch');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const exp = payload.exp;
  // A token without exp would remain valid forever, so the claim is mandatory.
  if (typeof exp !== 'number' || !Number.isFinite(exp)) {
    throw new Error('JWT is missing the exp claim');
  }
  if (exp < nowSec) {
    throw new Error('JWT has expired');
  }
  if (input.issuer && payload.iss !== input.issuer) {
    throw new Error('JWT issuer mismatch');
  }
  if (input.audience) {
    const aud = payload.aud;
    const audiences = Array.isArray(aud) ? aud : [aud];
    if (!audiences.includes(input.audience)) {
      throw new Error('JWT audience mismatch');
    }
  }

  return payload;
}
