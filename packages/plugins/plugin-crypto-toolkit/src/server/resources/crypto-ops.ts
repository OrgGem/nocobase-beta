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
  if (!envVar) throw new Error('envVar is required');
  const repo: Repository = app.db.getRepository('cryptoKeys');
  const legacyBaseName = envVar.endsWith('_PRIVATE') ? envVar.slice(0, -'_PRIVATE'.length) : envVar;
  const row =
    (await repo.findOne({ filter: { privateEnvVar: envVar } })) ??
    (await repo.findOne({ filter: { privateEnvVar: legacyBaseName } }));
  if (!row || row.get('direction') !== 'own' || row.get('enabled') === false) {
    throw new Error(`private environment variable "${envVar}" is not an enabled Crypto Toolkit key`);
  }

  const storedEnvVar = String(row.get('privateEnvVar') ?? '');
  const resolvedEnvVar = storedEnvVar.endsWith('_PRIVATE') ? storedEnvVar : `${storedEnvVar}_PRIVATE`;
  const raw = createEnvGetter(app)(resolvedEnvVar);
  if (!raw) throw new Error(`environment variable "${envVar}" is not set`);
  if (passphrase && /-----BEGIN PGP PRIVATE KEY BLOCK-----/.test(raw)) {
    // passphrase + PGP: the PGP service decrypts internally on read
    return raw;
  }
  // raw is the PEM string verbatim; node's createPrivateKey handles passphrased PEM too,
  // but we let the caller's algorithm-specific code resolve the key object so passphrase
  // handling is localized.
  return raw;
}

function badRequest(ctx: ResourcerContext, message: string): never {
  ctx.status = 400;
  ctx.body = { errors: [{ code: 'CRYPTOTOOLKIT_BAD_REQUEST', message }] };
  throw new Error(message);
}

function userId(ctx: ResourcerContext): number | null {
  const u = ctx.auth?.user as { id?: number } | undefined;
  return u?.id ?? null;
}

function requireUserId(ctx: ResourcerContext): number {
  const id = userId(ctx);
  if (id === null) badRequest(ctx, 'an authenticated user is required');
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
    badRequest(ctx, `payload too large for ${action} (max ${MAX_PAYLOAD_BYTES} bytes; got ${buffer.length})`);
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
    toJSON?: () => Record<string, unknown>;
  };
  const attachment = typeof record.toJSON === 'function' ? record.toJSON() : record;
  const attachmentId = Number(attachment.id);
  if (!Number.isInteger(attachmentId)) throw new Error('file manager did not return an attachment id');
  const url = typeof attachment.url === 'string' ? attachment.url : undefined;
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
  if (!text) badRequest(ctx, 'AES secret is empty');
  return { key: decodeBase64Key(text), passphrase: decodeBase64Key(text) ? undefined : text };
}

async function loadPublicKeyById(app: Application, id: number | string, ctx: ResourcerContext): Promise<string> {
  const repo: Repository = app.db.getRepository('cryptoKeys');
  const row = await repo.findOne({ filter: { id } });
  if (!row) badRequest(ctx, `cryptoKey ${id} not found`);
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
      const keyId: number | null = null;
      let partnerKeyId: number | null = null;

      try {
        if (algorithm === 'aes-256-gcm') {
          const payload = await loadBuffer(ctx, body.payload as KeyMaterialInput);
          if (!body.secret) badRequest(ctx, 'secret is required for AES');
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
          if (recipientKeyIds.length === 0) badRequest(ctx, 'recipientKeyIds is required for PGP');

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
          const ciphertext = await encryptAndSign({ data: payload, recipientKeys: recipients, signerKey });
          inputBytes = payload.length;
          output = await writeOutput(app, ctx, Buffer.from(ciphertext), {
            outputFilename,
            storageId,
            baseFilename: 'encrypted',
            extension: '.pgp',
          });
          partnerKeyId = recipientKeyIds[0] ?? null;
        } else {
          badRequest(ctx, 'algorithm must be pgp or aes-256-gcm');
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
          if (!body.secret) badRequest(ctx, 'secret is required for AES');
          const plain = aesGcmDecrypt(payload, await loadAesSecret(ctx, body.secret));
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
          if (!envVar) badRequest(ctx, 'privateEnvVar is required for PGP');
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

          const r = await decryptAndVerify({
            data: payload,
            privateKey: { armored, passphrase },
            verificationKeys,
          });
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
          badRequest(ctx, 'algorithm must be pgp or aes-256-gcm');
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
      const outputFilename = typeof body.outputFilename === 'string' ? body.outputFilename : undefined;
      const storageId = getStorage(ctx, body, 'storageId');
      const envVar = String(body.privateEnvVar ?? '');
      const passphrase = typeof body.passphrase === 'string' ? body.passphrase : undefined;
      if (!envVar) badRequest(ctx, 'privateEnvVar is required');

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
      const verifyKeyId = Number(body.verifyKeyId ?? 0);
      if (!verifyKeyId) badRequest(ctx, 'verifyKeyId is required');
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
          const nodeKey = publicKeyFromPem(armored);
          valid = verifyDetached(
            payload,
            signature,
            algorithm === 'rsa-pss-sha256' ? 'rsa-pss-sha256' : 'ed25519',
            nodeKey,
          );
          // PGP rows do not expose an SPKI fingerprint; for PEM/SPKI rows, derive one from the SHA-256 of DER.
          fingerprint = 'SHA256:' + sha256Hex(nodeKey.export({ type: 'der', format: 'der' }) as Buffer);
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
      if (algorithm !== 'sha-256') badRequest(ctx, 'Only sha-256 is supported');
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
      if (!envVar) badRequest(ctx, 'privateEnvVar is required');

      const passphrase = typeof body.passphrase === 'string' ? body.passphrase : undefined;
      const pem = await loadOwnPrivateKey(app, ctx, envVar, passphrase);
      const csr = await createCsr({
        subject: { ...subject, commonName: subject.commonName ?? 'nocobase-crypto-toolkit' },
        san,
        privateKeyPem: pem,
        passphrase,
      });
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
      if (!envVar) badRequest(ctx, 'privateEnvVar is required');

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
      if (!certInput) badRequest(ctx, 'cert is required');
      try {
        const material = await loadBuffer(ctx, certInput);
        // Determine if it's binary DER (first byte 0x30) or PEM text.
        let source: string | Buffer = material.toString('utf8');
        if (material.length > 0 && material[0] === 0x30) source = material;
        const info = await inspectCert(source);
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
