import { createHash, createPrivateKey, createPublicKey, randomBytes, X509Certificate } from 'crypto';
import { describe, expect, it } from 'vitest';
import * as sshpk from 'sshpk';
import { generateRawKeyPair, privateKeyFromPem, publicKeyFromPem } from '../services/crypto-core';
import { detectKeyMaterial, KeyFormatError } from '../services/key-format-detect';

// Note: PGP armored + binary detection paths are exercised by the integration smoke
// test (real NocoBase server runtime), not by this unit test. openpgp v5.x breaks under
// vite-node's VM-context transformation in this Windows toolchain (TextEncoder /
// Uint8Array realm mismatch in @openpgp/web-stream-tools), but the same detection code
// runs cleanly when the plugin is loaded by the NocoBase server. To keep the module
// importable from tests that don't need openpgp, the openpgp/sshpk imports are lazy.

function sha256HexOf(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function pemToOpenSshPublic(pem: string): string {
  return sshpk.parseKey(pem, 'pem').toString('ssh');
}

function pemToOpenSshPrivate(pem: string): string {
  return sshpk.parsePrivateKey(pem, 'pem').toString('openssh');
}

function selfSignedCertPem(pemPriv: string): string {
  const key = sshpk.parsePrivateKey(pemPriv, 'pem');
  const subject = sshpk.Identity.forHost('test.example.com');
  const cert = sshpk.createSelfSignedCertificate(subject, key, {
    lifetime: 86400,
    serial: randomBytes(16),
  });
  return cert.toString('pem');
}

function selfSignedCertDer(pemPriv: string): Buffer {
  const key = sshpk.parsePrivateKey(pemPriv, 'pem');
  const subject = sshpk.Identity.forHost('test.example.com');
  const cert = sshpk.createSelfSignedCertificate(subject, key, {
    lifetime: 86400,
    serial: randomBytes(16),
  });
  return cert.toBuffer('x509');
}

function csrPem(): string {
  // Minimal CSR marker — detection only matches the BEGIN line; no full parse required.
  return [
    '-----BEGIN CERTIFICATE REQUEST-----',
    'MIIBhDCB7gIBADAdMQswCQYDVQQGEwJVUzEOMAwGA1UEAwwFdGVzdDEwgZ8wDQYJ',
    'KoZIhvcNAQEBBQADgY0AMIGJAoGBALRVK4cCz1ySsDG9v3yLsXKwSM1K8GtnPMdI',
    '3V3vfRYqJvmTQrZ8Y5wD2kJvtmXzqJxLk3m5YQ7p4+U5lB+QYjzKqfHZrGQb0VK',
    '3tRkPjrQp+v2G7YZpYJ6pXrR5L3Y4mCQz5j4Q5ZJ7V3lJsM5KQq7tRkPjrQp+v2G',
    '7YZpYJ6pXrR5L3Y4mCQz5j4Q5ZJ7V3lJsM5KQq7tRkPjrQp+v2G7YZpYJ6pXrR5',
    '-----END CERTIFICATE REQUEST-----',
    '',
  ].join('\n');
}

describe('detectKeyMaterial — PEM text', () => {
  it('detects PEM public keys', async () => {
    const pem = generateRawKeyPair('ed25519').publicPem;
    const detected = await detectKeyMaterial(pem);
    expect(detected.format).toBe('pem');
    expect(detected.kind).toBe('public-key');
    expect(detected.algorithm).toBe('ed25519');
    expect(detected.publicKey?.asymmetricKeyType).toBe('ed25519');
    expect(detected.canonicalPublic).toContain('-----BEGIN PUBLIC KEY-----');
    expect(detected.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('detects PEM private keys and exposes the derived public key', async () => {
    const pair = generateRawKeyPair('rsa-4096');
    const detected = await detectKeyMaterial(pair.privatePem);
    expect(detected.format).toBe('pem');
    expect(detected.kind).toBe('private-key');
    expect(detected.privateKey).toBeDefined();
    expect(detected.publicKey?.asymmetricKeyDetails?.modulusLength).toBe(4096);

    const expectedDer = publicKeyFromPem(pair.publicPem).export({ type: 'spki', format: 'der' });
    expect(detected.fingerprint).toBe(sha256HexOf(Buffer.from(expectedDer)));
  });
});

describe('detectKeyMaterial — DER binary', () => {
  it('detects DER SPKI public key', async () => {
    const pair = generateRawKeyPair('ed25519');
    const der = publicKeyFromPem(pair.publicPem).export({ type: 'spki', format: 'der' });
    const detected = await detectKeyMaterial(Buffer.from(der));
    expect(detected.format).toBe('der');
    expect(detected.kind).toBe('public-key');
    expect(detected.canonicalPublic).toContain('-----BEGIN PUBLIC KEY-----');
  });

  it('detects DER PKCS8 private key and derives the matching public key', async () => {
    const pair = generateRawKeyPair('ed25519');
    const der = privateKeyFromPem(pair.privatePem).export({ type: 'pkcs8', format: 'der' });
    const detected = await detectKeyMaterial(Buffer.from(der));
    expect(detected.format).toBe('der');
    expect(detected.kind).toBe('private-key');
    expect(detected.publicKey?.asymmetricKeyType).toBe('ed25519');
  });
});

describe('detectKeyMaterial — OpenSSH', () => {
  it('detects OpenSSH public-key lines', async () => {
    const pair = generateRawKeyPair('ed25519');
    const openssh = pemToOpenSshPublic(pair.publicPem);
    expect(openssh.startsWith('ssh-ed25519 ')).toBe(true);
    const detected = await detectKeyMaterial(openssh);
    expect(detected.format).toBe('openssh');
    expect(detected.kind).toBe('ssh-public');
    expect(detected.canonicalPublic).toBe(openssh);
    expect(detected.fingerprint).toMatch(/^SHA256:/);
  });

  it('detects OpenSSH private-key format', async () => {
    const pair = generateRawKeyPair('ed25519');
    const opensshPriv = pemToOpenSshPrivate(pair.privatePem);
    expect(opensshPriv.includes('-----BEGIN OPENSSH PRIVATE KEY-----')).toBe(true);
    const detected = await detectKeyMaterial(opensshPriv);
    expect(detected.format).toBe('openssh');
    expect(detected.kind).toBe('ssh-private');
    expect(detected.canonicalPublic).toMatch(/^ssh-/);
  });
});

describe('detectKeyMaterial — X.509 / CSR', () => {
  it('detects X.509 certificate PEM', async () => {
    const pair = generateRawKeyPair('ed25519');
    const certPem = selfSignedCertPem(pair.privatePem);
    const detected = await detectKeyMaterial(certPem);
    expect(detected.format).toBe('pem');
    expect(detected.kind).toBe('certificate');
    expect(detected.publicKey?.asymmetricKeyType).toBe('ed25519');
    expect(detected.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('detects X.509 certificate DER', async () => {
    const pair = generateRawKeyPair('ed25519');
    const certDer = selfSignedCertDer(pair.privatePem);
    const detected = await detectKeyMaterial(certDer);
    expect(detected.format).toBe('der');
    expect(detected.kind).toBe('certificate');
    expect(detected.publicKey?.asymmetricKeyType).toBe('ed25519');
    expect(new X509Certificate(certDer).publicKey.asymmetricKeyType).toBe('ed25519');
  });

  it('detects a CSR marker (does not fully parse)', async () => {
    const csr = csrPem();
    expect(csr.includes('-----BEGIN CERTIFICATE REQUEST-----')).toBe(true);
    const detected = await detectKeyMaterial(csr);
    expect(detected.format).toBe('pem');
    expect(detected.kind).toBe('csr');
  });
});

describe('detectKeyMaterial — failure cases', () => {
  it('throws KeyFormatError on garbage text', async () => {
    await expect(detectKeyMaterial('this is just a comment, not a key')).rejects.toBeInstanceOf(KeyFormatError);
  });

  it('throws KeyFormatError on garbage binary', async () => {
    const garbage = Buffer.from('not-a-key-of-any-kind-just-bytes-here-padding');
    await expect(detectKeyMaterial(garbage)).rejects.toBeInstanceOf(KeyFormatError);
  });

  it('throws KeyFormatError on empty input', async () => {
    await expect(detectKeyMaterial('')).rejects.toBeInstanceOf(KeyFormatError);
  });
});

describe('detectKeyMaterial — invariants', () => {
  it('canonical public for a detected private material round-trips', async () => {
    const pair = generateRawKeyPair('rsa-4096');
    const detected = await detectKeyMaterial(pair.privatePem);
    expect(detected.canonicalPublic).toBeDefined();
    const reImported = createPublicKey(String(detected.canonicalPublic));
    const der = (reImported as ReturnType<typeof createPublicKey>).export({
      type: 'spki',
      format: 'der',
    });
    expect(detected.fingerprint).toBe(sha256HexOf(Buffer.from(der)));
  });

  it('createPrivateKey + createPublicKey round-trip agrees on key type', () => {
    const pair = generateRawKeyPair('rsa-4096');
    const priv = createPrivateKey(pair.privatePem);
    const pub = createPublicKey(priv);
    expect(pub.asymmetricKeyDetails?.modulusLength).toBe(4096);
  });
});
