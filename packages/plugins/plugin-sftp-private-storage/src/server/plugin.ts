/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin } from '@nocobase/server';
import { col } from 'sequelize';
import { STORAGE_TYPE_SFTP_PRIVATE } from '../constants';
import { SftpConnectionManager, SftpConfig } from './sftp-connection-manager';
import SftpPrivateStorage from './storages/sftp-private';
import { decryptSecretIfNeeded, encryptSecretIfPlain, getSecretKeyInfo } from './secret-box';

const SECRET_FIELDS = ['password', 'passphrase', 'privateKey'];

export class PluginSftpPrivateStorageServer extends Plugin {
  connectionManager: SftpConnectionManager;

  async afterAdd() {
    const fileManagerPlugin = this.app.pm.get('file-manager') || this.app.pm.get('@nocobase/plugin-file-manager');
    if (!fileManagerPlugin) {
      throw new Error(
        '[sftp-private-storage] @nocobase/plugin-file-manager is required. Please enable it before this plugin.',
      );
    }
  }

  async beforeLoad() {}

  async load() {
    this.connectionManager = new SftpConnectionManager(this.log);

    const keyInfo = getSecretKeyInfo();
    if (keyInfo.ephemeral) {
      this.log.warn(
        '[sftp-private-storage] No SFTP_STORAGE_SECRET_KEY / APP_KEY configured — using an ephemeral encryption key. ' +
          'SFTP passwords saved now will NOT be readable after a restart. Set SFTP_STORAGE_SECRET_KEY to persist them.',
      );
    }

    // Encrypt secrets at rest. Values already encrypted are left untouched so
    // repeated saves never double-encrypt.
    this.db.on('sftpStorageConfigs.beforeSave', (model: any) => {
      for (const field of SECRET_FIELDS) {
        const value = model.get(field);
        if (typeof value === 'string' && value !== '') {
          model.set(field, encryptSecretIfPlain(value));
        }
      }
    });

    // Drop pooled connections when a config is disabled or deleted so stale
    // credentials are never reused after an admin revokes them.
    this.db.on('sftpStorageConfigs.afterSave', async (model: any) => {
      if (model.get('enabled') === false) {
        await this.connectionManager.unregisterConfig(model.get('id'));
      }
    });
    this.db.on('sftpStorageConfigs.afterDestroy', async (model: any) => {
      await this.connectionManager.unregisterConfig(model.get('id'));
    });

    const fileManagerPlugin = (this.app.pm.get('file-manager') ||
      this.app.pm.get('@nocobase/plugin-file-manager')) as any;
    fileManagerPlugin.registerStorageType(STORAGE_TYPE_SFTP_PRIVATE, SftpPrivateStorage);

    this.app.resourceManager.registerActionHandler('attachments:sftpStream', this.streamAction.bind(this));
    this.app.acl.allow('attachments', 'sftpStream', 'loggedIn');

    // Register ACL snippet for admin management of SFTP configs
    this.app.acl.registerSnippet({
      name: `pm.${this.name}.sftpStorageConfigs`,
      actions: ['sftpStorageConfigs:*'],
    });

    // Register test connection action
    this.app.resourceManager.registerActionHandler(
      'sftpStorageConfigs:testConnection',
      this.testConnectionAction.bind(this),
    );

    // Register Browser Adapter into External Storage Manager Hub if available
    this.app.on('afterLoad', () => {
      try {
        const extStoragePlugin = this.app.pm.get('plugin-external-storage-manager') as any;
        if (extStoragePlugin && extStoragePlugin.registerBrowserAdapter) {
          const { SftpAdapter } = require('./adapters/sftp-adapter');
          extStoragePlugin.registerBrowserAdapter('sftp-private', async (directory: any) => {
            const configName = directory.get('storageConfigName');
            const config = await this.getConfigByName(configName);
            if (!config) {
              throw new Error(`[sftp-private] Storage config "${configName}" not found`);
            }
            const basePath = config.basePath || '/';
            return new SftpAdapter(this.connectionManager, config.id, basePath);
          });
        }
      } catch (e) {
        // plugin-external-storage-manager is not installed, that's fine
      }
    });

    // Connection manager manages connections dynamically when requested via getConfigByName
  } /**
   * Get the connection manager (public API for other plugins)
   */
  getConnectionManager(): SftpConnectionManager {
    return this.connectionManager;
  }

  /**
   * Get an SFTP config by name
   */
  async getConfigByName(name: string): Promise<SftpConfig | null> {
    const configsRepo = this.db.getRepository('sftpStorageConfigs');
    const config = configsRepo
      ? await configsRepo.findOne({
          filter: { name, enabled: true },
        })
      : null;

    let sftpConfig: SftpConfig | null = null;

    if (config) {
      const parsed = this.app.environment ? this.app.environment.renderJsonTemplate(config.toJSON()) : config.toJSON();

      try {
        sftpConfig = {
          id: config.get('id'),
          host: parsed.host,
          port: parsed.port || 22,
          username: parsed.username,
          authMethod: parsed.authMethod || 'password',
          password: decryptSecretIfNeeded(parsed.password) as string | undefined,
          privateKey: decryptSecretIfNeeded(parsed.privateKey) as string | undefined,
          passphrase: decryptSecretIfNeeded(parsed.passphrase) as string | undefined,
          basePath: parsed.basePath || '/',
          poolMax: parsed.poolMax,
          poolMin: parsed.poolMin,
          idleTimeoutMillis: parsed.idleTimeoutMillis,
          acquireTimeoutMillis: parsed.acquireTimeoutMillis,
          readyTimeout: parsed.readyTimeout,
        };
      } catch (error) {
        this.log.warn(
          `[sftp-private-storage] Unable to decrypt credentials for SFTP config ${name}; skipping. Set SFTP_STORAGE_SECRET_KEY and re-save the secret.`,
        );
        return null;
      }
    } else {
      // Backward compatibility for older setups that stored SFTP configs in file-manager storages.
      const storage = await this.db.getRepository('storages').findOne({
        filter: { name, type: STORAGE_TYPE_SFTP_PRIVATE },
      });

      if (!storage) return null;

      const parsed = this.app.environment
        ? this.app.environment.renderJsonTemplate(storage.toJSON())
        : storage.toJSON();
      const options = parsed.options || {};

      sftpConfig = {
        id: storage.get('id'),
        host: options.host,
        port: options.port || 22,
        username: options.username,
        authMethod: options.authMethod || 'password',
        password: options.password,
        privateKey: options.privateKey,
        passphrase: options.passphrase,
        basePath: options.basePath || '/',
        poolMax: options.poolMax,
        poolMin: options.poolMin,
        idleTimeoutMillis: options.idleTimeoutMillis,
        acquireTimeoutMillis: options.acquireTimeoutMillis,
        readyTimeout: options.readyTimeout,
      };
    }

    // Ensure the connection manager has this config registered
    this.connectionManager.registerConfig(sftpConfig);

    return sftpConfig;
  }

  /**
   * Test connection action handler
   */
  async testConnectionAction(ctx: any) {
    const { host, port, username, authMethod, password, privateKey, passphrase } = ctx.action.params.values || {};

    if (!host || !username) {
      ctx.throw(400, 'Host and username are required');
      return;
    }

    const result = await this.connectionManager.testConnection({
      host,
      port: port || 22,
      username,
      authMethod: authMethod || 'password',
      password,
      privateKey,
      passphrase,
    });

    ctx.body = result;
  }

  private getParentCollections(fileCollectionName: string) {
    const parents: Array<{
      collectionName: string;
      throughTable: string;
      otherKey: string;
      foreignKey?: string;
    }> = [];

    for (const collection of this.db.collections.values()) {
      if (collection.name === fileCollectionName) continue;

      for (const field of collection.fields.values()) {
        const options = field.options || {};
        if (field.type === 'belongsToMany' && options.target === fileCollectionName && options.through) {
          parents.push({
            collectionName: collection.name,
            throughTable: options.through,
            otherKey: options.otherKey || 'attachmentId',
            foreignKey: options.foreignKey || `${collection.model.name.toLowerCase()}Id`,
          });
        }
      }
    }

    return parents;
  }

  private async checkParentCollectionAccess(
    attachmentId: number | string,
    fileCollectionName: string,
    currentRoles: string[],
    ctx?: any,
  ): Promise<boolean> {
    const parents = this.getParentCollections(fileCollectionName);

    if (parents.length === 0) {
      const canView = this.app.acl.can({
        roles: currentRoles,
        resource: fileCollectionName,
        action: 'view',
      });
      return !!canView;
    }

    for (const parent of parents) {
      const canView = this.app.acl.can({
        roles: currentRoles,
        resource: parent.collectionName,
        action: 'view',
      });

      if (!canView) continue;

      try {
        const throughCollection = this.db.getCollection(parent.throughTable);
        if (throughCollection) {
          const links = await throughCollection.repository.find({
            filter: { [parent.otherKey]: attachmentId },
          });
          if (links.length > 0) {
            const parentIds = links.map((l) => l.get(parent['foreignKey'])).filter(Boolean);
            if (parentIds.length > 0) {
              let dataScopeFilter = canView.params?.filter || {};
              if (ctx && ctx.app.environment) {
                dataScopeFilter = ctx.app.environment.renderJsonTemplate(dataScopeFilter, {
                  $user: ctx.state.currentUser?.toJSON ? ctx.state.currentUser.toJSON() : ctx.state.currentUser,
                  $nRole: ctx.state.currentRole,
                });
              }

              const parentCollection = this.db.getCollection(parent.collectionName);
              const pk = parentCollection?.model?.primaryKeyAttribute || 'id';
              const count = await parentCollection.repository.count({
                filter: {
                  $and: [{ [pk]: { $in: parentIds } }, dataScopeFilter],
                },
              });
              if (count > 0) return true;
            } else {
              return false; // Fix P0 fail-open
            }
          }
        }
      } catch (error) {
        this.log.warn(`[sftp-private-storage] Failed to query through table "${parent.throughTable}":`, error.message);
      }
    }

    return false;
  }

  async streamAction(ctx) {
    const { filterByTk, mode = 'inline' } = ctx.action.params;
    const reqQuery = ctx.request.query || {};
    const collection = ctx.action.params.collection || reqQuery.collection || 'attachments';

    if (!filterByTk) {
      ctx.throw(400, 'Missing filterByTk parameter');
      return;
    }

    // Only file-type collections may be streamed. Reject anything else so the
    // collection parameter cannot be used to probe arbitrary tables.
    const fileCollectionNames = new Set(
      Array.from(ctx.db.collections.values())
        .filter((c: any) => c.options?.template === 'file' || c.name === 'attachments' || c.name === 'aiFiles')
        .map((c: any) => c.name),
    );
    if (!fileCollectionNames.has(collection)) {
      ctx.throw(400, 'Invalid collection parameter');
      return;
    }

    const currentRoles: string[] = ctx.state.currentRoles || [];
    const isRoot = currentRoles.includes('root');

    const repository = ctx.db.getRepository(collection);
    let recordCollection = repository.collection;
    let record = await repository.findOne({
      filterByTk,
    });

    // Fallback for old URLs generated before the 'collection' parameter was added
    if (!record && collection === 'attachments') {
      const allCollections = Array.from(ctx.db.collections.values());
      const fileCollections = allCollections.filter((c: any) => c.options?.template === 'file' || c.name === 'aiFiles');

      for (const col of fileCollections as any[]) {
        if (col.name === 'attachments') continue;
        const repo = ctx.db.getRepository(col.name);
        if (repo) {
          try {
            record = await repo.findOne({ filterByTk });
            if (record) {
              recordCollection = repo.collection;
              break;
            }
          } catch (e) {
            // ignore format errors if filterByTk is incompatible with the collection
          }
        }
      }
    }

    if (!record) {
      ctx.logger.warn('[sftp-private-storage] Attachment not found for stream request');
      ctx.throw(404, 'Attachment not found');
      return;
    }

    if (!isRoot) {
      const fileCollectionName = record.constructor?.collection?.name || 'attachments';
      const currentUserId = ctx.state.currentUser?.id;
      const createdById = record.get('createdById');
      const isCreator = currentUserId && createdById && String(currentUserId) === String(createdById);

      let hasAccess = isCreator;

      if (!hasAccess) {
        hasAccess = await this.checkParentCollectionAccess(filterByTk, fileCollectionName, currentRoles, ctx);
      }

      if (!hasAccess) {
        ctx.logger.warn(
          `[sftp-private-storage] ACL Denied: User ${currentUserId} attempted to access attachment ${filterByTk} (creator: ${createdById}) without permission.`,
        );
        ctx.throw(403, 'No permission to access this attachment');
        return;
      }
    }
    const fileManagerPlugin = (this.app.pm.get('file-manager') ||
      this.app.pm.get('@nocobase/plugin-file-manager')) as any;

    const recordObj = typeof record.toJSON === 'function' ? record.toJSON() : { ...record };
    const storageId = await this.resolveStorageId(record, recordObj, fileManagerPlugin, recordCollection);
    if (storageId === undefined || storageId === null || storageId === '') {
      ctx.throw(500, 'Attachment storageId not found');
      return;
    }
    recordObj.storageId = storageId;
    this.copyFileFieldsFromRecord(record, recordObj);
    await this.ensureFileFields(record, recordObj, recordCollection);
    this.copyFileFieldsFromRecord(record, recordObj);

    try {
      const { stream, contentType } = await fileManagerPlugin.getFileStream(recordObj);
      ctx.set('Content-Type', contentType || 'application/octet-stream');

      const filename = encodeURIComponent(recordObj.filename || record.get('filename') || 'file');
      if (mode === 'attachment') {
        ctx.set('Content-Disposition', `attachment; filename="${filename}"`);
      } else {
        ctx.set('Content-Disposition', `inline; filename="${filename}"`);
      }

      ctx.set('Cache-Control', 'private, max-age=3600');
      ctx.body = stream;
    } catch (error) {
      ctx.logger.error(`[sftp-private-storage] SFTP Stream error for file ${filterByTk}:`, error);
      if (error && (error.code === 2 || /no such file/i.test(error.message || ''))) {
        ctx.throw(404, 'File not found on SFTP server');
      } else if (error && /permission denied/i.test(error.message || '')) {
        ctx.throw(403, 'SFTP access denied');
      } else {
        ctx.throw(500, 'Failed to stream file');
      }
    }
  }

  private async resolveStorageId(record: any, recordObj: any, fileManagerPlugin: any, recordCollection?: any) {
    const rawStorageId =
      getRecordStorageId(record) ??
      recordObj?.storageId ??
      recordObj?.storage_id ??
      recordObj?.storage?.id ??
      recordObj?.storage?.filterByTk;

    const matchedCacheKey = findStorageCacheKey(fileManagerPlugin?.storagesCache, rawStorageId);
    if (matchedCacheKey !== undefined && matchedCacheKey !== null) {
      return matchedCacheKey;
    }

    const dbStorageId = await this.resolveStorageIdFromRecordTable(record, recordCollection);
    const matchedDbCacheKey = findStorageCacheKey(fileManagerPlugin?.storagesCache, dbStorageId);
    if (matchedDbCacheKey !== undefined && matchedDbCacheKey !== null) {
      return matchedDbCacheKey;
    }

    const storageId = dbStorageId ?? rawStorageId;
    if (storageId === undefined || storageId === null || storageId === '') {
      return storageId;
    }

    const storageRepo = this.db.getRepository('storages');
    const storage = await storageRepo.findOne({ filterByTk: storageId });
    if (!storage) {
      return storageId;
    }

    const parsedStorage =
      typeof fileManagerPlugin?.parseStorage === 'function'
        ? fileManagerPlugin.parseStorage(storage)
        : storage.toJSON();
    fileManagerPlugin?.storagesCache?.set?.(storage.get('id'), parsedStorage);
    return storage.get('id');
  }

  private async resolveStorageIdFromRecordTable(record: any, recordCollection?: any) {
    const collection = recordCollection || record?.constructor?.collection;
    if (!collection?.model) {
      return undefined;
    }

    const primaryKey = collection.model.primaryKeyAttribute || 'id';
    const recordId = record.get?.(primaryKey) ?? record.get?.('id') ?? record[primaryKey] ?? record.id;
    if (recordId === undefined || recordId === null || recordId === '') {
      return undefined;
    }

    let columns: Record<string, unknown>;
    try {
      columns = await this.db.sequelize.getQueryInterface().describeTable(collection.getTableNameWithSchema());
    } catch (error) {
      this.log.warn(
        `[sftp-private-storage] Failed to inspect table "${collection.name}" for storageId:`,
        error.message,
      );
      return undefined;
    }

    const rawAttributes = collection.model.rawAttributes || {};
    const storageColumn = findExistingColumn(columns, [
      rawAttributes.storageId?.field,
      rawAttributes.storage_id?.field,
      'storageId',
      'storage_id',
      'storageid',
    ]);
    if (!storageColumn) {
      return undefined;
    }

    const result = await collection.model.findOne({
      attributes: [[col(storageColumn), 'storageId']],
      where: { [primaryKey]: recordId },
      raw: true,
    });

    return result?.['storageId'];
  }

  private async ensureFileFields(record: any, recordObj: any, recordCollection?: any) {
    const fileFields = ['key', 'filename', 'path', 'mimetype', 'title', 'extname', 'url'];
    const needsFileKey = !hasText(recordObj.key) && !hasText(recordObj.filename) && !hasText(recordObj.url);
    const missingFields = fileFields.filter((field) => isMissingFileValue(recordObj[field]));
    if (!needsFileKey && missingFields.length === 0) {
      return;
    }

    const fileData = await this.resolveFileFieldsFromRecordTable(record, fileFields, recordCollection);
    for (const field of fileFields) {
      if (!isMissingFileValue(fileData[field])) {
        recordObj[field] = fileData[field];
      }
    }
  }

  private copyFileFieldsFromRecord(record: any, recordObj: any) {
    for (const field of ['key', 'filename', 'path', 'mimetype', 'title', 'extname', 'url']) {
      if (!isMissingFileValue(recordObj[field])) {
        continue;
      }

      const value = record.get?.(field) ?? record.getDataValue?.(field) ?? record[field];
      if (!isMissingFileValue(value)) {
        recordObj[field] = value;
      }
    }
  }

  private async resolveFileFieldsFromRecordTable(record: any, fields: string[], recordCollection?: any) {
    const collection = recordCollection || record?.constructor?.collection;
    if (!collection?.model) {
      return {};
    }

    const primaryKey = collection.model.primaryKeyAttribute || 'id';
    const recordId = record.get?.(primaryKey) ?? record.get?.('id') ?? record[primaryKey] ?? record.id;
    if (recordId === undefined || recordId === null || recordId === '') {
      return {};
    }

    const rawAttributes = collection.model.rawAttributes || {};
    const attributes = fields
      .filter((field) => rawAttributes[field])
      .map((field) => [col(rawAttributes[field].field || field), field]);

    if (attributes.length === 0) {
      return {};
    }

    const result = await collection.model.findOne({
      attributes,
      where: { [primaryKey]: recordId },
      raw: true,
    });

    return result || {};
  }

  async disable() {
    if (this.connectionManager) {
      await this.connectionManager.destroy();
    }
  }

  async remove() {
    if (this.connectionManager) {
      await this.connectionManager.destroy();
    }
  }
}

function getRecordStorageId(record: any) {
  if (!record) return undefined;
  return (
    record.get?.('storageId') ??
    record.get?.('storage_id') ??
    record.getDataValue?.('storageId') ??
    record.getDataValue?.('storage_id') ??
    record.storageId ??
    record.storage_id ??
    record.get?.('storage')?.id ??
    record.storage?.id
  );
}

function findStorageCacheKey(cache: Map<any, any> | undefined, storageId: any) {
  if (!cache || storageId === undefined || storageId === null || storageId === '') {
    return undefined;
  }

  if (cache.has(storageId)) {
    return storageId;
  }

  const strId = String(storageId);
  if (cache.has(strId)) {
    return strId;
  }

  const numericId = Number(storageId);
  if (Number.isFinite(numericId) && cache.has(numericId)) {
    return numericId;
  }

  for (const key of cache.keys()) {
    if (String(key) === strId) {
      return key;
    }
  }

  return undefined;
}

function findExistingColumn(columns: Record<string, unknown>, candidates: Array<string | undefined>) {
  const columnNames = Object.keys(columns || {});

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (Object.prototype.hasOwnProperty.call(columns, candidate)) {
      return candidate;
    }

    const matchedColumn = columnNames.find((columnName) => columnName.toLowerCase() === candidate.toLowerCase());
    if (matchedColumn) {
      return matchedColumn;
    }
  }

  return undefined;
}

function hasText(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isMissingFileValue(value: unknown) {
  return value === undefined || value === null || value === '';
}

export default PluginSftpPrivateStorageServer;
