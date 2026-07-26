import type { Model, Repository } from '@nocobase/database';
import { Plugin } from '@nocobase/server';
import { createTestConnectionAction } from './actions/sftpgo-connections';
import { createSftpgoProxyActions } from './actions/sftpgo-proxy';
import { assertValidAddress, SftpgoClient, SftpgoConnectionConfig, SftpgoResourceType } from './sftpgo-client';
import { maskApiKey } from './utils/mask-api-key';

const MASK = '••••••••';
const ENCRYPTED_FIELDS = ['password', 'apiKey'] as const;
const API_KEY_SECRET_FIELD = 'encryptedSecret';
const PROXY_RESOURCES: { name: string; type: SftpgoResourceType }[] = [
  { name: 'sftpgoUsers', type: 'users' },
  { name: 'sftpgoFolders', type: 'folders' },
  { name: 'sftpgoApiKeys', type: 'apikeys' },
];

export class PluginSftpgoIntegrationServer extends Plugin {
  private clientCache = new Map<number, { configKey: string; client: SftpgoClient }>();

  async beforeLoad() {
    this.db.on('sftpgoConnections.beforeSave', async (model: Model) => {
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
    });

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
  async getClient(connection: Model): Promise<SftpgoClient> {
    const id = connection.get('id') as number;
    const config = await this.buildClientConfig(connection);
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
  public resolveEnv(val: string | null | undefined): string | null | undefined {
    if (!val || typeof val !== 'string') return val;
    return val.replace(/\{\{\s*\$env\.([a-zA-Z0-9_]+)\s*\}\}/g, (match, name) => this.getEnvVal(name) ?? match);
  }

  private getEnvVal(name: string): string | undefined {
    const envService = (this.app as unknown as { environment?: { getVariable?: (n: string) => unknown } }).environment;
    const value = envService?.getVariable?.(name);
    return value == null ? undefined : String(value);
  }

  async buildClient(connection: Model): Promise<SftpgoClient> {
    return new SftpgoClient(await this.buildClientConfig(connection));
  }

  private async buildClientConfig(connection: Model): Promise<SftpgoConnectionConfig> {
    const aes = this.app.aesEncryptor;
    let password: string | null = null;
    let apiKey: string | null = null;
    try {
      if (connection.get('password')) password = await aes.decrypt(connection.get('password') as string);
      if (connection.get('apiKey')) apiKey = await aes.decrypt(connection.get('apiKey') as string);
    } catch {
      throw new Error('Failed to decrypt SFTPGo credentials');
    }
    return {
      baseUrl: this.resolveEnv(connection.get('baseUrl') as string) || '',
      authMethod: connection.get('authMethod') as string,
      username: this.resolveEnv(connection.get('username') as string | null),
      password: this.resolveEnv(password),
      apiKey: this.resolveEnv(apiKey),
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
      if (ctx.action?.resourceName === 'sftpgoConnections' && ['create', 'update'].includes(ctx.action?.actionName)) {
        const values = ctx.action.params?.values as Record<string, unknown> | undefined;
        const body = (ctx.request as { body?: Record<string, unknown> }).body;
        for (const field of ENCRYPTED_FIELDS) {
          if (values && (values[field] === MASK || values[field] === '')) delete values[field];
          if (body && (body[field] === MASK || body[field] === '')) delete body[field];
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
      if (!ctx.body) return;
      const raw = ctx.body as { data?: unknown } | unknown[];
      const items: unknown[] = Array.isArray(raw)
        ? raw
        : (raw as { data?: unknown }).data
          ? Array.isArray((raw as { data: unknown }).data)
            ? (raw as { data: unknown[] }).data
            : [(raw as { data: unknown }).data]
          : [raw];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const record = item as Record<string, unknown> & { dataValues?: Record<string, unknown> };
        for (const field of ENCRYPTED_FIELDS) {
          if (record[field]) record[field] = MASK;
          if (record.dataValues?.[field]) record.dataValues[field] = MASK;
        }
      }
    });
  }
}

export default PluginSftpgoIntegrationServer;
