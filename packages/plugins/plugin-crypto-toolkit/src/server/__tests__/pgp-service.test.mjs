// Standalone Node script (NOT a vitest test) — openpgp v5 breaks under vite-node's
// VM-context transformation in this Windows toolchain, but works correctly when
// loaded by the NocoBase server runtime. Run from repo root:
//
//   node packages/plugins/plugin-crypto-toolkit/src/server/__tests__/pgp-service.test.mjs
//
// Exits non-zero on failure.

import { strict as assert } from 'node:assert';
import { generatePgpKey, encryptAndSign, decryptAndVerify, signDetachedPgp, verifyDetachedPgp } from '../services/pgp-service.ts';

function ok(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
}

async function main() {
  console.log('generating recipient key...');
  const recipient = await generatePgpKey({
    userIds: [{ name: 'Recipient', email: 'r@example.com' }],
    curve: 'curve25519',
  });
  ok(recipient.publicKey.startsWith('-----BEGIN PGP PUBLIC KEY BLOCK-----'), 'recipient public armored');
  ok(recipient.privateKey.includes('-----BEGIN PGP PRIVATE KEY BLOCK-----'), 'recipient private armored');
  ok(/^[A-Fa-f0-9]{40}$/.test(recipient.fingerprint), 'recipient fingerprint hex40');

  console.log('generating signer key with passphrase...');
  const signer = await generatePgpKey({
    userIds: [{ name: 'Signer', email: 's@example.com' }],
    curve: 'curve25519',
    passphrase: 'sekrit-passphrase',
  });

  console.log('encrypt + sign round-trip...');
  const plaintext = 'Confidential payload — please handle with care.';
  const ciphertext = await encryptAndSign({
    data: plaintext,
    recipientKeys: [{ armored: recipient.publicKey }],
    signerKey: { armored: signer.privateKey, passphrase: 'sekrit-passphrase' },
  });
  ok(ciphertext instanceof Uint8Array, 'ciphertext is Uint8Array');
  ok(ciphertext.length > 0, 'ciphertext is non-empty');

  const decrypted = await decryptAndVerify({
    data: ciphertext,
    privateKey: { armored: recipient.privateKey },
    verificationKeys: [{ armored: signer.publicKey }],
  });
  const dec = new TextDecoder().decode(decrypted.data);
  ok(dec === plaintext, `decrypted text matches (got: ${dec.slice(0, 30)}...)`);
  ok(decrypted.signatureValid === true, 'signature is valid');

  console.log('detached sign + verify...');
  const sig = await signDetachedPgp({
    data: 'message to sign',
    privateKey: { armored: signer.privateKey, passphrase: 'sekrit-passphrase' },
  });
  ok(sig instanceof Uint8Array && sig.length > 0, 'detached signature produced');
  const verified = await verifyDetachedPgp({
    data: 'message to sign',
    signature: sig,
    verificationKey: { armored: signer.publicKey },
  });
  ok(verified.valid === true, 'detached signature verifies');

  console.log('verify rejects tampered data...');
  const tampered = await verifyDetachedPgp({
    data: 'tampered message',
    signature: sig,
    verificationKey: { armored: signer.publicKey },
  });
  ok(tampered.valid === false, 'tampered data fails verification');

  console.log('decrypt with wrong key throws...');
  const otherRecipient = await generatePgpKey({
    userIds: [{ name: 'Other', email: 'o@example.com' }],
    curve: 'curve25519',
  });
  let threw = false;
  try {
    await decryptAndVerify({
      data: ciphertext,
      privateKey: { armored: otherRecipient.privateKey },
    });
  } catch {
    threw = true;
  }
  ok(threw, 'decryption with wrong key fails');

  console.log('all pgp-service assertions passed.');
}

main().catch((e) => {
  console.error('UNEXPECTED ERROR:', e?.stack || e?.message || e);
  process.exit(1);
});