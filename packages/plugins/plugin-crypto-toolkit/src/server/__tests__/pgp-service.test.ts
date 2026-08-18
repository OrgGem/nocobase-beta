import { describe, expect, it } from 'vitest';
import {
  decryptAndVerify,
  encryptAndSign,
  generatePgpKey,
  signDetachedPgp,
  verifyDetachedPgp,
} from '../services/pgp-service';

describe('pgp-service', () => {
  it('generatePgpKey: ecc curve25519 emits armored halves and a fingerprint', async () => {
    const pair = await generatePgpKey({ userIds: [{ name: 'Unit Test' }], type: 'ecc', curve: 'curve25519' });
    expect(pair.privateKey).toMatch(/-----BEGIN PGP PRIVATE KEY BLOCK-----/);
    expect(pair.publicKey).toMatch(/-----BEGIN PGP PUBLIC KEY BLOCK-----/);
    expect(pair.fingerprint).toMatch(/^[0-9a-f]{40}$/);
    expect(pair.algorithm).toBeTruthy();
  }, 60000);

  it('encrypt + decrypt round-trips a text payload (unsigned)', async () => {
    const pair = await generatePgpKey({ userIds: [{ name: 'Round Trip' }], type: 'ecc', curve: 'curve25519' });
    const plaintext = 'PGP confidential payload — éèỳ';
    const ciphertext = await encryptAndSign({
      data: plaintext,
      recipientKeys: [{ armored: pair.publicKey }],
    });
    expect(ciphertext).toBeInstanceOf(Uint8Array);
    expect(ciphertext.length).toBeGreaterThan(0);

    const result = await decryptAndVerify({
      data: ciphertext,
      privateKey: { armored: pair.privateKey },
    });
    expect(new TextDecoder().decode(result.data)).toBe(plaintext);
    expect(result.signatureValid).toBeNull();
    expect(result.signerFingerprints).toEqual([]);
  }, 60000);

  it('encrypt + decrypt round-trips binary data', async () => {
    const pair = await generatePgpKey({ userIds: [{ name: 'Binary' }], type: 'ecc', curve: 'curve25519' });
    const binary = new Uint8Array([0, 1, 2, 250, 251, 252, 255]);
    const ciphertext = await encryptAndSign({
      data: binary,
      recipientKeys: [{ armored: pair.publicKey }],
    });
    const result = await decryptAndVerify({
      data: ciphertext,
      privateKey: { armored: pair.privateKey },
    });
    expect(Buffer.from(result.data).equals(Buffer.from(binary))).toBe(true);
  }, 60000);

  it('signed payloads verify and expose the signer fingerprint', async () => {
    const recipient = await generatePgpKey({ userIds: [{ name: 'Recipient' }], type: 'ecc', curve: 'curve25519' });
    const signer = await generatePgpKey({ userIds: [{ name: 'Signer' }], type: 'ecc', curve: 'curve25519' });
    const ciphertext = await encryptAndSign({
      data: 'signed message',
      recipientKeys: [{ armored: recipient.publicKey }],
      signerKey: { armored: signer.privateKey },
    });
    const result = await decryptAndVerify({
      data: ciphertext,
      privateKey: { armored: recipient.privateKey },
      verificationKeys: [{ armored: signer.publicKey }],
    });
    expect(new TextDecoder().decode(result.data)).toBe('signed message');
    expect(result.signatureValid).toBe(true);
    expect(result.signerFingerprints).toContain(signer.fingerprint);
  }, 60000);

  it('fails to decrypt with an unrelated private key', async () => {
    const recipient = await generatePgpKey({ userIds: [{ name: 'Recipient' }], type: 'ecc', curve: 'curve25519' });
    const stranger = await generatePgpKey({ userIds: [{ name: 'Stranger' }], type: 'ecc', curve: 'curve25519' });
    const ciphertext = await encryptAndSign({
      data: 'not for you',
      recipientKeys: [{ armored: recipient.publicKey }],
    });
    await expect(
      decryptAndVerify({ data: ciphertext, privateKey: { armored: stranger.privateKey } }),
    ).rejects.toThrow();
  }, 60000);

  it('passphrase-protected keys work for signing and decryption', async () => {
    const pair = await generatePgpKey({
      userIds: [{ name: 'Protected' }],
      type: 'ecc',
      curve: 'curve25519',
      passphrase: 'unit-passphrase',
    });
    const ciphertext = await encryptAndSign({
      data: 'protected key payload',
      recipientKeys: [{ armored: pair.publicKey }],
      signerKey: { armored: pair.privateKey, passphrase: 'unit-passphrase' },
    });
    const result = await decryptAndVerify({
      data: ciphertext,
      privateKey: { armored: pair.privateKey, passphrase: 'unit-passphrase' },
      verificationKeys: [{ armored: pair.publicKey }],
    });
    expect(new TextDecoder().decode(result.data)).toBe('protected key payload');
    expect(result.signatureValid).toBe(true);
  }, 60000);

  it('detached signatures verify, and reject tampered data', async () => {
    const pair = await generatePgpKey({ userIds: [{ name: 'Detached' }], type: 'ecc', curve: 'curve25519' });
    const data = 'payload to sign';
    const signature = await signDetachedPgp({ data, privateKey: { armored: pair.privateKey } });
    expect(signature).toBeInstanceOf(Uint8Array);

    const good = await verifyDetachedPgp({
      data,
      signature,
      verificationKey: { armored: pair.publicKey },
    });
    expect(good.valid).toBe(true);
    expect(good.fingerprint).toBe(pair.fingerprint);

    const bad = await verifyDetachedPgp({
      data: 'tampered payload',
      signature,
      verificationKey: { armored: pair.publicKey },
    });
    expect(bad.valid).toBe(false);
  }, 60000);
});
