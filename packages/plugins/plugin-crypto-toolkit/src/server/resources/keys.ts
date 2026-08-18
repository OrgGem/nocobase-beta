import { createHash, createPublicKey } from 'crypto';
import type { Application } from '@nocobase/server';
import type { Repository, Model } from '@nocobase/database';
import type { Handlers, ResourcerContext } from '@nocobase/resourcer';
import { generateRawKeyPair, sha256Hex } from '../services/crypto-core';
import { generateSshKey, pemToOpenSshPublic } from '../services/ssh-key-service';
import { generatePgpKey } from '../services/pgp-service';
import type { KeyMaterialInput } from '../services/load-key-material';
import { loadRawMaterial } from '../services/load-key-material';

type Kind = 'pgp-rsa4096' | 'pgp-curve25519' | 'rsa-4096' | 'ed25519' | 'ssh-ed25519' | 'ssh-rsa';

type Direction = 'own' | 'partner';
type Purpose = 'encrypt' | 'sign' | 'both';
type PublicFormat = 'pem' | 'openpgp' | 'openssh';

const PRIVATE_MATERIAL_RE = /-----BEGIN [^-]*PRIVATE KEY( BLOCK)?-----/;
const GENERATED_ENV_PREFIX = 'CRYPTO_TOOLKIT_';
const ENV_BASENAME_RE = /^[A-Z][A-Z0-9_]{0,47}$/;

const VALID_PGP_KINDS: Kind[] = ['pgp-rsa4096', 'pgp-curve25519'];
const VALID_RAW_KINDS: Kind[] = ['rsa-4096', 'ed25519'];
const VALID_SSH_KINDS: Kind[] = ['ssh-ed25519', 'ssh-rsa'];

type CryptoKeysRepo = Repository;

class CryptoToolkitHttpError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'CryptoToolkitHttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

// The error-handler middleware renders status from `err.statusCode` and the body
// from `err.message`/`err.code`; setting `ctx.status` and then throwing a plain
// Error would be overwritten to 500, so validation failures must be thrown as
// typed errors carrying the intended status.
function badRequest(message: string): never {
  throw new CryptoToolkitHttpError(400, 'CRYPTOTOOLKIT_BAD_REQUEST', message);
}

function notFound(message: string): never {
  throw new CryptoToolkitHttpError(404, 'CRYPTOTOOLKIT_NOT_FOUND', message);
}

function readBody(ctx: ResourcerContext): Record<string, unknown> {
  const body = ctx.request?.body;
  if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  return {};
}

function generatedEnvNames(baseName: string): { privateName: string; publicName: string } {
  if (!ENV_BASENAME_RE.test(baseName)) {
    throw new Error('envVarName must use uppercase letters, digits, and underscores, and start with a letter');
  }
  const prefix = `${GENERATED_ENV_PREFIX}${baseName}`;
  return { privateName: `${prefix}_PRIVATE`, publicName: `${prefix}_PUBLIC` };
}

function isGeneratedPrivateEnvName(name: string): boolean {
  return new RegExp(`^${GENERATED_ENV_PREFIX}[A-Z][A-Z0-9_]{0,47}_PRIVATE$`).test(name);
}

async function ensureSecretEnv(app: Application, name: string, value: string, transaction: unknown): Promise<void> {
  const repo = app.db.getRepository('environmentVariables');
  const existing = await repo.findOne({ filter: { name }, transaction } as never);
  if (existing) {
    throw new Error(`environment variable '${name}' already exists`);
  }
  await repo.create({ values: { name, type: 'secret', value }, transaction } as never);
}

async function deleteGeneratedEnvPair(app: Application, privateName: string): Promise<void> {
  if (!isGeneratedPrivateEnvName(privateName)) return;
  try {
    await app.db.getRepository('environmentVariables').destroy({
      filter: { name: { $in: [privateName, privateName.replace(/_PRIVATE$/, '_PUBLIC')] } },
    });
  } catch (error) {
    (app as unknown as { log?: { warn: (m: string) => void } }).log?.warn?.(
      `failed to delete generated crypto environment variables: ${(error as Error).message}`,
    );
  }
}

interface GeneratedMaterial {
  publicMaterial: string;
  publicFormat: PublicFormat;
  privateMaterial: string;
  fingerprint: string;
}

async function generateForKind(
  kind: Kind,
  passphrase: string | undefined,
  envVarComment: string,
): Promise<GeneratedMaterial> {
  if (VALID_PGP_KINDS.includes(kind)) {
    const isRsa = kind === 'pgp-rsa4096';
    const result = await generatePgpKey({
      userIds: [{ name: envVarComment }],
      type: isRsa ? 'rsa' : 'ecc',
      curve: 'curve25519',
      rsaBits: 4096,
      passphrase,
    });
    const fingerprint = await fingerprintPgp(result.publicKey);
    return {
      publicMaterial: result.publicKey,
      publicFormat: 'openpgp',
      privateMaterial: result.privateKey,
      fingerprint,
    };
  }
  if (VALID_RAW_KINDS.includes(kind)) {
    const { publicKey, publicPem, privatePem } = generateRawKeyPair(kind === 'rsa-4096' ? 'rsa-4096' : 'ed25519');
    const der = publicKey.export({ type: 'spki', format: 'der' });
    const fp = sha256Hex(Buffer.isBuffer(der) ? der : Buffer.from(der));
    return {
      publicMaterial: publicPem,
      publicFormat: 'pem',
      privateMaterial: privatePem,
      fingerprint: 'SHA256:' + fp,
    };
  }
  if (VALID_SSH_KINDS.includes(kind)) {
    const pair = generateSshKey(kind === 'ssh-rsa' ? 'rsa-4096' : 'ed25519', envVarComment);
    return {
      publicMaterial: pair.publicOpenSsh,
      publicFormat: 'openssh',
      privateMaterial: pair.privateOpenSsh,
      fingerprint: pair.fingerprint,
    };
  }
  throw new Error(`Unknown kind: ${kind}`);
}

async function fingerprintPgp(armoredPublic: string): Promise<string> {
  const openpgp = await import('openpgp');
  const pk = await openpgp.readKey({ armoredKey: armoredPublic });
  return pk.getFingerprint().toUpperCase();
}

async function fingerprintPem(pem: string): Promise<string> {
  try {
    const pk = createPublicKey(pem);
    const der = pk.export({ type: 'spki', format: 'der' });
    const buf = Buffer.isBuffer(der) ? der : Buffer.from(der as ArrayBuffer);
    return 'SHA256:' + sha256Hex(buf);
  } catch {
    return 'SHA256:' + createHash('sha256').update(pem).digest('hex');
  }
}

function canonicalPublicPem(pem: string): string {
  if (!/-----BEGIN/.test(pem)) return pem;
  try {
    const pk = createPublicKey(pem);
    return pk.export({ type: 'spki', format: 'pem' }) as string;
  } catch {
    return pem;
  }
}

function checkNotPrivate(value: string, field: string) {
  if (PRIVATE_MATERIAL_RE.test(value)) {
    throw new CryptoToolkitHttpError(
      400,
      'CRYPTOTOOLKIT_BAD_REQUEST',
      `${field} contains private key material. Partners get public material only; import does not accept private keys for direction='partner'.`,
    );
  }
}

function getCurrentUserId(ctx: ResourcerContext): number | null {
  const user = ctx.auth?.user as { id?: number } | undefined;
  return user?.id ?? null;
}

export function registerCryptoKeysResource(app: Application): void {
  const handlers: Handlers = {
    async generate(ctx, next) {
      const body = readBody(ctx);
      const name = String(body.name ?? '').trim();
      const kind = body.kind as Kind | undefined;
      const direction: Direction = (body.direction as Direction) ?? 'own';
      const purpose: Purpose = (body.purpose as Purpose) ?? 'both';
      const passphrase = typeof body.passphrase === 'string' && body.passphrase ? body.passphrase : undefined;
      const saveToEnv = Boolean(body.saveToEnv);
      const envVarName = typeof body.envVarName === 'string' ? body.envVarName.trim() : '';
      const displayName = typeof body.displayName === 'string' ? body.displayName : '';

      if (!name) return badRequest('name is required');
      if (!kind) return badRequest('kind is required');
      if (direction === 'partner') return badRequest('Cannot generate a partner key; use import instead');
      if (saveToEnv && !envVarName) return badRequest('saveToEnv=true requires envVarName');
      if (saveToEnv && !ENV_BASENAME_RE.test(envVarName)) {
        return badRequest('envVarName must use uppercase letters, digits, and underscores, and start with a letter');
      }

      const repo: CryptoKeysRepo = app.db.getRepository('cryptoKeys');
      const existing = await repo.findOne({ filter: { name } });
      if (existing) return badRequest(`cryptoKey '${name}' already exists`);

      const userId = getCurrentUserId(ctx);
      if (userId === null) return badRequest('an authenticated user is required');
      const envNames = saveToEnv ? generatedEnvNames(envVarName) : undefined;

      const envVarComment = envNames?.privateName ?? `${name}@nocobase-crypto-toolkit`;
      const generated = await generateForKind(kind, passphrase, envVarComment);

      const values = {
        name,
        displayName,
        kind,
        direction,
        purpose,
        fingerprint: generated.fingerprint,
        publicMaterial: generated.publicMaterial,
        publicFormat: generated.publicFormat,
        privateEnvVar: envNames?.privateName ?? null,
        enabled: true,
        createdById: userId,
        updatedById: userId,
      };
      const row = (
        envNames
          ? await app.db.sequelize.transaction(async (transaction) => {
              await ensureSecretEnv(app, envNames.privateName, generated.privateMaterial, transaction);
              await ensureSecretEnv(app, envNames.publicName, generated.publicMaterial, transaction);
              return repo.create({ values, transaction } as never);
            })
          : await repo.create({ values } as never)
      ) as Model;

      ctx.body = {
        ok: true,
        key: row.toJSON(),
        publicMaterial: generated.publicMaterial,
        publicFormat: generated.publicFormat,
        fingerprint: generated.fingerprint,
        privateMaterial: generated.privateMaterial,
        savedToEnv: saveToEnv,
        envVarName: envNames?.privateName ?? null,
      };
      await next();
    },

    async importKey(ctx, next) {
      const body = readBody(ctx);
      const name = String(body.name ?? '').trim();
      const direction: Direction = ((body.direction as Direction) ?? 'partner') as Direction;
      const purpose: Purpose = (body.purpose as Purpose) ?? 'both';
      const displayName = typeof body.displayName === 'string' ? body.displayName : '';
      const kindHint = body.kind as Kind | undefined;
      const key = body.key as KeyMaterialInput | undefined;

      if (!name) return badRequest('name is required');
      if (direction !== 'partner') return badRequest("import only accepts direction='partner'");
      if (!key) return badRequest('key is required');

      const userId = getCurrentUserId(ctx);
      if (userId === null) return badRequest('an authenticated user is required');
      // Load raw bytes without key detection: detection would try to parse a
      // private key and throw a decoder error before we can reject it cleanly.
      const loaded = await loadRawMaterial(app, key, { attachmentOwnerId: userId });
      const materialText = loaded.buffer.toString('utf8');
      checkNotPrivate(materialText, 'key');

      let publicMaterial = materialText;
      let publicFormat: PublicFormat = 'pem';
      let fingerprint = '';

      const low = materialText.trim();
      if (/-----BEGIN PGP PUBLIC KEY BLOCK-----/.test(low)) {
        publicFormat = 'openpgp';
        fingerprint = await fingerprintPgp(low);
      } else if (/-----BEGIN/.test(low)) {
        publicFormat = 'pem';
        const canonical = canonicalPublicPem(low);
        publicMaterial = canonical;
        fingerprint = await fingerprintPem(canonical);
      } else if (low.startsWith('ssh-')) {
        publicFormat = 'openssh';
        const sshpk = await import('sshpk');
        const k = sshpk.parseKey(low, 'ssh');
        publicMaterial = k.toString('ssh', { comment: k.comment || `${name}@nocobase` });
        fingerprint = k.fingerprint('sha256').toString();
      } else {
        return badRequest('Unrecognized key material — expected PEM, OpenPGP armored, or OpenSSH public line');
      }

      const repo: CryptoKeysRepo = app.db.getRepository('cryptoKeys');
      const existing = await repo.findOne({ filter: { name } });
      if (existing) return badRequest(`cryptoKey '${name}' already exists`);

      const row = (await repo.create({
        values: {
          name,
          displayName,
          kind:
            kindHint ??
            (publicFormat === 'openpgp' ? 'pgp-rsa4096' : publicFormat === 'openssh' ? 'ssh-ed25519' : 'rsa-4096'),
          direction,
          purpose,
          fingerprint,
          publicMaterial,
          publicFormat,
          enabled: true,
          createdById: userId,
          updatedById: userId,
        },
      } as never)) as Model;

      ctx.body = {
        ok: true,
        key: row.toJSON(),
        fingerprint,
        publicFormat,
      };
      await next();
    },

    async exportKey(ctx, next) {
      const filterByTk = String(ctx.request?.query?.filterByTk ?? '');
      const format = String(ctx.request?.query?.format ?? 'pem') as 'pem' | 'openssh' | 'armored';
      if (!filterByTk) return badRequest('filterByTk is required');

      const repo = app.db.getRepository('cryptoKeys');
      const row = (await repo.findOne({ filter: { id: filterByTk } })) as Model | null;
      if (!row) return notFound(`cryptoKey ${filterByTk} not found`);

      const publicMaterial = String(row.get('publicMaterial') ?? '');
      const publicFormat = String(row.get('publicFormat') ?? 'pem');

      let content = publicMaterial;
      let filename = `${row.get('name')}-pub`;
      let contentType = 'application/x-pem-file';

      if (publicFormat === 'pem') {
        if (format === 'pem') {
          content = publicMaterial;
          filename += '.pem';
        } else if (format === 'openssh') {
          content = pemToOpenSshPublic(publicMaterial, `${row.get('name')}@nocobase`);
          filename += '.pub';
          contentType = 'text/plain';
        } else {
          content = publicMaterial;
        }
      } else if (publicFormat === 'openpgp') {
        content = publicMaterial;
        filename += format === 'armored' ? '.asc' : '.pem';
        contentType = 'application/pgp-keys';
      } else if (publicFormat === 'openssh') {
        content = publicMaterial;
        filename += '.pub';
        contentType = 'text/plain';
        if (format === 'pem') {
          const sshpk = await import('sshpk');
          const key = sshpk.parseKey(publicMaterial, 'ssh');
          content = key.toString('pem');
          filename += '.pem';
          contentType = 'application/x-pem-file';
        }
      }

      ctx.body = {
        ok: true,
        filename,
        contentType,
        content,
        fingerprint: row.get('fingerprint'),
      };
      await next();
    },

    async destroy(ctx, next) {
      const filterByTk = String(ctx.request?.query?.filterByTk ?? '');
      if (!filterByTk) return badRequest('filterByTk is required');
      const repo = app.db.getRepository('cryptoKeys');
      const row = (await repo.findOne({ filter: { id: filterByTk } })) as Model | null;
      if (row) {
        const envName = String(row.get('privateEnvVar') ?? '');
        if (envName) {
          await deleteGeneratedEnvPair(app, envName);
        }
      }
      await repo.destroy({ filter: { id: filterByTk } });
      ctx.body = { ok: true };
      await next();
    },
  };

  app.resourceManager.define({
    name: 'cryptoKeys',
    actions: handlers,
  });
}
