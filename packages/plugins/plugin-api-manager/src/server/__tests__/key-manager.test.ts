import { describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { generateApiKey, hashApiKey } from '../services/key-manager';

describe('key-manager', () => {
  it('generates keys with the apim_ prefix', () => {
    const { plaintext } = generateApiKey();
    expect(plaintext.startsWith('apim_')).toBe(true);
    expect(plaintext.length).toBeGreaterThan(20);
  });

  it('hashes with sha256 hex', () => {
    const { plaintext, keyHash } = generateApiKey();
    expect(keyHash).toBe(createHash('sha256').update(plaintext).digest('hex'));
    expect(keyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('exposes the first 12 characters as keyPrefix', () => {
    const { plaintext, keyPrefix } = generateApiKey();
    expect(keyPrefix).toBe(plaintext.slice(0, 12));
    expect(keyPrefix).toHaveLength(12);
  });

  it('generates distinct keys and hashes', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.keyHash).not.toBe(b.keyHash);
  });

  it('hashApiKey is deterministic', () => {
    expect(hashApiKey('apim_fixed')).toBe(hashApiKey('apim_fixed'));
    expect(hashApiKey('apim_one')).not.toBe(hashApiKey('apim_two'));
  });
});
