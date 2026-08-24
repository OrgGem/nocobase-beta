import { createHmac, generateKeyPairSync } from 'crypto';
import { describe, expect, it } from 'vitest';
import { signJwt, verifyJwt } from '../services/jwt';

const { publicKey: rsaPublic, privateKey: rsaPrivate } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PUBLIC_PEM = rsaPublic.export({ type: 'spki', format: 'pem' }).toString();
const PRIVATE_PEM = rsaPrivate.export({ type: 'pkcs8', format: 'pem' }).toString();
const HS_SECRET = 'shared-hs256-secret';

function b64url(data: Buffer): string {
  return data.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Hand-builds an HS256 token so tests can craft payloads signJwt would never produce. */
function buildHs256Token(payload: Record<string, unknown>, secret: string = HS_SECRET): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'utf8'));
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signingInput = `${header}.${body}`;
  const signature = b64url(createHmac('sha256', secret).update(signingInput, 'utf8').digest());
  return `${signingInput}.${signature}`;
}

function decodeHeader(token: string): Record<string, unknown> {
  const [encodedHeader] = token.split('.');
  const padded = encodedHeader.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return JSON.parse(Buffer.from(padded + pad, 'base64').toString('utf8')) as Record<string, unknown>;
}

describe('jwt', () => {
  it('signs and verifies an RS256 token roundtrip', () => {
    const token = signJwt({
      algorithm: 'RS256',
      privateKeyPem: PRIVATE_PEM,
      claims: { sub: 'partner-1' },
      issuer: 'apim',
      audience: 'backend',
      expiresInSec: 300,
    });
    const payload = verifyJwt({
      token,
      algorithms: ['RS256'],
      publicKeyPem: PUBLIC_PEM,
      issuer: 'apim',
      audience: 'backend',
    });
    expect(payload.sub).toBe('partner-1');
    expect(payload.iss).toBe('apim');
    expect(payload.aud).toBe('backend');
    expect(typeof payload.exp).toBe('number');
    expect(typeof payload.iat).toBe('number');
  });

  it('signs and verifies an HS256 token roundtrip', () => {
    const token = signJwt({ algorithm: 'HS256', secret: HS_SECRET, expiresInSec: 60 });
    const payload = verifyJwt({ token, algorithms: ['HS256'], secret: HS_SECRET });
    expect(payload.exp).toBeGreaterThan(payload.iat as number);
  });

  it('rejects an expired token', () => {
    const token = signJwt({ algorithm: 'HS256', secret: HS_SECRET, expiresInSec: -10 });
    expect(() => verifyJwt({ token, algorithms: ['HS256'], secret: HS_SECRET })).toThrow(/expired/);
  });

  it('rejects a token without the exp claim', () => {
    const token = buildHs256Token({ sub: 'no-exp' });
    expect(() => verifyJwt({ token, algorithms: ['HS256'], secret: HS_SECRET })).toThrow(/missing the exp claim/);
  });

  it('rejects a token with a non-numeric exp claim', () => {
    const token = buildHs256Token({ sub: 'bad-exp', exp: '2099-01-01' });
    expect(() => verifyJwt({ token, algorithms: ['HS256'], secret: HS_SECRET })).toThrow(/missing the exp claim/);
  });

  it('rejects a tampered payload', () => {
    const token = signJwt({ algorithm: 'HS256', secret: HS_SECRET, claims: { role: 'user' }, expiresInSec: 60 });
    const [header, , signature] = token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ role: 'admin', exp: 9999999999 }))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const forged = `${header}.${forgedPayload}.${signature}`;
    expect(() => verifyJwt({ token: forged, algorithms: ['HS256'], secret: HS_SECRET })).toThrow(/signature mismatch/);
  });

  it('rejects a token whose nbf is in the future', () => {
    const token = signJwt({ algorithm: 'HS256', secret: HS_SECRET, expiresInSec: 60, notBeforeSec: 3600 });
    expect(() => verifyJwt({ token, algorithms: ['HS256'], secret: HS_SECRET })).toThrow(/not yet valid/);
  });

  it('accepts a token whose nbf is in the past', () => {
    const token = signJwt({ algorithm: 'HS256', secret: HS_SECRET, expiresInSec: 60, notBeforeSec: -10 });
    expect(() => verifyJwt({ token, algorithms: ['HS256'], secret: HS_SECRET })).not.toThrow();
  });

  it('rejects a token with a malformed nbf claim', () => {
    const token = buildHs256Token({ exp: Math.floor(Date.now() / 1000) + 300, nbf: 'soon' });
    expect(() => verifyJwt({ token, algorithms: ['HS256'], secret: HS_SECRET })).toThrow(/invalid nbf/);
  });

  it('writes kid into the JOSE header and verifies it', () => {
    const token = signJwt({ algorithm: 'HS256', secret: HS_SECRET, expiresInSec: 60, keyId: 'key-1' });
    expect(decodeHeader(token).kid).toBe('key-1');
    expect(() => verifyJwt({ token, algorithms: ['HS256'], secret: HS_SECRET, expectedKeyId: 'key-1' })).not.toThrow();
    expect(() => verifyJwt({ token, algorithms: ['HS256'], secret: HS_SECRET, expectedKeyId: 'key-2' })).toThrow(
      /key id mismatch/,
    );
  });

  it('accepts tokens without a kid when none is expected', () => {
    const token = signJwt({ algorithm: 'HS256', secret: HS_SECRET, expiresInSec: 60 });
    expect(() => verifyJwt({ token, algorithms: ['HS256'], secret: HS_SECRET })).not.toThrow();
  });

  it('rejects a wrong issuer', () => {
    const token = signJwt({ algorithm: 'HS256', secret: HS_SECRET, issuer: 'apim', expiresInSec: 60 });
    expect(() => verifyJwt({ token, algorithms: ['HS256'], secret: HS_SECRET, issuer: 'other' })).toThrow(/issuer/);
  });

  it('rejects a wrong audience', () => {
    const token = signJwt({ algorithm: 'HS256', secret: HS_SECRET, audience: 'backend', expiresInSec: 60 });
    expect(() => verifyJwt({ token, algorithms: ['HS256'], secret: HS_SECRET, audience: 'frontend' })).toThrow(
      /audience/,
    );
  });

  it('rejects a disallowed algorithm', () => {
    const token = signJwt({ algorithm: 'HS256', secret: HS_SECRET, expiresInSec: 60 });
    expect(() => verifyJwt({ token, algorithms: ['RS256'], publicKeyPem: PUBLIC_PEM })).toThrow(/not allowed/);
  });

  it('rejects a malformed token', () => {
    expect(() => verifyJwt({ token: 'not-a-jwt', algorithms: ['HS256'], secret: HS_SECRET })).toThrow(/Malformed/);
  });

  it('rejects an RS256 token verified with the wrong key', () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const otherPublic = other.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const token = signJwt({ algorithm: 'RS256', privateKeyPem: PRIVATE_PEM, expiresInSec: 60 });
    expect(() => verifyJwt({ token, algorithms: ['RS256'], publicKeyPem: otherPublic })).toThrow(/signature mismatch/);
  });

  it('HS256 signing requires a secret', () => {
    expect(() => signJwt({ algorithm: 'HS256', expiresInSec: 60 })).toThrow(/secret/);
  });

  it('RS256 signing requires a private key', () => {
    expect(() => signJwt({ algorithm: 'RS256', expiresInSec: 60 })).toThrow(/private key/);
  });
});
