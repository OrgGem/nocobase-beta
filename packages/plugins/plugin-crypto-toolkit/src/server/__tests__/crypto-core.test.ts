import { describe, expect, it } from 'vitest';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  fingerprintPublicKey,
  generateRawKeyPair,
  normalizeAesKey,
  privateKeyFromPem,
  publicKeyFromPem,
  sha256Hex,
  signDetached,
  verifyDetached,
} from '../services/crypto-core';
import { randomBytes } from 'crypto';

describe('generateRawKeyPair', () => {
  it('generates an Ed25519 pair exportable as PEM', () => {
    const pair = generateRawKeyPair('ed25519');
    expect(pair.publicPem).toContain('-----BEGIN PUBLIC KEY-----');
    expect(pair.privatePem).toContain('-----BEGIN PRIVATE KEY-----');
    expect(publicKeyFromPem(pair.publicPem).asymmetricKeyType).toBe('ed25519');
    expect(privateKeyFromPem(pair.privatePem).asymmetricKeyType).toBe('ed25519');
  });

  it('generates an RSA-4096 pair', () => {
    const pair = generateRawKeyPair('rsa-4096');
    expect(publicKeyFromPem(pair.publicPem).asymmetricKeyDetails?.modulusLength).toBe(4096);
  });

  it('produces stable fingerprints for the same key', () => {
    const pair = generateRawKeyPair('ed25519');
    expect(fingerprintPublicKey(pair.publicKey)).toBe(fingerprintPublicKey(publicKeyFromPem(pair.publicPem)));
    expect(fingerprintPublicKey(pair.publicKey)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('sha256Hex', () => {
  it('matches the known NIST vector for "abc"', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('aesGcm round-trip', () => {
  const plaintext = Buffer.from('confidential file content éèỳ', 'utf8');

  it('round-trips with a raw 32-byte key', () => {
    const key = randomBytes(32);
    const box = aesGcmEncrypt(plaintext, { key });
    expect(box.subarray(0, 4).toString('ascii')).toBe('NCB1');
    expect(aesGcmDecrypt(box, { key }).equals(plaintext)).toBe(true);
  });

  it('round-trips with a passphrase (scrypt-derived key)', () => {
    const box = aesGcmEncrypt(plaintext, { passphrase: 'correct horse battery staple' });
    expect(aesGcmDecrypt(box, { passphrase: 'correct horse battery staple' }).equals(plaintext)).toBe(true);
  });

  it('rejects tampered ciphertext', () => {
    const key = randomBytes(32);
    const box = aesGcmEncrypt(plaintext, { key });
    box[box.length - 1] ^= 0xff;
    expect(() => aesGcmDecrypt(box, { key })).toThrow();
  });

  it('rejects the wrong passphrase', () => {
    const box = aesGcmEncrypt(plaintext, { passphrase: 'right' });
    expect(() => aesGcmDecrypt(box, { passphrase: 'wrong' })).toThrow();
  });

  it('rejects non-container payloads and mismatched secret modes', () => {
    expect(() => aesGcmDecrypt(Buffer.from('garbage-data-here'), { passphrase: 'x' })).toThrow(/NCB1|too short/);
    const box = aesGcmEncrypt(plaintext, { passphrase: 'p' });
    expect(() => aesGcmDecrypt(box, { key: randomBytes(32) })).toThrow(/passphrase/);
  });

  it('normalizes base64 keys and rejects wrong sizes', () => {
    const key = randomBytes(32);
    expect(normalizeAesKey(key.toString('base64')).equals(key)).toBe(true);
    expect(() => normalizeAesKey(randomBytes(16))).toThrow(/32 bytes/);
  });
});

describe('detached signatures', () => {
  const data = Buffer.from('payload to sign');

  it('round-trips Ed25519', () => {
    const pair = generateRawKeyPair('ed25519');
    const sig = signDetached(data, 'ed25519', pair.privateKey);
    expect(verifyDetached(data, sig, 'ed25519', pair.publicKey)).toBe(true);
  });

  it('round-trips RSA-PSS-SHA256', () => {
    const pair = generateRawKeyPair('rsa-4096');
    const sig = signDetached(data, 'rsa-pss-sha256', pair.privateKey);
    expect(verifyDetached(data, sig, 'rsa-pss-sha256', pair.publicKey)).toBe(true);
  });

  it('fails verification with the wrong key or tampered data', () => {
    const pair = generateRawKeyPair('ed25519');
    const other = generateRawKeyPair('ed25519');
    const sig = signDetached(data, 'ed25519', pair.privateKey);
    expect(verifyDetached(data, sig, 'ed25519', other.publicKey)).toBe(false);
    expect(verifyDetached(Buffer.from('tampered'), sig, 'ed25519', pair.publicKey)).toBe(false);
  });
});
