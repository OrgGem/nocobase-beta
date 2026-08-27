import type { Application } from '@nocobase/server';
import type { Model } from '@nocobase/database';
import { ERROR_CODES, type EncryptionMode, type WireFormat } from '../../constants';
import { ApimError } from './errors';

export interface EncryptedPayload {
  body: Buffer;
  contentType?: string;
}

export interface DecryptedPayload {
  body: Buffer;
  /** Plaintext content type carried by the JSON wire envelope, when present. */
  contentType?: string;
}

export interface AesSecret {
  key?: Buffer;
  passphrase?: string;
}

interface RouteLike {
  get(name: string): unknown;
}

function routeField(route: RouteLike, name: string): string | undefined {
  const value = route.get(name);
  return value == null || value === '' ? undefined : String(value);
}

/**
 * The shape of the Crypto Toolkit public gateway API this plugin consumes.
 * Declared structurally so the toolkit can evolve independently; the runtime
 * check below still guards against a missing/incompatible plugin.
 */
export interface CryptoToolkitGatewayApi {
  encryptPayload: (options: {
    mode: EncryptionMode;
    wireFormat: WireFormat;
    plaintext: Buffer;
    plaintextContentType?: string;
    aesSecretEnvVar?: string;
    aesSecretEncrypted?: string;
    pgpEncryptKeyName?: string;
    pgpSignKeyName?: string;
    rsaEncryptKeyName?: string;
  }) => Promise<EncryptedPayload>;
  decryptPayload: (options: {
    mode: EncryptionMode;
    data: Buffer;
    contentType?: string;
    aesSecretEnvVar?: string;
    aesSecretEncrypted?: string;
    pgpDecryptKeyName?: string;
    pgpVerifyKeyName?: string;
    rsaDecryptKeyName?: string;
  }) => Promise<DecryptedPayload>;
  resolveAesSecret?: (route: RouteLike) => Promise<AesSecret>;
  resolveOwnPrivateKeyMaterial?: (keyRecord: Model) => Promise<{ material: string; passphrase?: string }>;
}

/**
 * The Crypto Toolkit plugin is the encryption backend for the gateway. All
 * payload crypto (AES-256-GCM NCB1, OpenPGP, RSA-OAEP NCR1) and key-material
 * resolution happens there; this adapter maps route records onto the toolkit's
 * public service API and translates errors into gateway error codes.
 */
function getCryptoToolkit(app: Application): CryptoToolkitGatewayApi {
  const toolkit = (app.pm?.get?.('crypto-toolkit') ?? app.pm?.get?.('plugin-crypto-toolkit')) as
    | Partial<CryptoToolkitGatewayApi>
    | undefined;
  if (!toolkit?.encryptPayload || !toolkit?.decryptPayload) {
    throw new ApimError(
      ERROR_CODES.CRYPTO_CONFIG,
      'plugin-crypto-toolkit is required for encrypted API routes; enable it and restart',
      500,
    );
  }
  return toolkit as CryptoToolkitGatewayApi;
}

export async function encryptPayload(
  app: Application,
  route: RouteLike,
  plaintext: Buffer,
  plaintextContentType?: string,
): Promise<EncryptedPayload> {
  const toolkit = getCryptoToolkit(app);
  try {
    return await toolkit.encryptPayload({
      mode: (routeField(route, 'encryptionMode') ?? 'none') as EncryptionMode,
      wireFormat: (routeField(route, 'wireFormat') ?? 'binary') as WireFormat,
      plaintext,
      plaintextContentType,
      aesSecretEnvVar: routeField(route, 'aesSecretEnvVar'),
      aesSecretEncrypted: routeField(route, 'aesSecret'),
      pgpEncryptKeyName: routeField(route, 'pgpEncryptKeyName'),
      pgpSignKeyName: routeField(route, 'pgpSignKeyName'),
      rsaEncryptKeyName: routeField(route, 'rsaEncryptKeyName'),
    });
  } catch (error) {
    throw toApimError(error);
  }
}

export async function decryptPayload(
  app: Application,
  route: RouteLike,
  raw: Buffer,
  contentType?: string,
): Promise<DecryptedPayload> {
  const toolkit = getCryptoToolkit(app);
  try {
    return await toolkit.decryptPayload({
      mode: (routeField(route, 'encryptionMode') ?? 'none') as EncryptionMode,
      data: raw,
      contentType,
      aesSecretEnvVar: routeField(route, 'aesSecretEnvVar'),
      aesSecretEncrypted: routeField(route, 'aesSecret'),
      pgpDecryptKeyName: routeField(route, 'pgpDecryptKeyName'),
      pgpVerifyKeyName: routeField(route, 'pgpVerifyKeyName'),
      rsaDecryptKeyName: routeField(route, 'rsaDecryptKeyName'),
    });
  } catch (error) {
    throw toApimError(error);
  }
}

/**
 * Resolve the AES secret referenced by a route record through the toolkit.
 * Kept for callers that need the raw secret (tests, diagnostics).
 */
export async function resolveAesSecret(app: Application, route: RouteLike): Promise<AesSecret> {
  const toolkit = getCryptoToolkit(app);
  try {
    return await toolkit.resolveAesSecret(route);
  } catch (error) {
    throw toApimError(error);
  }
}

/**
 * Resolve the own private key material (PGP armor / PEM + optional
 * passphrase) from a cryptoKeys row via the toolkit. Handles legacy
 * privateEnvVar names (missing `_PRIVATE`) and the `<envVar>_PASSPHRASE`
 * companion variable.
 */
export async function resolveOwnPrivateKeyMaterial(
  app: Application,
  keyRecord: Model,
): Promise<{ material: string; passphrase?: string }> {
  const toolkit = getCryptoToolkit(app);
  try {
    return await toolkit.resolveOwnPrivateKeyMaterial(keyRecord);
  } catch (error) {
    throw toApimError(error);
  }
}

/** Translate toolkit GatewayCryptoError codes into gateway ApimError codes. */
function toApimError(error: unknown): ApimError {
  if (error instanceof ApimError) return error;
  const candidate = error as { code?: string; message?: string; httpStatus?: number };
  if (typeof candidate.code === 'string' && candidate.code.startsWith('APIM_')) {
    return new ApimError(candidate.code, candidate.message ?? 'Crypto processing failed', candidate.httpStatus ?? 500);
  }
  return new ApimError(ERROR_CODES.CRYPTO_CONFIG, candidate.message ?? 'Crypto processing failed', 500);
}
