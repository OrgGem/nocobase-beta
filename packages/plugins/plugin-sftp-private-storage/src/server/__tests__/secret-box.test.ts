import { vi } from 'vitest';
import {
  __resetSecretKeyCacheForTest,
  decryptSecret,
  decryptSecretIfNeeded,
  encryptSecret,
  encryptSecretIfPlain,
  getSecretKeyInfo,
  isEncrypted,
} from '../secret-box';

describe('secret-box', () => {
  beforeEach(() => {
    __resetSecretKeyCacheForTest();
    delete process.env.SFTP_STORAGE_SECRET_KEY;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('round-trips a secret through encrypt/decrypt', () => {
    const secret = 'p@ssw0rd-éàü-🔑';
    const encrypted = encryptSecret(secret);
    expect(encrypted).not.toEqual(secret);
    expect(isEncrypted(encrypted)).toBe(true);
    expect(decryptSecret(encrypted)).toEqual(secret);
  });

  it('produces different ciphertexts for the same plaintext (random IV)', () => {
    const a = encryptSecret('same-secret');
    const b = encryptSecret('same-secret');
    expect(a).not.toEqual(b);
    expect(decryptSecret(a)).toEqual('same-secret');
    expect(decryptSecret(b)).toEqual('same-secret');
  });

  it('passes plaintext values through unchanged (legacy compatibility)', () => {
    expect(decryptSecretIfNeeded('plain-password')).toEqual('plain-password');
    expect(decryptSecretIfNeeded('')).toEqual('');
    expect(decryptSecretIfNeeded(undefined)).toEqual(undefined);
    expect(encryptSecretIfPlain('')).toEqual('');
    expect(encryptSecretIfPlain(undefined)).toEqual(undefined);
  });

  it('does not double-encrypt already encrypted values', () => {
    const encrypted = encryptSecret('secret');
    expect(encryptSecretIfPlain(encrypted)).toEqual(encrypted);
  });

  it('uses SFTP_STORAGE_SECRET_KEY when provided', () => {
    process.env.SFTP_STORAGE_SECRET_KEY = 'my-deployment-key';
    const encrypted = encryptSecret('secret');
    expect(getSecretKeyInfo().ephemeral).toBe(false);

    // Same key can decrypt
    __resetSecretKeyCacheForTest();
    process.env.SFTP_STORAGE_SECRET_KEY = 'my-deployment-key';
    expect(decryptSecret(encrypted)).toEqual('secret');

    // A different key cannot decrypt (auth tag mismatch)
    __resetSecretKeyCacheForTest();
    process.env.SFTP_STORAGE_SECRET_KEY = 'another-key';
    expect(() => decryptSecret(encrypted)).toThrow();
  });

  it('rejects tampered ciphertext', () => {
    const encrypted = encryptSecret('secret');
    const parts = encrypted.split(':');
    parts[3] = Buffer.from('tampered-data').toString('base64');
    expect(() => decryptSecret(parts.join(':'))).toThrow();
  });

  it('throws on malformed encrypted payload', () => {
    expect(() => decryptSecret('enc:v1:not-enough-parts')).toThrow(/Invalid encrypted secret format/);
  });
});
