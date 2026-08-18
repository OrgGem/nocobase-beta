import { createHash, randomBytes } from 'crypto';

export interface GeneratedApiKey {
  plaintext: string;
  keyHash: string;
  keyPrefix: string;
}

const KEY_PREFIX_DISPLAY_LENGTH = 12;

export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

export function generateApiKey(): GeneratedApiKey {
  const plaintext = `apim_${randomBytes(32).toString('base64url')}`;
  return {
    plaintext,
    keyHash: hashApiKey(plaintext),
    keyPrefix: plaintext.slice(0, KEY_PREFIX_DISPLAY_LENGTH),
  };
}
