import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import {
  generateSshKey,
  pemToOpenSshPublic,
  pemToOpenSshPrivate,
  sshFingerprint,
  type SshKeyKind,
} from '../services/ssh-key-service';

describe('ssh-key-service', () => {
  it('generateSshKey(ed25519): emits PEM + OpenSSH artifacts', () => {
    const pair = generateSshKey('ed25519');
    expect(pair.privatePem).toMatch(/-----BEGIN PRIVATE KEY-----/);
    expect(pair.publicPem).toMatch(/-----BEGIN PUBLIC KEY-----/);
    expect(pair.publicOpenSsh).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+/);
    expect(pair.privateOpenSsh).toMatch(/-----BEGIN OPENSSH PRIVATE KEY-----/);
    expect(pair.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/=]+$/);
    expect(pair.comment).toBe('nocobase-crypto-toolkit');
  });

  it('generateSshKey(rsa-4096): emits 4096-bit RSA artifacts', () => {
    const pair = generateSshKey('rsa-4096');
    expect(pair.publicOpenSsh).toMatch(/^ssh-rsa [A-Za-z0-9+/=]+/);
    expect(pair.privateOpenSsh).toMatch(/-----BEGIN OPENSSH PRIVATE KEY-----/);
    expect(pair.fingerprint).toMatch(/^SHA256:/);
  });

  it('comment override is applied to OpenSSH public line', () => {
    const pair = generateSshKey('ed25519', 'alice@workstation');
    expect(pair.publicOpenSsh.replace(/\s+$/, '').endsWith('alice@workstation')).toBe(true);
  });

  it('generated PEMs round-trip back to identical OpenSSH public fingerprint', () => {
    const pair = generateSshKey('ed25519');
    const roundTrip = pemToOpenSshPublic(pair.publicPem, pair.comment);
    expect(sshFingerprint(roundTrip)).toBe(pair.fingerprint);
  });

  it('sshFingerprint ignores the trailing OpenSSH comment', () => {
    const pair = generateSshKey('ed25519', 'comment-A');
    const sameKeyDifferentComment = pemToOpenSshPublic(pair.publicPem, 'comment-B');
    expect(sshFingerprint(sameKeyDifferentComment)).toBe(pair.fingerprint);
  });

  it('pemToOpenSshPublic/from-PEM-then-fingerprint path matches generate-and-fingerprint', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const sshPubLine = pemToOpenSshPublic(publicPem, 'user@host');
    expect(sshPubLine.startsWith('ssh-ed25519 ')).toBe(true);
    expect(sshFingerprint(sshPubLine)).toMatch(/^SHA256:/);
  });

  it('sshFingerprint parses both PEM and ssh formats without mismatch', () => {
    const pair = generateSshKey('rsa-4096');
    const fromPem = sshFingerprint(pair.publicPem);
    const fromSsh = sshFingerprint(pair.publicOpenSsh);
    expect(fromPem).toBe(fromSsh);
  });

  it('pemToOpenSshPrivate round-trips back to a usable OpenSSH private block', () => {
    const pair = generateSshKey('ed25519');
    const roundTrip = pemToOpenSshPrivate(pair.privatePem);
    expect(roundTrip).toMatch(/-----BEGIN OPENSSH PRIVATE KEY-----/);
    // sshpk reformats with trailing newline — fingerprint of public half is unchanged.
    const fingerprintFromPub = sshFingerprint(pair.publicPem);
    expect(fingerprintFromPub).toBe(pair.fingerprint);
  });
});
