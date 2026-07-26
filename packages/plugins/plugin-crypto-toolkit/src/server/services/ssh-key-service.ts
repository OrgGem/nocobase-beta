import { generateKeyPairSync, createPrivateKey } from 'crypto';
import * as sshpk from 'sshpk';

export type SshKeyKind = 'ed25519' | 'rsa-4096';

export interface SshKeyPair {
  privatePem: string;
  publicPem: string;
  /** OpenSSH-format public-key line (`ssh-ed25519 AAAA… user@host`). */
  publicOpenSsh: string;
  /** OpenSSH private-key block (`-----BEGIN OPENSSH PRIVATE KEY-----`). */
  privateOpenSsh: string;
  fingerprint: string;
  comment?: string;
}

/** Generate a fresh keypair in PEM + OpenSSH formats with sshpk conversion. */
export function generateSshKey(kind: SshKeyKind, comment = 'nocobase-crypto-toolkit'): SshKeyPair {
  const { privateKey, publicKey } =
    kind === 'rsa-4096' ? generateKeyPairSync('rsa', { modulusLength: 4096 }) : generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  const sshPub = sshpk.parseKey(publicPem, 'pem');
  const sshPriv = sshpk.parsePrivateKey(privatePem, 'pem');
  sshPub.comment = comment;

  return {
    privatePem,
    publicPem,
    publicOpenSsh: sshPub.toString('ssh'),
    privateOpenSsh: sshPriv.toString('openssh'),
    fingerprint: sshPub.fingerprint('sha256').toString(),
    comment,
  };
}

/** Convert PEM (PKCS8 private / SPKI public) to OpenSSH public-key line. */
export function pemToOpenSshPublic(pem: string, comment?: string): string {
  const key = sshpk.parseKey(pem, 'pem');
  if (comment) key.comment = comment;
  return key.toString('ssh');
}

/** Convert PEM (PKCS8) to OpenSSH private-key block. */
export function pemToOpenSshPrivate(pem: string, passphrase?: string): string {
  const key = passphrase
    ? sshpk.parsePrivateKey(createPrivateKey({ key: pem, passphrase }).export({ format: 'pem' }) as string, 'pem')
    : sshpk.parsePrivateKey(pem, 'pem');
  return key.toString('openssh');
}

/** SHA-256 fingerprint of an OpenSSH line or PEM public key. */
export function sshFingerprint(material: string): string {
  const key = material.includes('-----BEGIN') ? sshpk.parseKey(material, 'pem') : sshpk.parseKey(material, 'ssh');
  return key.fingerprint('sha256').toString();
}
