// openpgp v5 wrappers, interoperable with plugin-crypto-toolkit's pgp-service.
// openpgp is imported lazily inside each function so this module stays loadable in
// contexts that never use PGP (and to avoid eager-loading the large library).
import type * as openpgp from 'openpgp';

export interface PgpKeyPair {
  privateKey: string; // ASCII-armored private key (encrypted if passphrase given)
  publicKey: string; // ASCII-armored public key
  fingerprint: string;
  algorithm: string;
}

export interface PgpEncryptSignInput {
  data: Uint8Array | string;
  recipientKeys: Array<{ armored: string }>;
  signerKey?: { armored: string; passphrase?: string };
}

export interface PgpDecryptVerifyInput {
  data: Uint8Array | string;
  privateKey: { armored: string; passphrase?: string };
  verificationKeys?: Array<{ armored: string }>;
}

export interface PgpDecryptVerifyResult {
  data: Uint8Array;
  signatureValid: boolean | null; // null = no signature attached
  signerFingerprints: string[];
}

async function loadOpenpgp(): Promise<typeof import('openpgp')> {
  const mod = await import('openpgp');
  return (mod.default ?? mod) as typeof import('openpgp');
}

function toUint8Array(data: Uint8Array | string): Uint8Array {
  return typeof data === 'string' ? new TextEncoder().encode(data) : data;
}

export async function generatePgpKey(opts: {
  userIds: Array<{ name: string; email?: string }>;
  type?: 'ecc' | 'rsa';
  curve?: 'curve25519' | 'ed25519';
  rsaBits?: 2048 | 3072 | 4096;
  passphrase?: string;
}): Promise<PgpKeyPair> {
  const openpgp = await loadOpenpgp();
  const params: openpgp.KeyGenerationOptions =
    opts.type === 'rsa'
      ? {
          type: 'rsa',
          rsaBits: opts.rsaBits ?? 4096,
          userIDs: opts.userIds.map((u) => ({ name: u.name, email: u.email })),
          format: 'armored',
          passphrase: opts.passphrase,
        }
      : {
          type: 'ecc',
          curve: opts.curve ?? 'curve25519',
          userIDs: opts.userIds.map((u) => ({ name: u.name, email: u.email })),
          format: 'armored',
          passphrase: opts.passphrase,
        };
  const { privateKey, publicKey } = await openpgp.generateKey(params);
  const priv = await openpgp.readPrivateKey({ armoredKey: privateKey });
  return {
    privateKey,
    publicKey,
    fingerprint: priv.getFingerprint(),
    algorithm: (priv.getAlgorithmInfo().curve ?? priv.getAlgorithmInfo().algorithm) as string,
  };
}

export async function encryptAndSign(input: PgpEncryptSignInput): Promise<Uint8Array> {
  const openpgp = await loadOpenpgp();
  const text = typeof input.data === 'string' ? input.data : undefined;
  const binary = typeof input.data === 'string' ? undefined : input.data;
  const message = await openpgp.createMessage({ text, binary });
  const recipients = await Promise.all(
    input.recipientKeys.map(async (k) => openpgp.readKey({ armoredKey: k.armored })),
  );
  let signingKeys: openpgp.PrivateKey[] | undefined;
  if (input.signerKey) {
    let pk = await openpgp.readPrivateKey({ armoredKey: input.signerKey.armored });
    if (input.signerKey.passphrase && !pk.isDecrypted()) {
      pk = await openpgp.decryptKey({ privateKey: pk, passphrase: input.signerKey.passphrase });
    }
    signingKeys = [pk];
  }
  const ciphertext = await openpgp.encrypt({
    message,
    encryptionKeys: recipients,
    signingKeys,
    format: 'binary',
  });
  return ciphertext as Uint8Array;
}

export async function decryptAndVerify(input: PgpDecryptVerifyInput): Promise<PgpDecryptVerifyResult> {
  const openpgp = await loadOpenpgp();
  const message = await openpgp.readMessage({ binaryMessage: toUint8Array(input.data) });
  let pk = await openpgp.readPrivateKey({ armoredKey: input.privateKey.armored });
  if (input.privateKey.passphrase && !pk.isDecrypted()) {
    pk = await openpgp.decryptKey({ privateKey: pk, passphrase: input.privateKey.passphrase });
  }
  const verificationKeys = input.verificationKeys
    ? await Promise.all(input.verificationKeys.map(async (k) => openpgp.readKey({ armoredKey: k.armored })))
    : undefined;
  const { data, signatures } = await openpgp.decrypt({
    message,
    decryptionKeys: [pk],
    verificationKeys,
    format: 'binary',
  });
  let signatureValid: boolean | null = null;
  const signerFingerprints: string[] = [];
  if (signatures && signatures.length > 0) {
    const results = await Promise.all(
      signatures.map(async (s) => {
        try {
          await s.verified;
          return true;
        } catch {
          return false;
        }
      }),
    );
    signatureValid = results.every(Boolean);
    if (verificationKeys) {
      const signingKeyIDs = new Set<string>(signatures.map((s) => s.keyID.toHex().toLowerCase()));
      for (const k of verificationKeys) {
        try {
          if (signingKeyIDs.has(k.getKeyID().toHex().toLowerCase())) {
            signerFingerprints.push(k.getFingerprint());
          }
        } catch {
          // ignore keys whose ID cannot be read
        }
      }
    }
  }
  return { data: data as Uint8Array, signatureValid, signerFingerprints };
}
