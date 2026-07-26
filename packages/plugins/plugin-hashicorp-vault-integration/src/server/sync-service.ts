import type { Model, Repository } from '@nocobase/database';
import type { SecretCache } from './secret-cache';
import { toSafeErrorMessage } from './utils/redact';
import { VaultClient } from './vault-client';
import type PluginHashicorpVaultIntegrationServer from './plugin';

export class SyncService {
  private running = false;

  constructor(
    private readonly plugin: PluginHashicorpVaultIntegrationServer,
    private readonly cache: SecretCache,
  ) {}

  async buildClient(connection: Model): Promise<VaultClient> {
    const aes = this.plugin.app.aesEncryptor;
    let token: string | null = null;
    let secretId: string | null = null;
    try {
      if (connection.get('token')) token = await aes.decrypt(connection.get('token') as string);
      if (connection.get('secretId')) secretId = await aes.decrypt(connection.get('secretId') as string);
    } catch {
      throw new Error('Failed to decrypt Vault credentials');
    }
    return new VaultClient({
      address: connection.get('address') as string,
      namespace: connection.get('namespace') as string | null,
      authMethod: connection.get('authMethod') as string,
      token,
      roleId: connection.get('roleId') as string | null,
      secretId,
      kvVersion: connection.get('kvVersion') as number | null,
      mount: connection.get('mount') as string | null,
    });
  }

  /** Live-read a single mapping (cache miss path of vault:resolve). */
  async resolveMapping(mapping: Model): Promise<string> {
    const connection = mapping.get('connection') as Model | undefined;
    if (!connection || !connection.get('enabled')) {
      throw new Error('Vault connection is not available');
    }
    const client = await this.buildClient(connection);
    const value = await client.readSecret(mapping.get('secretPath') as string, mapping.get('secretKey') as string);
    this.cache.set(mapping.get('variableKey') as string, value);
    return value;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.doTick();
    } finally {
      this.running = false;
    }
  }

  private async doTick(): Promise<void> {
    const db = this.plugin.db;
    const mappingRepo = db.getRepository('vaultSecretMappings');
    if (!mappingRepo) return;

    let mappings: Model[];
    try {
      mappings = await mappingRepo.find({ appends: ['connection'] });
    } catch (err) {
      this.plugin.log.warn(`vault sync: failed to load mappings: ${toSafeErrorMessage(err)}`);
      return;
    }

    const groups = new Map<number, { connection: Model; mappings: Model[] }>();
    for (const mapping of mappings) {
      const connection = mapping.get('connection') as Model | undefined;
      if (!connection || !connection.get('enabled')) continue;
      const id = connection.get('id') as number;
      const group = groups.get(id) || { connection, mappings: [] };
      group.mappings.push(mapping);
      groups.set(id, group);
    }

    for (const { connection, mappings: groupMappings } of groups.values()) {
      let client: VaultClient;
      try {
        client = await this.buildClient(connection);
      } catch (err) {
        const message = toSafeErrorMessage(err);
        await connection.update({ lastCheckAt: new Date(), lastError: message }, { hooks: false });
        for (const mapping of groupMappings) {
          await mapping.update({ lastError: message }, { hooks: false });
        }
        continue;
      }

      let anySuccess = false;
      let lastGroupError: string | null = null;
      for (const mapping of groupMappings) {
        try {
          await this.processMapping(mapping, client);
          anySuccess = true;
          await mapping.update({ lastSyncedAt: new Date(), lastError: null }, { hooks: false });
        } catch (err) {
          lastGroupError = toSafeErrorMessage(err);
          await mapping.update({ lastError: lastGroupError }, { hooks: false });
        }
      }

      await connection.update(
        { lastCheckAt: new Date(), lastError: anySuccess ? null : lastGroupError },
        { hooks: false },
      );
    }
  }

  /**
   * Run a single mapping against the (already-built) Vault client. Pull/push
   * logic with diff-check lives here so it can be unit-tested directly.
   */
  async processMapping(mapping: Model, client: VaultClient): Promise<void> {
    const variableKey = mapping.get('variableKey') as string;
    const secretPath = mapping.get('secretPath') as string;
    const secretKey = mapping.get('secretKey') as string;
    const direction = (mapping.get('direction') as string | null) || 'pull';
    const envVariable = (mapping.get('envVariable') as string | null) || null;

    if (direction === 'push') {
      if (!envVariable) {
        throw new Error('envVariable is required when direction is "push"');
      }
      const envValue = this.plugin.app.environment.getVariables()[envVariable];
      if (envValue === undefined) {
        throw new Error(`Environment variable "${envVariable}" is not set`);
      }
      const currentVaultValue = await client.readSecret(secretPath, secretKey);
      if (currentVaultValue === envValue) {
        // values already match — keep cache in sync with vault (in case env was set later)
        this.cache.set(variableKey, envValue);
        return;
      }
      await client.setSecretKey(secretPath, secretKey, envValue);
      this.cache.set(variableKey, envValue);
      return;
    }

    // pull (default)
    const vaultValue = await client.readSecret(secretPath, secretKey);
    this.cache.set(variableKey, vaultValue);
    if (!envVariable) return;

    const envRepo = this.plugin.db.getRepository('environmentVariables') as Repository | null;
    if (!envRepo) return;
    if (!(await envRepo.collection.existsInDb())) return;
    const row = await envRepo.findOne({ filterByTk: envVariable });
    if (!row) {
      throw new Error(`Environment variable "${envVariable}" no longer exists`);
    }
    const currentEnv = this.plugin.app.environment.getVariables()[envVariable];
    if (currentEnv === vaultValue) return;
    // Write through the canonical collection so the env-variables plugin can
    // re-encrypt (when type=secret) and broadcast to other processes.
    await envRepo.update({ filterByTk: envVariable, values: { value: vaultValue } });
  }
}
