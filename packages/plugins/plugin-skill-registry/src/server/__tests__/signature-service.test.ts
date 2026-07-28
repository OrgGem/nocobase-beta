import { generateKeyPairSync } from 'crypto';

import { SignatureService } from '../services/signature-service';

describe('SignatureService', () => {
  const originalPrivateKey = process.env.SKILL_REGISTRY_SIGNING_PRIVATE_KEY;
  const originalPublicKey = process.env.SKILL_REGISTRY_SIGNING_PUBLIC_KEY;
  const originalKeyId = process.env.SKILL_REGISTRY_SIGNING_KEY_ID;
  const originalPublicKeys = process.env.SKILL_REGISTRY_SIGNING_PUBLIC_KEYS;

  afterEach(() => {
    if (originalPrivateKey === undefined) {
      delete process.env.SKILL_REGISTRY_SIGNING_PRIVATE_KEY;
    } else {
      process.env.SKILL_REGISTRY_SIGNING_PRIVATE_KEY = originalPrivateKey;
    }
    if (originalPublicKey === undefined) {
      delete process.env.SKILL_REGISTRY_SIGNING_PUBLIC_KEY;
    } else {
      process.env.SKILL_REGISTRY_SIGNING_PUBLIC_KEY = originalPublicKey;
    }
    if (originalKeyId === undefined) {
      delete process.env.SKILL_REGISTRY_SIGNING_KEY_ID;
    } else {
      process.env.SKILL_REGISTRY_SIGNING_KEY_ID = originalKeyId;
    }
    if (originalPublicKeys === undefined) {
      delete process.env.SKILL_REGISTRY_SIGNING_PUBLIC_KEYS;
    } else {
      process.env.SKILL_REGISTRY_SIGNING_PUBLIC_KEYS = originalPublicKeys;
    }
  });

  it('verifies a signed immutable artifact envelope', () => {
    const keys = generateKeyPairSync('ed25519');
    process.env.SKILL_REGISTRY_SIGNING_PRIVATE_KEY = keys.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
    process.env.SKILL_REGISTRY_SIGNING_PUBLIC_KEY = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const signatureService = new SignatureService();
    const envelope = {
      packageName: 'acme/report',
      version: '1.0.0',
      manifestDigest: `sha256:${'a'.repeat(64)}`,
      artifactDigest: `sha256:${'b'.repeat(64)}`,
    };
    const signature = signatureService.signEnvelope(envelope);

    expect(signature).toBeTruthy();
    expect(signatureService.verifyEnvelope(envelope, signature || '')).toBe(true);
    expect(signatureService.verifyEnvelope({ ...envelope, version: '1.0.1' }, signature || '')).toBe(false);
  });

  it('verifies an existing artifact after the active signing key rotates', () => {
    const oldKeys = generateKeyPairSync('ed25519');
    const newKeys = generateKeyPairSync('ed25519');
    const oldPrivateKey = oldKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const oldPublicKey = oldKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const newPrivateKey = newKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const newPublicKey = newKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const envelope = {
      packageName: 'acme/report',
      version: '1.0.0',
      manifestDigest: `sha256:${'a'.repeat(64)}`,
      artifactDigest: `sha256:${'b'.repeat(64)}`,
    };

    process.env.SKILL_REGISTRY_SIGNING_PRIVATE_KEY = oldPrivateKey;
    process.env.SKILL_REGISTRY_SIGNING_PUBLIC_KEY = oldPublicKey;
    process.env.SKILL_REGISTRY_SIGNING_KEY_ID = 'key-2026-07';
    const oldSignature = new SignatureService().signEnvelope(envelope);

    process.env.SKILL_REGISTRY_SIGNING_PRIVATE_KEY = newPrivateKey;
    process.env.SKILL_REGISTRY_SIGNING_PUBLIC_KEY = newPublicKey;
    process.env.SKILL_REGISTRY_SIGNING_KEY_ID = 'key-2026-08';
    process.env.SKILL_REGISTRY_SIGNING_PUBLIC_KEYS = JSON.stringify({
      'key-2026-07': oldPublicKey,
      'key-2026-08': newPublicKey,
    });
    const rotatedSignatureService = new SignatureService();

    expect(rotatedSignatureService.verifyEnvelope(envelope, oldSignature || '', 'key-2026-07')).toBe(true);
    expect(rotatedSignatureService.publicKeyRing()).toEqual({
      'key-2026-07': oldPublicKey,
      'key-2026-08': newPublicKey,
    });
  });

  it('never advertises the private signing key when a public key is not configured', () => {
    const keys = generateKeyPairSync('ed25519');
    process.env.SKILL_REGISTRY_SIGNING_PRIVATE_KEY = keys.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
    delete process.env.SKILL_REGISTRY_SIGNING_PUBLIC_KEY;
    delete process.env.SKILL_REGISTRY_SIGNING_PUBLIC_KEYS;
    process.env.SKILL_REGISTRY_SIGNING_KEY_ID = 'private-only';

    expect(new SignatureService().publicKeyRing()).toEqual({});
  });
});
