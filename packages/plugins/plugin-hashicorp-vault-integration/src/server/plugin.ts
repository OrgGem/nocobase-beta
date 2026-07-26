import type { Model, Repository, Transaction } from '@nocobase/database';
import { Plugin } from '@nocobase/server';
import type { CronJob } from 'cron';
import { createVaultConnectionActions } from './actions/vault-connections';
import { createVaultActions } from './actions/vault';
import { SecretCache } from './secret-cache';
import { SyncService } from './sync-service';
import { toSafeErrorMessage } from './utils/redact';
import { assertSafePath, assertValidAddress } from './vault-client';

const MASK = '••••••••';
const ENCRYPTED_FIELDS = ['token', 'secretId'] as const;
const VARIABLE_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class PluginHashicorpVaultIntegrationServer extends Plugin {
  cache = new SecretCache();
  sync = new SyncService(this, this.cache);
  private cronJob: CronJob | null = null;

  async beforeLoad() {
    this.db.on('vaultConnections.beforeSave', async (model: Model) => {
      if (model.changed('address')) {
        assertValidAddress(model.get('address') as string);
      }
      for (const field of ENCRYPTED_FIELDS) {
        if (model.changed(field) && model.get(field)) {
          const encrypted = await this.app.aesEncryptor.encrypt(model.get(field) as string);
          model.set(field, encrypted);
        }
      }
    });

    this.db.on('vaultSecretMappings.beforeSave', async (model: Model) => {
      if (model.changed('variableKey')) {
        const key = model.get('variableKey') as string;
        if (!VARIABLE_KEY_PATTERN.test(key)) {
          throw new Error(
            `Invalid variable key "${key}": use letters, digits and underscores, not starting with a digit`,
          );
        }
      }
      if (model.changed('secretPath')) {
        assertSafePath(model.get('secretPath') as string);
      }
      const direction = (model.get('direction') as string | null) || 'pull';
      const envVariable = (model.get('envVariable') as string | null) || null;
      if (direction === 'push' && !envVariable) {
        throw new Error('envVariable is required when direction is "push"');
      }
      if (envVariable) {
        await this.assertEnvironmentVariableExists(envVariable);
      }
    });

    this.db.on('vaultSecretMappings.afterSave', async (model: Model, options: { transaction?: Transaction }) => {
      const previousKey = model.previous('variableKey') as string | undefined;
      const key = model.get('variableKey') as string;
      if (previousKey && previousKey !== key) {
        this.cache.invalidate(previousKey);
      }
      this.cache.invalidate(key);
      await this.sendSyncMessage({ type: 'vaultRefresh' }, { transaction: options?.transaction });
    });

    this.db.on('vaultSecretMappings.afterDestroy', async (model: Model, options: { transaction?: Transaction }) => {
      this.cache.invalidate(model.get('variableKey') as string);
      await this.sendSyncMessage({ type: 'vaultRefresh' }, { transaction: options?.transaction });
    });

    const onConnectionChanged = async (_model: Model, options: { transaction?: Transaction }) => {
      this.cache.clear();
      await this.sendSyncMessage({ type: 'vaultRefresh' }, { transaction: options?.transaction });
    };
    this.db.on('vaultConnections.afterSave', onConnectionChanged);
    this.db.on('vaultConnections.afterDestroy', onConnectionChanged);
  }

  async load() {
    this.registerMaskingMiddleware();

    this.app.resourceManager.define({
      name: 'vault',
      actions: createVaultActions(this),
    });
    const connectionActions = createVaultConnectionActions(this);
    this.app.resourceManager.registerActionHandlers({
      'vaultConnections:testConnection': connectionActions.testConnection,
      'vaultConnections:listPaths': connectionActions.listPaths,
      'vaultConnections:listAllPaths': connectionActions.listAllPaths,
      'vaultConnections:writeSecret': connectionActions.writeSecret,
      'vaultConnections:listSecretKeys': connectionActions.listSecretKeys,
    });

    this.app.acl.allow('vault', ['resolve', 'listKeys'], 'loggedIn');
    this.app.acl.registerSnippet({
      name: 'pm.plugin-hashicorp-vault-integration',
      actions: ['vaultConnections:*', 'vaultSecretMappings:*', 'vault:syncNow'],
    });

    this.app.on('afterStart', async () => {
      try {
        await this.sync.tick();
      } catch (err) {
        this.log.warn(`vault initial sync failed: ${toSafeErrorMessage(err)}`);
      }
    });

    this.scheduleSyncJob();
  }

  async handleSyncMessage(message: { type?: string }) {
    if (message?.type === 'vaultRefresh') {
      this.cache.clear();
      try {
        await this.sync.tick();
      } catch (err) {
        this.log.warn(`vault refresh sync failed: ${toSafeErrorMessage(err)}`);
      }
    }
  }

  async beforeDisable() {
    this.teardown();
  }

  async beforeUnload() {
    this.teardown();
  }

  /** Verify an env var is registered through the environment-variables plugin. */
  async assertEnvironmentVariableExists(name: string): Promise<void> {
    const repo = this.db.getRepository('environmentVariables') as Repository | null;
    if (!repo) {
      throw new Error(`Cannot bind to environment variable "${name}": the environment-variables plugin is not enabled`);
    }
    const exists = await repo.collection.existsInDb();
    if (!exists) {
      throw new Error(
        `Cannot bind to environment variable "${name}": the environmentVariables collection does not exist`,
      );
    }
    const row = await repo.findOne({ filterByTk: name });
    if (!row) {
      throw new Error(`Environment variable "${name}" does not exist`);
    }
  }

  private scheduleSyncJob() {
    const cronTime = process.env.VAULT_SYNC_CRON || '0 */5 * * * *';
    this.cronJob = this.app.cronJobManager.addJob({
      cronTime,
      onTick: async () => {
        try {
          await this.sync.tick();
        } catch (err) {
          this.log.warn(`vault sync tick failed: ${toSafeErrorMessage(err)}`);
        }
      },
    });
  }

  private teardown() {
    if (this.cronJob) {
      this.app.cronJobManager.removeJob(this.cronJob);
      this.cronJob = null;
    }
    this.cache.clear();
  }

  private registerMaskingMiddleware() {
    // strip masked placeholders so an unchanged form submit keeps stored credentials
    this.app.resourceManager.use(async (ctx, next) => {
      if (ctx.action?.resourceName === 'vaultConnections' && ['create', 'update'].includes(ctx.action?.actionName)) {
        const values = ctx.action.params?.values as Record<string, unknown> | undefined;
        const body = (ctx.request as { body?: Record<string, unknown> }).body;
        for (const field of ENCRYPTED_FIELDS) {
          if (values && (values[field] === MASK || values[field] === '')) delete values[field];
          if (body && (body[field] === MASK || body[field] === '')) delete body[field];
        }
      }
      return next();
    });

    // mask credentials on every vaultConnections response
    this.app.resourceManager.use(async (ctx, next) => {
      if (ctx.action?.resourceName !== 'vaultConnections') {
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

export default PluginHashicorpVaultIntegrationServer;
