import type { Model } from '@nocobase/database';
import type { Application } from '@nocobase/server';
import { ERROR_CODES } from '../../constants';
import { ApimError } from './errors';
import { getEnv } from './env';
import { resolveOwnPrivateKeyMaterial } from './crypto-adapter';

interface RouteLike {
  get(name: string): unknown;
}

function routeField(route: RouteLike, name: string): string | undefined {
  const value = route.get(name);
  return value == null || value === '' ? undefined : String(value);
}

async function findCryptoKey(app: Application, name: string | undefined, label: string): Promise<Model> {
  if (!name) {
    throw new ApimError(ERROR_CODES.CRYPTO_CONFIG, `Route is missing ${label}`, 500);
  }
  const key = await app.db.getRepository('cryptoKeys').findOne({ filter: { name, enabled: true } });
  if (!key) {
    throw new ApimError(ERROR_CODES.CRYPTO_CONFIG, `Crypto Toolkit key "${name}" not found or disabled`, 500);
  }
  return key;
}

async function resolveOwnPrivateKeyPem(app: Application, keyRecord: Model): Promise<string> {
  const { material } = await resolveOwnPrivateKeyMaterial(app, keyRecord);
  return material;
}

/**
 * Resolves the RS256 private key PEM used to sign outbound JWTs.
 */
export async function resolveJwtSignPrivateKey(app: Application, route: RouteLike): Promise<string> {
  const keyRecord = await findCryptoKey(app, routeField(route, 'jwtSignKeyName'), 'a JWT sign key');
  return resolveOwnPrivateKeyPem(app, keyRecord);
}

/**
 * Resolves the RS256 public key PEM used to verify inbound JWTs.
 */
export async function resolveJwtVerifyPublicKey(app: Application, route: RouteLike): Promise<string> {
  const keyRecord = await findCryptoKey(app, routeField(route, 'jwtVerifyKeyName'), 'a JWT verify key');
  const pem = String(keyRecord.get('publicMaterial') ?? '');
  if (!pem) {
    throw new ApimError(ERROR_CODES.CRYPTO_CONFIG, 'JWT verify key has no public material', 500);
  }
  return pem;
}

/**
 * Resolves the HS256 shared secret from either an env variable or the encrypted field.
 */
export async function resolveJwtSecret(app: Application, route: RouteLike): Promise<string> {
  const getEnvVal = (name: string) => getEnv(app, name);
  const envVar = routeField(route, 'jwtSecretEnvVar');
  if (envVar) {
    const secret = getEnvVal(envVar);
    if (!secret) {
      throw new ApimError(ERROR_CODES.CRYPTO_CONFIG, `JWT secret env variable "${envVar}" is not set`, 500);
    }
    return secret;
  }
  const encrypted = routeField(route, 'jwtSecret');
  if (!encrypted) {
    throw new ApimError(ERROR_CODES.CRYPTO_CONFIG, 'Route has no JWT secret configured', 500);
  }
  return app.aesEncryptor.decrypt(encrypted);
}

/**
 * Resolves the HMAC shared secret from either an env variable or the encrypted field.
 */
export async function resolveHmacSecret(app: Application, route: RouteLike): Promise<string> {
  const getEnvVal = (name: string) => getEnv(app, name);
  const envVar = routeField(route, 'hmacSecretEnvVar');
  if (envVar) {
    const secret = getEnvVal(envVar);
    if (!secret) {
      throw new ApimError(ERROR_CODES.CRYPTO_CONFIG, `HMAC secret env variable "${envVar}" is not set`, 500);
    }
    return secret;
  }
  const encrypted = routeField(route, 'hmacSecret');
  if (!encrypted) {
    throw new ApimError(ERROR_CODES.CRYPTO_CONFIG, 'Route has no HMAC secret configured', 500);
  }
  return app.aesEncryptor.decrypt(encrypted);
}
