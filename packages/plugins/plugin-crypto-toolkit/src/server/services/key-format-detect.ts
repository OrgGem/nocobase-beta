import { createPrivateKey, createPublicKey, KeyObject, X509Certificate } from 'crypto';
// openpgp and sshpk are loaded lazily inside detectFromText/detectFromBinary so that
// importing this module does not eagerly evaluate heavy crypto bundles (openpgp v5
// breaks under vite-node's VM-context transformation on this toolchain).
import type * as openpgp from 'openpgp';
import type * as sshpk from 'sshpk';

export type DetectedFormat = 'pem' | 'der' | 'pgp-armored' | 'pgp-binary' | 'openssh';

export type DetectedKind =
  | 'public-key'
  | 'private-key'
  | 'certificate'
  | 'csr'
  | 'pgp-public'
  | 'pgp-private'
  | 'ssh-public'
  | 'ssh-private';

export interface DetectedKeyMaterial {
  format: DetectedFormat;
  kind: DetectedKind;
  algorithm?: string;
  encrypted?: boolean;
  publicKey?: KeyObject;
  privateKey?: KeyObject;
  pgpKey?: openpgp.Key;
  sshKey?: sshpk.Key | sshpk.PrivateKey;
  /** Normalized public material: SPKI PEM, PGP armored block or OpenSSH line. */
  canonicalPublic?: string;
  fingerprint?: string;
}

export class KeyFormatError extends Error {
  constructor(message?: string) {
    super(message ?? 'Unrecognized key material: expected PEM, DER, OpenPGP (armored or binary) or OpenSSH format.');
    this.name = 'KeyFormatError';
  }
}

function sha256HexOf(data: Buffer): string {
  // local import to avoid a cycle with crypto-core consumers
  const { createHash } = require('crypto') as typeof import('crypto');
  return createHash('sha256').update(data).digest('hex');
}

function spkiPem(publicKey: KeyObject): string {
  return publicKey.export({ type: 'spki', format: 'pem' }).toString();
}

function fingerprintOf(publicKey: KeyObject): string {
  return sha256HexOf(publicKey.export({ type: 'spki', format: 'der' }) as Buffer);
}

function looksLikeText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 512));
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 0x09) return false;
  }
  return true;
}

async function detectFromText(text: string): Promise<DetectedKeyMaterial | undefined> {
  const trimmed = text.trim();

  if (/-----BEGIN PGP (PUBLIC|PRIVATE) KEY BLOCK-----/.test(trimmed)) {
    const openpgp = (await import('openpgp')) as typeof import('openpgp');
    const pgpKey = await openpgp.readKey({ armoredKey: trimmed });
    const isPrivate = pgpKey.isPrivate();
    const info = pgpKey.getAlgorithmInfo();
    return {
      format: 'pgp-armored',
      kind: isPrivate ? 'pgp-private' : 'pgp-public',
      algorithm: info.curve ?? info.algorithm,
      pgpKey,
      canonicalPublic: pgpKey.toPublic().armor(),
      fingerprint: pgpKey.getFingerprint(),
    };
  }

  if (trimmed.includes('-----BEGIN CERTIFICATE-----')) {
    const cert = new X509Certificate(trimmed);
    return {
      format: 'pem',
      kind: 'certificate',
      algorithm: cert.publicKey.asymmetricKeyType,
      publicKey: cert.publicKey,
      canonicalPublic: spkiPem(cert.publicKey),
      fingerprint: fingerprintOf(cert.publicKey),
    };
  }

  if (trimmed.includes('-----BEGIN CERTIFICATE REQUEST-----')) {
    return { format: 'pem', kind: 'csr' };
  }

  if (trimmed.includes('-----BEGIN OPENSSH PRIVATE KEY-----')) {
    const sshpk = (await import('sshpk')) as typeof import('sshpk');
    const sshKey = sshpk.parsePrivateKey(trimmed, 'ssh-private');
    return {
      format: 'openssh',
      kind: 'ssh-private',
      algorithm: sshKey.type,
      sshKey,
      canonicalPublic: sshKey.toPublic().toString('ssh'),
      fingerprint: sshKey.toPublic().fingerprint('sha256').toString(),
    };
  }

  if (/-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(trimmed)) {
    return { format: 'pem', kind: 'private-key', encrypted: true };
  }

  if (/-----BEGIN( [A-Z0-9]+)? PRIVATE KEY-----/.test(trimmed)) {
    const privateKey = createPrivateKey(trimmed);
    const publicKey = createPublicKey(privateKey);
    return {
      format: 'pem',
      kind: 'private-key',
      algorithm: privateKey.asymmetricKeyType,
      privateKey,
      publicKey,
      canonicalPublic: spkiPem(publicKey),
      fingerprint: fingerprintOf(publicKey),
    };
  }

  if (/-----BEGIN( [A-Z0-9]+)? PUBLIC KEY-----/.test(trimmed)) {
    const publicKey = createPublicKey(trimmed);
    return {
      format: 'pem',
      kind: 'public-key',
      algorithm: publicKey.asymmetricKeyType,
      publicKey,
      canonicalPublic: spkiPem(publicKey),
      fingerprint: fingerprintOf(publicKey),
    };
  }

  if (/^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-[a-z0-9-]+)\s/.test(trimmed)) {
    const sshpk = (await import('sshpk')) as typeof import('sshpk');
    const sshKey = sshpk.parseKey(trimmed, 'ssh');
    return {
      format: 'openssh',
      kind: 'ssh-public',
      algorithm: sshKey.type,
      sshKey,
      canonicalPublic: sshKey.toString('ssh'),
      fingerprint: sshKey.fingerprint('sha256').toString(),
    };
  }

  return undefined;
}

async function detectFromBinary(buffer: Buffer): Promise<DetectedKeyMaterial | undefined> {
  try {
    const publicKey = createPublicKey({ key: buffer, format: 'der', type: 'spki' });
    return {
      format: 'der',
      kind: 'public-key',
      algorithm: publicKey.asymmetricKeyType,
      publicKey,
      canonicalPublic: spkiPem(publicKey),
      fingerprint: fingerprintOf(publicKey),
    };
  } catch {
    // fall through
  }

  try {
    const privateKey = createPrivateKey({ key: buffer, format: 'der', type: 'pkcs8' });
    const publicKey = createPublicKey(privateKey);
    return {
      format: 'der',
      kind: 'private-key',
      algorithm: privateKey.asymmetricKeyType,
      privateKey,
      publicKey,
      canonicalPublic: spkiPem(publicKey),
      fingerprint: fingerprintOf(publicKey),
    };
  } catch {
    // fall through
  }

  try {
    const cert = new X509Certificate(buffer);
    return {
      format: 'der',
      kind: 'certificate',
      algorithm: cert.publicKey.asymmetricKeyType,
      publicKey: cert.publicKey,
      canonicalPublic: spkiPem(cert.publicKey),
      fingerprint: fingerprintOf(cert.publicKey),
    };
  } catch {
    // fall through
  }

  try {
    const openpgp = (await import('openpgp')) as typeof import('openpgp');
    const pgpKey = await openpgp.readKey({ binaryKey: new Uint8Array(buffer) });
    const info = pgpKey.getAlgorithmInfo();
    return {
      format: 'pgp-binary',
      kind: pgpKey.isPrivate() ? 'pgp-private' : 'pgp-public',
      algorithm: info.curve ?? info.algorithm,
      pgpKey,
      canonicalPublic: pgpKey.toPublic().armor(),
      fingerprint: pgpKey.getFingerprint(),
    };
  } catch {
    // fall through
  }

  return undefined;
}

/**
 * Detect the format of raw key material. Text formats (PEM blocks, PGP
 * armored, OpenSSH lines) are checked first, then binary formats
 * (DER SPKI/PKCS8, X.509 DER, OpenPGP binary packets).
 */
export async function detectKeyMaterial(input: Buffer | string): Promise<DetectedKeyMaterial> {
  const buffer = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;

  if (looksLikeText(buffer)) {
    const fromText = await detectFromText(buffer.toString('utf8'));
    if (fromText) return fromText;
  }

  const fromBinary = await detectFromBinary(buffer);
  if (fromBinary) return fromBinary;

  throw new KeyFormatError();
}
