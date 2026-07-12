import type { Model } from '@nocobase/database';
import { Plugin } from '@nocobase/server';
import { createTestConnectionAction } from './actions/sftpgo-connections';
import { createSftpgoProxyActions } from './actions/sftpgo-proxy';
import { assertValidAddress, SftpgoClient, SftpgoResourceType } from './sftpgo-client';

const MASK = '••••••••';
const ENCRYPTED_FIELDS = ['password', 'apiKey'] as const;
const PROXY_RESOURCES: { name: string; type: SftpgoResourceType }[] = [
  { name: 'sftpgoUsers', type: 'users' },
  { name: 'sftpgoFolders', type: 'folders' },
  { name: 'sftpgoApiKeys', type: 'apikeys' },
];

export class PluginSftpgoIntegrationServer extends Plugin {
  private clientCache = new Map<number, SftpgoClient>();

  async beforeLoad() {
    this.db.on('sftpgoConnections.beforeSave', async (model: Model) => {
      if (model.changed('baseUrl')) {
        assertValidAddress(model.get('baseUrl') as string);
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
   * bearer token (and its TTL) is reused across requests.  The cache is
   * invalidated automatically when the connection row is saved or deleted.
   */
  async getClient(connection: Model): Promise<SftpgoClient> {
    const id = connection.get('id') as number;
    let client = this.clientCache.get(id);
    if (!client) {
      client = await this.buildClient(connection);
      this.clientCache.set(id, client);
    }
    return client;
  }

  async buildClient(connection: Model): Promise<SftpgoClient> {
    const aes = this.app.aesEncryptor;
    let password: string | null = null;
    let apiKey: string | null = null;
    try {
      if (connection.get('password')) password = await aes.decrypt(connection.get('password') as string);
      if (connection.get('apiKey')) apiKey = await aes.decrypt(connection.get('apiKey') as string);
    } catch {
      throw new Error('Failed to decrypt SFTPGo credentials');
    }
    return new SftpgoClient({
      baseUrl: connection.get('baseUrl') as string,
      authMethod: connection.get('authMethod') as string,
      username: connection.get('username') as string | null,
      password,
      apiKey,
    });
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
