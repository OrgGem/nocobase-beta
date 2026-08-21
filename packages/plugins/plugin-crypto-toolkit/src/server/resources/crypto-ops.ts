import type { Application } from '@nocobase/server';
import type { Handlers, ResourcerContext } from '@nocobase/resourcer';
import type { Repository } from '@nocobase/database';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  privateKeyFromPem,
  publicKeyFromPem,
  sha256Hex,
  signDetached,
  verifyDetached,
} from '../services/crypto-core';
import { createCsr, createSelfSigned, inspectCert } from '../services/cert-service';
import { decryptAndVerify, encryptAndSign, signDetachedPgp, verifyDetachedPgp } from '../services/pgp-service';
import { writeBufferAsAttachment } from '../services/attachment-helper';
import { createEnvGetter } from '../services/resolve-env';
import { logOperation } from '../services/operation-logger';
import type { KeyMaterialInput } from '../services/load-key-material';
import { CryptoToolkitHttpError } from '../http-error';
import { loadRawMaterial } from '../services/load-key-material';

const MAX_PAYLOAD_BYTES = 200 * 1024 * 1024; // 200 MB

function readBody(ctx: ResourcerContext): Record<string, unknown> {
  const body = ctx.request?.body;
  if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  return {};
}

async function loadOwnPrivateKey(
  app: Application,
  ctx: ResourcerContext,
  envVar: string | undefined,
  passphrase: string | undefined,
): Promise<string> {
  if (!envVar) throw new CryptoToolkitHttpError(400, 'CRYPTOTOOLKIT_BAD_REQUEST', 'envVar is required');
  const repo: Repository = app.db.getRepository('cryptoKeys');
  const legacyBaseName = envVar.endsWith('_PRIVATE') ? envVar.slice(0, -'_PRIVATE'.length) : envVar;
  const row =
    (await repo.findOne({ filter: { privateEnvVar: envVar } })) ??
    (await repo.findOne({ filter: { privateEnvVar: legacyBaseName } }));
  if (!row || row.get('direction') !== 'own' || row.get('enabled') === false) {
    throw new CryptoToolkitHttpError(
      400,
      'CRYPTOTOOLKIT_BAD_REQUEST',
      `private environment variable "${envVar}" is not an enabled Crypto Toolkit key`,
    );
  }

  const storedEnvVar = String(row.get('privateEnvVar') ?? '');
  const resolvedEnvVar = storedEnvVar.endsWith('_PRIVATE') ? storedEnvVar : `${storedEnvVar}_PRIVATE`;
  const raw = createEnvGetter(app)(resolvedEnvVar);
  if (!raw)
    throw new CryptoToolkitHttpError(400, 'CRYPTOTOOLKIT_BAD_REQUEST', `environment variable "${envVar}" is not set`);
  if (passphrase && /-----BEGIN PGP PRIVATE KEY BLOCK-----/.test(raw)) {
    // passphrase + PGP: the PGP service decrypts internally on read
    return raw;
  }
  if (/-----BEGIN OPENSSH PRIVATE KEY-----/.test(raw)) {
    // SSH-generated keys are stored in OpenSSH format, which node:crypto cannot
    // parse — convert to PKCS8 PEM so sign/CSR/cert operations work with them.
    try {
      const { openSshPrivateToPem } = await import('../services/ssh-key-service');
      return openSshPrivateToPem(raw);
    } catch (error) {
      throw new CryptoToolkitHttpError(
        400,
        'CRYPTOTOOLKIT_BAD_REQUEST',
        `could not parse OpenSSH private key in "${envVar}": ${(error as Error).message}`,
      );
    }
  }
  // raw is the PEM string verbatim; node's createPrivateKey handles passphrased PEM too,
  // but we let the caller's algorithm-specific code resolve the key object so passphrase
  // handling is localized.
  return raw;
}

// Typed error so the error-handler middleware renders 400 (a plain Error would
// be overwritten to 500 by NocoBase's error handler).
function badRequest(message: string): never {
  throw new CryptoToolkitHttpError(400, 'CRYPTOTOOLKIT_BAD_REQUEST', message);
}

function userId(ctx: ResourcerContext): number | null {
  const u = ctx.auth?.user as { id?: number } | undefined;
  return u?.id ?? null;
}

function requireUserId(ctx: ResourcerContext): number {
  const id = userId(ctx);
  if (id === null) badRequest('an authenticated user is required');
  return id;
}

async function logForCtx(
  app: Application,
  ctx: ResourcerContext,
  input: Parameters<typeof logOperation>[1],
): Promise<void> {
  await logOperation(app, { ...input, userId: userId(ctx) });
}

function ensurePayloadSize(buffer: Buffer, ctx: ResourcerContext, action: string) {
  if (buffer.length > MAX_PAYLOAD_BYTES) {
    badRequest(`payload too large for ${action} (max ${MAX_PAYLOAD_BYTES} bytes; got ${buffer.length})`);
  }
}

interface StorageOpts {
  outputFilename?: string;
  storageId?: number | string;
}

async function writeOutput(
  app: Application,
  ctx: ResourcerContext,
  buffer: Buffer,
  opts: StorageOpts & { baseFilename?: string; extension: string },
): Promise<{ attachmentId: number; url?: string; filename: string; size: number; sha256: string }> {
  const filename = opts.outputFilename ?? `${opts.baseFilename ?? 'crypto'}-${Date.now()}${opts.extension}`;
  const record = (await writeBufferAsAttachment(app, buffer, {
    filename,
    storageId: opts.storageId,
    createdById: requireUserId(ctx),
  })) as {
    id?: number;
    url?: unknown;
    get?: (field: string) => unknown;
    toJSON?: () => Record<string, unknown>;
  };
  const attachmentId = Number(
    record.get ? record.get('id') : typeof record.toJSON === 'function' ? record.toJSON().id : record.id,
  );
  if (!Number.isInteger(attachmentId))
    throw new CryptoToolkitHttpError(500, 'CRYPTOTOOLKIT_INTERNAL', 'file manager did not return an attachment id');
  // url/preview are computed by file-manager's afterFind hook — re-query the
  // freshly created record so the client receives a working Download link.
  let url: string | undefined;
  let storageType = '';
  try {
    const fresh = await app.db.getRepository('attachments').findOne({ filterByTk: attachmentId, appends: ['storage'] });
    if (fresh) {
      const u = fresh.get('url');
      if (typeof u === 'string' && u) url = u;
      const storage = fresh.get('storage') as { type?: string } | undefined;
      storageType = typeof storage?.type === 'string' ? storage.type : '';
    }
  } catch {
    url = undefined; // fall back to attachmentId-only result
  }
  // Local storage serves files directly from its public base URL; the
  // attachments:stream action used by private storages may not be
  // registered in every NocoBase version, so expose a direct URL when possible.
  if (url && url.startsWith('/api/attachments:stream') && storageType === 'local') {
    const base = await app.db.getRepository('storages').findOne({ filterByTk: opts.storageId });
    const baseUrl = base?.get('baseUrl') as string | undefined;
    const recordFilename = String(
      record.get ? record.get('filename') : (typeof record.toJSON === 'function' ? record.toJSON().filename : '') || '',
    );
    if (baseUrl && recordFilename) {
      url = `${baseUrl}/${encodeURIComponent(recordFilename)}`;
    }
  }
  return {
    attachmentId,
    url,
    filename,
    size: buffer.length,
    sha256: sha256Hex(buffer),
  };
}

async function loadBuffer(ctx: ResourcerContext, input: KeyMaterialInput): Promise<Buffer> {
  const app = (ctx as unknown as { app: Application }).app;
  const loaded = await loadRawMaterial(app, input, {
    attachmentOwnerId: requireUserId(ctx),
    maxBytes: MAX_PAYLOAD_BYTES,
  });
  return loaded.buffer;
}

function isAesSecretObject(value: unknown): value is { key?: string; passphrase?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.key === 'string' || typeof record.passphrase === 'string';
}

function decodeBase64Key(value: string): Buffer | undefined {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 !== 0) return undefined;
  const key = Buffer.from(normalized, 'base64');
  return key.length === 32 ? key : undefined;
}

async function loadAesSecret(ctx: ResourcerContext, input: unknown): Promise<{ key?: Buffer; passphrase?: string }> {
  if (isAesSecretObject(input)) {
    return {
      key: input.key ? Buffer.from(input.key, 'base64') : undefined,
      passphrase: input.passphrase,
    };
  }

  const app = (ctx as unknown as { app: Application }).app;
  const { buffer } = await loadRawMaterial(app, input as KeyMaterialInput, {
    attachmentOwnerId: requireUserId(ctx),
    maxBytes: MAX_PAYLOAD_BYTES,
  });
  if (buffer.length === 32) return { key: buffer };

  const text = buffer.toString('utf8').trim();
  if (!text) badRequest('AES secret is empty');
  return { key: decodeBase64Key(text), passphrase: decodeBase64Key(text) ? undefined : text };
}

async function loadPublicKeyById(app: Application, id: number | string, ctx: ResourcerContext): Promise<string> {
  const repo: Repository = app.db.getRepository('cryptoKeys');
  const row = await repo.findOne({ filter: { id, enabled: true } });
  if (!row) badRequest(`cryptoKey ${id} not found`);
  return String((row as { get: (k: string) => unknown }).get('publicMaterial') ?? '');
}

function getStorage(ctx: ResourcerContext, body: Record<string, unknown>, field: string): number | string | undefined {
  const v = body[field];
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && String(v).trim() !== '' ? n : (v as number | string);
}

export function registerCryptoOpsResource(app: Application): void {
  const handlers: Handlers = {
    async encrypt(ctx, next) {
      const started = Date.now();
      const body = readBody(ctx);
      const algorithm = String(body.algorithm ?? '') as 'pgp' | 'aes-256-gcm';
      const outputFilename = typeof body.outputFilename === 'string' ? body.outputFilename : undefined;
      const storageId = getStorage(ctx, body, 'storageId');

      let output: Awaited<ReturnType<typeof writeOutput>>;
      let inputBytes = 0;
      // No own cryptoKeys row is used by encrypt (AES has no key row; PGP uses signerEnvVar + recipient ids).
      const keyId: number | null = null;
      let partnerKeyId: number | null = null;

      try {
        if (algorithm === 'aes-256-gcm') {
          const payload = await loadBuffer(ctx, body.payload as KeyMaterialInput);
          if (!body.secret) badRequest('secret is required for AES');
          const buf = aesGcmEncrypt(payload, await loadAesSecret(ctx, body.secret));
          inputBytes = payload.length;
          output = await writeOutput(app, ctx, buf, {
            outputFilename,
            storageId,
            baseFilename: 'encrypted',
            extension: '.ncb1',
          });
        } else if (algorithm === 'pgp') {
          const payload = await loadBuffer(ctx, body.payload as KeyMaterialInput);
          const recipientKeyIds = Array.isArray(body.recipientKeyIds)
            ? (body.recipientKeyIds as Array<number | string>).map((v) => Number(v))
            : [];
          if (recipientKeyIds.length === 0) badRequest('recipientKeyIds is required for PGP');

          const recipients: Array<{ armored: string }> = [];
          for (const rid of recipientKeyIds) {
            const armored = await loadPublicKeyById(app, rid, ctx);
            recipients.push({ armored });
          }
          let signerKey: { armored: string; passphrase?: string } | undefined;
          if (typeof body.signerEnvVar === 'string' && body.signerEnvVar) {
            const armored = await loadOwnPrivateKey(app, ctx, body.signerEnvVar, body.passphrase as string | undefined);
            signerKey = { armored, passphrase: body.passphrase as string | undefined };
          }
          let ciphertext: Uint8Array;
          try {
            ciphertext = await encryptAndSign({ data: payload, recipientKeys: recipients, signerKey });
          } catch (error) {
            badRequest(`PGP encryption failed: ${(error as Error).message}`);
          }
          output = await writeOutput(app, ctx, Buffer.from(ciphertext), {
            outputFilename,
            storageId,
            baseFilename: 'encrypted',
            extension: '.pgp',
          });
          partnerKeyId = recipientKeyIds[0] ?? null;
        } else {
          badRequest('algorithm must be pgp or aes-256-gcm');
        }
      } catch (error) {
        await logForCtx(app, ctx, {
          action: 'encrypt',
          status: 'error',
          algorithm,
          errorMessage: (error as Error).message,
          inputBytes,
          durationMs: Date.now() - started,
        });
        throw error;
      }
      await logForCtx(app, ctx, {
        action: 'encrypt',
        status: 'success',
        algorithm,
        keyId,
        partnerKeyId,
        inputBytes,
        outputBytes: output.size,
        outputSha256: output.sha256,
        outputAttachmentId: output.attachmentId,
        durationMs: Date.now() - started,
      });
      ctx.body = { ok: true, algorithm, ...output };
      await next();
    },

    async decrypt(ctx, next) {
      const started = Date.now();
      const body = readBody(ctx);
      const algorithm = String(body.algorithm ?? '') as 'pgp' | 'aes-256-gcm';
      const outputFilename = typeof body.outputFilename === 'string' ? body.outputFilename : undefined;
      const storageId = getStorage(ctx, body, 'storageId');

      let output: Awaited<ReturnType<typeof writeOutput>>;
      let inputBytes = 0;
      let keyId: number | null = null;
      let partnerKeyId: number | null = null;
      let signatureValid: boolean | null = null;
      let signerFingerprints: string[] = [];

      try {
        if (algorithm === 'aes-256-gcm') {
          const payload = await loadBuffer(ctx, body.payload as KeyMaterialInput);
          if (!body.secret) badRequest('secret is required for AES');
          let plain: Buffer;
          try {
            plain = aesGcmDecrypt(payload, await loadAesSecret(ctx, body.secret));
          } catch (error) {
            badRequest(`AES decryption failed: ${(error as Error).message}`);
          }
          inputBytes = payload.length;
          output = await writeOutput(app, ctx, plain, {
            outputFilename,
            storageId,
            baseFilename: 'decrypted',
            extension: '.bin',
          });
        } else if (algorithm === 'pgp') {
          const payload = await loadBuffer(ctx, body.payload as KeyMaterialInput);
          const envVar = String(body.privateEnvVar ?? '');
          const passphrase = typeof body.passphrase === 'string' ? body.passphrase : undefined;
          if (!envVar) badRequest('privateEnvVar is required for PGP');
          const armored = await loadOwnPrivateKey(app, ctx, envVar, passphrase);

          let verificationKeys: Array<{ armored: string }> | undefined;
          if (Array.isArray(body.verifyKeyIds) && body.verifyKeyIds.length > 0) {
            const ids = (body.verifyKeyIds as Array<number | string>).map((v) => Number(v));
            verificationKeys = [];
            for (const id of ids) {
              const armored = await loadPublicKeyById(app, id, ctx);
              verificationKeys.push({ armored });
            }
            partnerKeyId = ids[0] ?? null;
          }

          let r: Awaited<ReturnType<typeof decryptAndVerify>>;
          try {
            r = await decryptAndVerify({
              data: payload,
              privateKey: { armored, passphrase },
              verificationKeys,
            });
          } catch (error) {
            badRequest(`PGP decryption failed: ${(error as Error).message}`);
          }
          signatureValid = r.signatureValid;
          signerFingerprints = r.signerFingerprints;
          inputBytes = payload.length;
          output = await writeOutput(app, ctx, Buffer.from(r.data), {
            outputFilename,
            storageId,
            baseFilename: 'decrypted',
            extension: '.bin',
          });
          keyId = null; // No internal cryptoKeys row references PGP private material; envVar is the link.
        } else {
          badRequest('algorithm must be pgp or aes-256-gcm');
        }
      } catch (error) {
        await logForCtx(app, ctx, {
          action: 'decrypt',
          status: 'error',
          algorithm,
          errorMessage: (error as Error).message,
          inputBytes,
          durationMs: Date.now() - started,
        });
        throw error;
      }
      await logForCtx(app, ctx, {
        action: 'decrypt',
        status: 'success',
        algorithm,
        keyId,
        partnerKeyId,
        inputBytes,
        outputBytes: output.size,
        outputSha256: output.sha256,
        outputAttachmentId: output.attachmentId,
        durationMs: Date.now() - started,
      });
      ctx.body = {
        ok: true,
        algorithm,
        ...output,
        signatureValid,
        signerFingerprints,
      };
      await next();
    },

    async sign(ctx, next) {
      const started = Date.now();
      const body = readBody(ctx);
      const algorithm = String(body.algorithm ?? '') as 'rsa-pss-sha256' | 'ed25519' | 'pgp-detached';
      if (!['rsa-pss-sha256', 'ed25519', 'pgp-detached'].includes(algorithm)) {
        badRequest(`Unsupported algorithm "${algorithm}"`);
      }
      const outputFilename = typeof body.outputFilename === 'string' ? body.outputFilename : undefined;
      const storageId = getStorage(ctx, body, 'storageId');
      const envVar = String(body.privateEnvVar ?? '');
      const passphrase = typeof body.passphrase === 'string' ? body.passphrase : undefined;
      if (!envVar) badRequest('privateEnvVar is required');

      const payload = await loadBuffer(ctx, body.payload as KeyMaterialInput);
      const inputBytes = payload.length;

      let output: Awaited<ReturnType<typeof writeOutput>>;
      try {
        if (algorithm === 'pgp-detached') {
          const armored = await loadOwnPrivateKey(app, ctx, envVar, passphrase);
          const sig = await signDetachedPgp({ data: payload, privateKey: { armored, passphrase } });
          output = await writeOutput(app, ctx, Buffer.from(sig), {
            outputFilename,
            storageId,
            baseFilename: 'signature',
            extension: '.pgp',
          });
        } else {
          const pem = await loadOwnPrivateKey(app, ctx, envVar, passphrase);
          const nodeKey = privateKeyFromPem(pem, passphrase);
          const sig = signDetached(payload, algorithm === 'rsa-pss-sha256' ? 'rsa-pss-sha256' : 'ed25519', nodeKey);
          output = await writeOutput(app, ctx, sig, {
            outputFilename,
            storageId,
            baseFilename: 'signature',
            extension: '.sig',
          });
        }
      } catch (error) {
        await logForCtx(app, ctx, {
          action: 'sign',
          status: 'error',
          algorithm,
          errorMessage: (error as Error).message,
          inputBytes,
          durationMs: Date.now() - started,
        });
        throw error;
      }
      await logForCtx(app, ctx, {
        action: 'sign',
        status: 'success',
        algorithm,
        inputBytes,
        outputBytes: output.size,
        outputSha256: output.sha256,
        outputAttachmentId: output.attachmentId,
        durationMs: Date.now() - started,
      });
      ctx.body = { ok: true, algorithm, ...output };
      await next();
    },

    async verify(ctx, next) {
      const started = Date.now();
      const body = readBody(ctx);
      const algorithm = String(body.algorithm ?? '') as 'rsa-pss-sha256' | 'ed25519' | 'pgp-detached';
      if (!['rsa-pss-sha256', 'ed25519', 'pgp-detached'].includes(algorithm)) {
        badRequest(`Unsupported algorithm "${algorithm}"`);
      }
      const verifyKeyId = Number(body.verifyKeyId ?? 0);
      if (!verifyKeyId) badRequest('verifyKeyId is required');
      const payload = await loadBuffer(ctx, body.payload as KeyMaterialInput);
      const signature = await loadBuffer(ctx, body.signature as KeyMaterialInput);
      const inputBytes = payload.length;

      let valid = false;
      let fingerprint: string | undefined;
      try {
        if (algorithm === 'pgp-detached') {
          const armored = await loadPublicKeyById(app, verifyKeyId, ctx);
          const r = await verifyDetachedPgp({ data: payload, signature, verificationKey: { armored } });
          valid = r.valid;
          fingerprint = r.fingerprint;
        } else {
          const armored = await loadPublicKeyById(app, verifyKeyId, ctx);
          let publicPem = armored;
          if (/^ssh-/.test(armored.trim())) {
            try {
              const { openSshPublicToPem } = await import('../services/ssh-key-service');
              publicPem = openSshPublicToPem(armored);
            } catch (error) {
              badRequest(`verify key is not a valid OpenSSH public key: ${(error as Error).message}`);
            }
          }
          let nodeKey: ReturnType<typeof publicKeyFromPem>;
          try {
            nodeKey = publicKeyFromPem(publicPem);
          } catch (error) {
            badRequest(`verify key is not a PEM public key: ${(error as Error).message}`);
          }
          valid = verifyDetached(
            payload,
            signature,
            algorithm === 'rsa-pss-sha256' ? 'rsa-pss-sha256' : 'ed25519',
            nodeKey,
          );
          fingerprint = 'SHA256:' + sha256Hex(nodeKey.export({ type: 'spki', format: 'der' }) as Buffer);
        }
      } catch (error) {
        await logForCtx(app, ctx, {
          action: 'verify',
          status: 'error',
          algorithm,
          keyId: verifyKeyId,
          errorMessage: (error as Error).message,
          inputBytes,
          durationMs: Date.now() - started,
        });
        throw error;
      }
      await logForCtx(app, ctx, {
        action: 'verify',
        status: valid ? 'success' : 'error',
        algorithm,
        keyId: verifyKeyId,
        inputBytes,
        durationMs: Date.now() - started,
      });
      // Important: always 200 even when invalid (per plan); valid false in body.
      ctx.body = { ok: true, valid, fingerprint, algorithm };
      await next();
    },

    async checksum(ctx, next) {
      const started = Date.now();
      const body = readBody(ctx);
      const algorithm = String(body.algorithm ?? 'sha-256');
      if (algorithm !== 'sha-256') badRequest('Only sha-256 is supported');
      const payload = await loadBuffer(ctx, body.payload as KeyMaterialInput);
      const value = sha256Hex(payload);
      await logForCtx(app, ctx, {
        action: 'checksum',
        algorithm: 'sha-256',
        inputBytes: payload.length,
        outputSha256: value,
        durationMs: Date.now() - started,
      });
      ctx.body = { ok: true, algorithm: 'sha-256', value, size: payload.length };
      await next();
    },

    async createCsr(ctx, next) {
      const started = Date.now();
      const body = readBody(ctx);
      const envVar = String(body.privateEnvVar ?? '');
      const subject = (body.subject ?? {}) as Record<string, string>;
      const san = (body.san ?? undefined) as { dns?: string[]; ip?: string[]; email?: string[] } | undefined;
      const outputFilename = typeof body.outputFilename === 'string' ? body.outputFilename : undefined;
      const storageId = getStorage(ctx, body, 'storageId');
      if (!envVar) badRequest('privateEnvVar is required');

      const passphrase = typeof body.passphrase === 'string' ? body.passphrase : undefined;
      const pem = await loadOwnPrivateKey(app, ctx, envVar, passphrase);
      let csr: Awaited<ReturnType<typeof createCsr>>;
      try {
        csr = await createCsr({
          subject: { ...subject, commonName: subject.commonName ?? 'nocobase-crypto-toolkit' },
          san,
          privateKeyPem: pem,
          passphrase,
        });
      } catch (error) {
        badRequest(`CSR creation failed: ${(error as Error).message}`);
      }
      const buf = Buffer.from(csr.csrPem, 'utf8');
      const output = await writeOutput(app, ctx, buf, {
        outputFilename,
        storageId,
        baseFilename: 'request',
        extension: '.csr',
      });
      await logForCtx(app, ctx, {
        action: 'createCsr',
        algorithm: `csr-${subject.commonName ?? ''}`,
        outputAttachmentId: output.attachmentId,
        outputSha256: output.sha256,
        durationMs: Date.now() - started,
      });
      ctx.body = {
        ok: true,
        csrPem: csr.csrPem,
        publicKeyPem: csr.publicKeyPem,
        ...output,
      };
      await next();
    },

    async createSelfSigned(ctx, next) {
      const started = Date.now();
      const body = readBody(ctx);
      const envVar = String(body.privateEnvVar ?? '');
      const subject = (body.subject ?? {}) as Record<string, string>;
      const san = (body.san ?? undefined) as { dns?: string[]; ip?: string[]; email?: string[] } | undefined;
      const validDays = Number(body.validDays ?? 365);
      const outputFilename = typeof body.outputFilename === 'string' ? body.outputFilename : undefined;
      const storageId = getStorage(ctx, body, 'storageId');
      if (!envVar) badRequest('privateEnvVar is required');

      const passphrase = typeof body.passphrase === 'string' ? body.passphrase : undefined;
      const pem = await loadOwnPrivateKey(app, ctx, envVar, passphrase);
      const cert = await createSelfSigned({
        subject: { ...subject, commonName: subject.commonName ?? 'nocobase-crypto-toolkit' },
        san,
        privateKeyPem: pem,
        passphrase,
        validDays,
      });
      const buf = Buffer.from(cert.certPem, 'utf8');
      const output = await writeOutput(app, ctx, buf, {
        outputFilename,
        storageId,
        baseFilename: subject.commonName ?? 'self-signed',
        extension: '.pem',
      });
      await logForCtx(app, ctx, {
        action: 'createSelfSigned',
        algorithm: 'x509',
        outputAttachmentId: output.attachmentId,
        outputSha256: output.sha256,
        durationMs: Date.now() - started,
      });
      ctx.body = {
        ok: true,
        ...cert,
        ...output,
      };
      await next();
    },

    async inspect(ctx, next) {
      const started = Date.now();
      const body = readBody(ctx);
      const certInput = body.cert as KeyMaterialInput | undefined;
      if (!certInput) badRequest('cert is required');
      try {
        const material = await loadBuffer(ctx, certInput);
        // Prefer PEM detection: a PEM string always starts with '-----BEGIN'.
        // Only treat the input as binary DER when it is not PEM text.
        let source: string | Buffer = material.toString('utf8');
        if (!/-----BEGIN/.test(source) && material.length > 0 && material[0] === 0x30) source = material;
        await logForCtx(app, ctx, {
          action: 'inspect',
          algorithm: 'x509',
          inputBytes: material.length,
          durationMs: Date.now() - started,
        });
        ctx.body = { ok: true, ...info };
      } catch (error) {
        await logForCtx(app, ctx, {
          action: 'inspect',
          status: 'error',
          algorithm: 'x509',
          errorMessage: (error as Error).message,
          durationMs: Date.now() - started,
        });
        throw error;
      }
      await next();
    },
  };

  app.resourceManager.define({
    name: 'crypto',
    actions: handlers,
  });
}
