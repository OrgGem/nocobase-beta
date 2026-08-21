import path from 'path';
import type { Model, Repository } from '@nocobase/database';
import { Plugin } from '@nocobase/server';
import { createEnvGetter, resolveEnvValue } from './services/resolve-env';
import {
  decryptGatewayPayload,
  encryptGatewayPayload,
  resolveAesSecret as resolveAesSecretForGateway,
  resolveOwnPrivateKeyMaterial,
  type GatewayDecryptOptions,
  type GatewayDecryptedPayload,
  type GatewayEncryptOptions,
  type GatewayEncryptedPayload,
} from './services/gateway-crypto';
import { registerCryptoKeysResource } from './resources/keys';
import { registerCryptoOpsResource } from './resources/crypto-ops';

const PRIVATE_MATERIAL_RE = /-----BEGIN [^-]*PRIVATE KEY( BLOCK)?-----/;
const GENERATED_PRIVATE_ENV_RE = /^CRYPTO_TOOLKIT_[A-Z][A-Z0-9_]{0,47}_PRIVATE$/;
const OPERATION_RETENTION_DAYS = 30;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export class PluginCryptoToolkitServer extends Plugin {
  private pruneTimer?: NodeJS.Timeout;

  async beforeLoad() {
    // Safety net: private key material must never be persisted in cryptoKeys.
    this.db.on('cryptoKeys.beforeSave', async (model: Model) => {
      for (const key of Object.keys(model.dataValues ?? {})) {
        const value = model.get(key);
        if (typeof value === 'string' && PRIVATE_MATERIAL_RE.test(value)) {
          throw new Error(
            `Field "${key}" contains private key material. Private keys must be stored as secret environment variables, not in the database.`,
          );
        }
      }

      const privateEnvVar = model.get('privateEnvVar');
      if (privateEnvVar != null && privateEnvVar !== '') {
        if (typeof privateEnvVar !== 'string' || !GENERATED_PRIVATE_ENV_RE.test(privateEnvVar)) {
          throw new Error('privateEnvVar must reference a Crypto Toolkit-managed private environment variable');
        }
        if (model.get('direction') !== 'own') {
          throw new Error('only own Crypto Toolkit keys may reference private environment variables');
        }
      }
    });
  }

  async load() {
    this.db.import({ directory: path.resolve(__dirname, 'collections') });
    registerCryptoKeysResource(this.app);
    registerCryptoOpsResource(this.app);

    this.app.acl.registerSnippet({
      name: 'pm.plugin-crypto-toolkit',
      actions: ['cryptoKeys:*', 'crypto:*', 'cryptoOperations:list', 'cryptoOperations:get'],
    });

    this.app.on('afterStart', () => {
      this.pruneExpiredOperations();
      this.pruneTimer = setInterval(() => this.pruneExpiredOperations(), PRUNE_INTERVAL_MS);
    });
    this.app.on('beforeStop', () => {
      if (this.pruneTimer) {
        clearInterval(this.pruneTimer);
        this.pruneTimer = undefined;
      }
    });
  }

  public resolveEnv(val: string | null | undefined): string | null | undefined {
    return resolveEnvValue(val, createEnvGetter(this.app));
  }

  public getEnvVal(name: string): string | undefined {
    return createEnvGetter(this.app)(name);
  }

  /** Gateway integration: encrypt a payload for the API-manager wire. */
  public async encryptPayload(options: GatewayEncryptOptions): Promise<GatewayEncryptedPayload> {
    return encryptGatewayPayload(this.app, options);
  }

  /** Gateway integration: decrypt a payload from the API-manager wire. */
  public async decryptPayload(options: GatewayDecryptOptions): Promise<GatewayDecryptedPayload> {
    return decryptGatewayPayload(this.app, options);
  }

  /** Gateway integration: resolve the AES secret referenced by a route record. */
  public async resolveAesSecret(route: { get(name: string): unknown }) {
    return resolveAesSecretForGateway(this.app, route);
  }

  /** Gateway integration: resolve own private key material from a cryptoKeys row. */
  public async resolveOwnPrivateKeyMaterial(keyRecord: { get(name: string): unknown }) {
    return resolveOwnPrivateKeyMaterial(this.app, keyRecord);
  }

  private async pruneExpiredOperations() {
    try {
      const repo = this.db.getRepository('cryptoOperations') as Repository;
      const cutoff = new Date(Date.now() - OPERATION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
      await repo.destroy({ filter: { createdAt: { $lt: cutoff.toISOString() } } });
    } catch (error) {
      this.log.warn(`failed to prune cryptoOperations: ${(error as Error).message}`);
    }
  }
}

export default PluginCryptoToolkitServer;
