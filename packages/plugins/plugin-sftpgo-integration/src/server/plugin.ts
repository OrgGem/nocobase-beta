// SPDX-License-Identifier: Apache-2.0

import type { Model, Repository } from '@nocobase/database';
import { Plugin } from '@nocobase/server';
import { createTestConnectionAction } from './actions/sftpgo-connections';
import { createSftpgoProxyActions } from './actions/sftpgo-proxy';
import { assertValidAddress, SftpgoClient, SftpgoConnectionConfig, SftpgoResourceType } from './sftpgo-client';
import { maskApiKey } from './utils/mask-api-key';
import {
  type EnvironmentPermissionContext,
  hasEnvironmentPermission,
  SftpgoEnvironmentPermissionError,
} from './utils/environment-permission';

const MASK = '••••••••';
const ENCRYPTED_FIELDS = ['password', 'apiKey'] as const;
const CONNECTION_AUTH_FIELDS = ['baseUrl', 'authMethod', 'username', ...ENCRYPTED_FIELDS] as const;
const ENV_REFERENCE = /\{\{\s*\$env\.([a-zA-Z0-9_]+)\s*\}\}/;
const API_KEY_SECRET_FIELD = 'encryptedSecret';
const API_KEY_SECRETS_COLLECTION = 'sftpgoApiKeySecrets';
const CONNECTIONS_COLLECTION = 'sftpgoConnections';
const PROXY_RESOURCES: { name: string; type: SftpgoResourceType }[] = [
  { name: 'sftpgoUsers', type: 'users' },
  { name: 'sftpgoFolders', type: 'folders' },
  { name: 'sftpgoApiKeys', type: 'apikeys' },
];

export class PluginSftpgoIntegrationServer extends Plugin {
  private clientCache = new Map<number, { configKey: string; client: SftpgoClient }>();

  async beforeLoad() {
    this.db.on(
      'sftpgoConnections.beforeSave',
      async (model: Model, options?: { context?: EnvironmentPermissionContext }) => {
        if (options?.context && (model.isNewRecord || CONNECTION_AUTH_FIELDS.some((field) => model.changed(field)))) {
          let hasCredentialReference = false;
          for (const field of ENCRYPTED_FIELDS) {
            const value = model.get(field) as string | null;
            if (!value) continue;
            const credential = model.changed(field) ? value : await this.app.aesEncryptor.decrypt(value);
            if (ENV_REFERENCE.test(credential)) {
              hasCredentialReference = true;
              break;
            }
          }
          if (hasCredentialReference && !hasEnvironmentPermission(options.context)) {
            throw new SftpgoEnvironmentPermissionError();
          }
        }
        if (model.changed('baseUrl')) {
          // validate the resolved address so `{{$env.X}}` templates can be stored
          assertValidAddress(this.resolveEnv(model.get('baseUrl') as string) || '');
        }
        for (const field of ENCRYPTED_FIELDS) {
          if (model.changed(field) && model.get(field)) {
            const encrypted = await this.app.aesEncryptor.encrypt(model.get(field) as string);
            model.set(field, encrypted);
          }
        }
      },
    );

    // Invalidate cached SftpgoClient when a connection changes or is removed
    this.db.on('sftpgoConnections.afterSave', async (model: Model) => {
      this.clientCache.delete(model.get('id') as number);
    });
    this.db.on('sftpgoConnections.afterDestroy', async (model: Model) => {
      this.clientCache.delete(model.get('id') as number);
    });

    this.db.on('sftpgoApiKeySecrets.beforeSave', async (model: Model) => {
      if (model.changed(API_KEY_SECRET_FIELD) && model.get(API_KEY_SECRET_FIELD)) {
        const encrypted = await this.app.aesEncryptor.encrypt(model.get(API_KEY_SECRET_FIELD) as string);
        model.set(API_KEY_SECRET_FIELD, encrypted);
      }
    });
  }

  async load() {
    // The request logger serializes action parameters after downstream handling, even when an action fails.
    this.app.use(
      async (ctx, next) => {
        try {
          await next();
        } finally {
          if (ctx.action?.resourceName === 'sftpgoConnections') {
            const redactValues = (values: unknown) => {
              const records = Array.isArray(values) ? values : [values];
              for (const value of records) {
                if (!value || typeof value !== 'object') continue;
                const record = value as Record<string, unknown>;
                for (const field of ENCRYPTED_FIELDS) {
                  if (field in record) record[field] = MASK;
                }
              }
            };
            redactValues(ctx.action.params?.values);
            redactValues(ctx.request.body);
          }
        }
      },
      { tag: 'sftpgo-connection-log-redaction', after: 'logger', before: 'dataSource' },
    );
    this.app.resourceManager.use(
      async (ctx, next) => {
        const resourceName = ctx.action?.resourceName;
        if (typeof resourceName !== 'string') return next();

        const [sourceName, associationName] = resourceName.split('.');
        const params = ctx.action.params || {};
        const values = Array.isArray(params.values) ? params.values : [params.values];
        const invalidConnectionTarget =
          resourceName === CONNECTIONS_COLLECTION &&
          ((Object.prototype.hasOwnProperty.call(params, 'targetCollection') &&
            params.targetCollection !== CONNECTIONS_COLLECTION) ||
            values.some(
              (value) =>
                value &&
                typeof value === 'object' &&
                Object.prototype.hasOwnProperty.call(value, '__collection') &&
                value.__collection !== CONNECTIONS_COLLECTION,
            ));
        let targetsSecrets =
          sourceName === API_KEY_SECRETS_COLLECTION ||
          params.targetCollection === API_KEY_SECRETS_COLLECTION ||
          values.some(
            (value) => value && typeof value === 'object' && value.__collection === API_KEY_SECRETS_COLLECTION,
          );

        if (!targetsSecrets && associationName) {
          const source = this.db.getCollection(sourceName);
          if (source) {
            targetsSecrets = this.db.getCollection(resourceName)?.name === API_KEY_SECRETS_COLLECTION;
            if (!targetsSecrets && source.model.associations[associationName]) {
              const repository = ctx.getCurrentRepository();
              targetsSecrets =
                repository?.sourceCollection?.name === API_KEY_SECRETS_COLLECTION ||
                repository?.targetCollection?.name === API_KEY_SECRETS_COLLECTION;
            }
          }
        }

        if (targetsSecrets || invalidConnectionTarget) {
          return ctx.throw(403, ctx.t('No permissions', { ns: 'plugin-sftpgo-integration' }));
        }
        return next();
      },
      { tag: 'sftpgo-private-secrets', after: 'acl' },
    );
    this.registerMaskingMiddleware();

    for (const { name, type } of PROXY_RESOURCES) {
      this.app.resourceManager.define({
        name,
        actions: createSftpgoProxyActions(this, type),
      });
    }
    this.app.resourceManager.registerActionHandlers({
      'sftpgoConnections:testConnection': createTestConnectionAction(this),
    });

    this.app.acl.registerSnippet({
      name: 'pm.plugin-sftpgo-integration',
      actions: ['sftpgoConnections:*', 'sftpgoUsers:*', 'sftpgoFolders:*', 'sftpgoApiKeys:*'],
    });
  }

  /**
   * Return a cached SftpgoClient for the given connection so the admin
   * bearer token (and its TTL) is reused across requests.  The cache entry
   * is keyed by the resolved config, so changing the connection row or a
   * referenced environment variable produces a fresh client.
   */
  async getClient(connection: Model, context?: EnvironmentPermissionContext): Promise<SftpgoClient> {
    const id = connection.get('id') as number;
    const config = await this.buildClientConfig(connection, context);
    const configKey = JSON.stringify(config);
    const cached = this.clientCache.get(id);
    if (cached && cached.configKey === configKey) {
      return cached.client;
    }
    const client = new SftpgoClient(config);
    this.clientCache.set(id, { configKey, client });
    return client;
  }

  /**
   * Expand `{{$env.NAME}}` references using the app environment service
   * (Variables and secrets plugin). Only this braced syntax is supported so
   * literal credentials can never be partially rewritten; unknown variables
   * are left untouched.
   */
  public resolveEnv(val: string | null | undefined, allowSecrets = false): string | null | undefined {
    if (!val || typeof val !== 'string') return val;
    return val.replace(/\{\{\s*\$env\.([a-zA-Z0-9_]+)\s*\}\}/g, (match, name) => {
      return this.getEnvVal(name, allowSecrets) ?? match;
    });
  }

  private getEnvVal(name: string, allowSecrets: boolean): string | undefined {
    const variables = (
      allowSecrets ? this.app.environment.getVariablesAndSecrets() : this.app.environment.getNonSecretVariables()
    ) as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(variables, name)) return undefined;
    const value = variables[name];
    return value == null ? undefined : String(value);
  }

  async buildClient(connection: Model, context?: EnvironmentPermissionContext): Promise<SftpgoClient> {
    return new SftpgoClient(await this.buildClientConfig(connection, context));
  }

  private async buildClientConfig(
    connection: Model,
    context?: EnvironmentPermissionContext,
  ): Promise<SftpgoConnectionConfig> {
    const aes = this.app.aesEncryptor;
    const authMethod = connection.get('authMethod') as string;
    let password: string | null = null;
    let apiKey: string | null = null;
    try {
      if (authMethod === 'apikey') {
        if (connection.get('apiKey')) apiKey = await aes.decrypt(connection.get('apiKey') as string);
      } else if (connection.get('password')) {
        password = await aes.decrypt(connection.get('password') as string);
      }
    } catch {
      throw new Error('Failed to decrypt SFTPGo credentials');
    }
    if (!hasEnvironmentPermission(context)) {
      const allVariables = this.app.environment.getVariablesAndSecrets() as Record<string, unknown>;
      const nonSecretVariables = this.app.environment.getNonSecretVariables() as Record<string, unknown>;
      const containsSecret = [password, apiKey].some((credential) => {
        if (!credential) return false;
        return Array.from(credential.matchAll(/\{\{\s*\$env\.([a-zA-Z0-9_]+)\s*\}\}/g)).some((match) => {
          const name = match[1];
          return (
            Object.prototype.hasOwnProperty.call(allVariables, name) &&
            !Object.prototype.hasOwnProperty.call(nonSecretVariables, name)
          );
        });
      });
      if (containsSecret) throw new SftpgoEnvironmentPermissionError();
    }
    return {
      baseUrl: this.resolveEnv(connection.get('baseUrl') as string) || '',
      authMethod,
      username: this.resolveEnv(connection.get('username') as string | null),
      password: this.resolveEnv(password, true),
      apiKey: this.resolveEnv(apiKey, true),
    };
  }

  async saveApiKeySecret(connectionId: number, apiKeyId: string, name: string, secret: string) {
    const repo = this.db.getRepository('sftpgoApiKeySecrets') as Repository;
    const existing = await repo.findOne({ filter: { connectionId, apiKeyId } });
    if (existing) {
      await existing.update({ name, encryptedSecret: secret });
      return;
    }
    await repo.create({ values: { connectionId, apiKeyId, name, encryptedSecret: secret } });
  }

  async attachMaskedApiKeySecrets(connectionId: number, apiKeys: unknown[]): Promise<unknown[]> {
    const repo = this.db.getRepository('sftpgoApiKeySecrets') as Repository;
    const records = await repo.find({ filter: { connectionId } });
    const secretsById = new Map<string, Model>();
    for (const record of records) {
      secretsById.set(String(record.get('apiKeyId')), record);
    }

    return Promise.all(
      apiKeys.map(async (apiKey) => {
        if (!apiKey || typeof apiKey !== 'object') return apiKey;
        const item = apiKey as Record<string, unknown>;
        const record = secretsById.get(String(item.id));
        if (!record) return { ...item, maskedKey: null };
        try {
          const secret = await this.app.aesEncryptor.decrypt(record.get(API_KEY_SECRET_FIELD) as string);
          return { ...item, maskedKey: maskApiKey(secret) };
        } catch {
          return { ...item, maskedKey: null };
        }
      }),
    );
  }

  async deleteApiKeySecret(connectionId: number, apiKeyId: string) {
    const repo = this.db.getRepository('sftpgoApiKeySecrets') as Repository;
    await repo.destroy({ filter: { connectionId, apiKeyId } });
  }

  private registerMaskingMiddleware() {
    // strip masked placeholders so an unchanged form submit keeps stored credentials
    this.app.resourceManager.use(async (ctx, next) => {
      if (
        ctx.action?.resourceName === 'sftpgoConnections' &&
        ['create', 'update', 'firstOrCreate', 'updateOrCreate'].includes(ctx.action?.actionName)
      ) {
        for (const source of [ctx.action.params?.values, ctx.request.body]) {
          const records = Array.isArray(source) ? source : [source];
          for (const value of records) {
            if (!value || typeof value !== 'object') continue;
            const record = value as Record<string, unknown>;
            for (const field of ENCRYPTED_FIELDS) {
              if (record[field] === MASK || record[field] === '') delete record[field];
            }
          }
        }
      }
      return next();
    });

    // mask credentials on every sftpgoConnections response
    this.app.resourceManager.use(async (ctx, next) => {
      if (ctx.action?.resourceName !== 'sftpgoConnections') {
        return next();
      }
      await next();
      const maskResponse = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(maskResponse);
        if (!value || typeof value !== 'object') return value;
        const model = value as { toJSON?: () => unknown };
        const serialized = typeof model.toJSON === 'function' ? model.toJSON() : value;
        if (!serialized || typeof serialized !== 'object') return serialized;
        const record = { ...(serialized as Record<string, unknown>) };
        for (const field of ['data', 'rows', 'dataValues']) {
          if (field in record) record[field] = maskResponse(record[field]);
        }
        for (const field of ENCRYPTED_FIELDS) {
          if (record[field]) record[field] = MASK;
        }
        return record;
      };
      ctx.body = maskResponse(ctx.body);
    });
  }
}

export default PluginSftpgoIntegrationServer;
