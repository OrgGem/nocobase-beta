import { sign, verify } from 'crypto';

import { canonicalJson } from './canonical-json';

function configuredPublicKeys(activeKeyId: string, fallback: string | undefined): Map<string, string> {
  const keys = new Map<string, string>();
  const raw = process.env.SKILL_REGISTRY_SIGNING_PUBLIC_KEYS;
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        for (const [keyId, publicKey] of Object.entries(parsed)) {
          if (typeof publicKey === 'string' && publicKey.trim()) {
            keys.set(keyId, publicKey);
          }
        }
      }
    } catch {
      // An invalid optional key ring cannot make the active key unusable.
    }
  }
  if (fallback) {
    keys.set(activeKeyId, fallback);
  }
  return keys;
}

export class SignatureService {
  private readonly privateKey = process.env.SKILL_REGISTRY_SIGNING_PRIVATE_KEY;
  private readonly publicKey = process.env.SKILL_REGISTRY_SIGNING_PUBLIC_KEY || this.privateKey;
  readonly keyId = process.env.SKILL_REGISTRY_SIGNING_KEY_ID || 'unconfigured';
  private readonly publicKeys = configuredPublicKeys(this.keyId, this.publicKey);
  private readonly advertisedPublicKeys = configuredPublicKeys(
    this.keyId,
    process.env.SKILL_REGISTRY_SIGNING_PUBLIC_KEY,
  );

  publicKeyRing(): Record<string, string> {
    return Object.fromEntries(this.advertisedPublicKeys);
  }

  isSigningEnabled(): boolean {
    return Boolean(this.privateKey);
  }

  signEnvelope(input: {
    packageName: string;
    version: string;
    manifestDigest: string;
    artifactDigest: string;
  }): string | null {
    if (!this.privateKey) {
      return null;
    }
    const content = Buffer.from(canonicalJson(input), 'utf8');
    return sign(null, content, this.privateKey).toString('base64');
  }

  verifyEnvelope(
    input: { packageName: string; version: string; manifestDigest: string; artifactDigest: string },
    signature: string,
    keyId = this.keyId,
  ): boolean {
    const publicKey = this.publicKeys.get(keyId);
    if (!publicKey) {
      return false;
    }
    try {
      return verify(null, Buffer.from(canonicalJson(input), 'utf8'), publicKey, Buffer.from(signature, 'base64'));
    } catch {
      return false;
    }
  }
}
