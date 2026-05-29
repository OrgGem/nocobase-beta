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
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  CopyObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { STORAGE_TYPE_S3_PRIVATE } from '../constants';
import S3PrivateStorage from './storages/s3-private';

export class PluginS3PrivateStorageServer extends Plugin {
  async afterAdd() {
    this.app.pm.get('file-manager') || this.app.pm.get('@nocobase/plugin-file-manager');
  }

  async load() {
    const fileManagerPlugin = (this.app.pm.get('file-manager') ||
      this.app.pm.get('@nocobase/plugin-file-manager')) as any;
    fileManagerPlugin.registerStorageType(STORAGE_TYPE_S3_PRIVATE, S3PrivateStorage);

    this.app.resourceManager.registerActionHandler('attachments:stream', this.streamAction.bind(this));
    this.app.acl.allow('attachments', 'stream', 'loggedIn');

    // Register Browser Adapter into External Storage Manager Hub if available
    this.app.on('afterLoad', () => {
      try {
        const extStoragePlugin = this.app.pm.get('plugin-external-storage-manager') as any;
        if (extStoragePlugin && extStoragePlugin.registerBrowserAdapter) {
          const { S3Adapter } = require('./adapters/s3-adapter');
          extStoragePlugin.registerBrowserAdapter('s3-private', async (directory: any) => {
            const configName = directory.get('storageConfigName');
            const { client, bucket } = await this.createS3ClientForStorage(configName);
            const sdk = this.getS3SDK();
            return new S3Adapter({ client, bucket, sdk });
          });
        }
      } catch (e) {
        // plugin-external-storage-manager is not installed, that's fine
      }
    });
  }

  /**
   * Find all parent collections that have a belongsToMany association
   * pointing to the given file collection (e.g. 'attachments').
   *
   * Returns an array of { collectionName, throughTable, otherKey } objects
   * that can be used to check if a specific attachment is referenced.
   */
  private getParentCollections(fileCollectionName: string) {
    const parents: Array<{
      collectionName: string;
      throughTable: string;
      otherKey: string;
      foreignKey?: string;
    }> = [];

    for (const collection of this.db.collections.values()) {
      // Skip the file collection itself
      if (collection.name === fileCollectionName) continue;

      for (const field of collection.fields.values()) {
        const options = field.options || {};
        // Look for belongsToMany fields targeting the file collection
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

  /**
   * Check if the given attachment ID is referenced by any parent collection
   * that the user has 'view' permission on.
   *
   * Flow:
   * 1. Find all parent collections with belongsToMany → file collection
   * 2. Filter to those the user's roles can 'view'
   * 3. For each accessible parent, check the through/pivot table for a reference
   * 4. Return true if at least one accessible parent references the attachment
   */
  private async checkParentCollectionAccess(
    attachmentId: number | string,
    fileCollectionName: string,
    currentRoles: string[],
    ctx?: any,
  ): Promise<boolean> {
    const parents = this.getParentCollections(fileCollectionName);

    if (parents.length === 0) {
      // No parent collections found — fall back to basic attachments view check
      const canView = this.app.acl.can({
        roles: currentRoles,
        resource: fileCollectionName,
        action: 'view',
      });
      return !!canView;
    }

    for (const parent of parents) {
      // Check if user has view permission on this parent collection
      const canView = this.app.acl.can({
        roles: currentRoles,
        resource: parent.collectionName,
        action: 'view',
      });

      if (!canView) continue;

      // User has view access on this parent collection.
      // Now check if the attachment is actually referenced via the through table.
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
        // Through table might not exist yet or be inaccessible — skip
        this.log.warn(`[s3-private-storage] Failed to query through table "${parent.throughTable}":`, error.message);
      }
    }

    return false;
  }

  /**
   * Stream action handler - serves files from private S3 storage
   * Supports both inline (preview) and attachment (download) modes
   *
   * ACL flow:
   * 1. acl.allow('loggedIn') gates authentication
   * 2. Root role bypasses all checks
   * 3. For other roles: checks if the attachment is referenced by a parent collection
   *    that the user has 'view' permission on
   */
  async streamAction(ctx) {
    const params = ctx.action.params || {};
    const reqQuery = ctx.request.query || {};
    const filterByTk = params.filterByTk || reqQuery.filterByTk;
    const mode = params.mode || reqQuery.mode || 'inline';
    const collection = params.collection || reqQuery.collection || 'attachments';

    if (!filterByTk) {
      ctx.throw(400, 'Missing filterByTk parameter');
      return;
    }

    // Root role bypasses all permission checks
    const currentRoles: string[] = ctx.state.currentRoles || [];
    const isRoot = currentRoles.includes('root');

    const repository = ctx.db.getRepository(collection);
    if (!repository) {
      ctx.throw(400, `Invalid collection: ${collection}`);
      return;
    }
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
      this.log.warn(
        `[s3-private-storage] Attachment not found ${safeDebugJson({
          filterByTk: toDebugValue(filterByTk),
          collection,
        })}`,
      );
      ctx.throw(404, 'Attachment not found');
      return;
    }

    const fileManagerPlugin = (this.app.pm.get('file-manager') ||
      this.app.pm.get('@nocobase/plugin-file-manager')) as any;

    this.log.debug(
      `[s3-private-storage] Record found ${safeDebugJson({
        ...summarizeAttachmentForLog(record, recordCollection?.name || collection),
        requestedCollection: collection,
        recordCollection: recordCollection?.name,
        mode,
        storageCache: summarizeStorageCache(fileManagerPlugin?.storagesCache),
      })}`,
    );

    // Check role-based permission via parent collection reverse lookup
    if (!isRoot) {
      const fileCollectionName = record.constructor?.collection?.name || 'attachments';

      // Allow access if the current user is the creator of the attachment
      const currentUserId = ctx.state.currentUser?.id;
      const createdById = record.get('createdById');
      const isCreator = currentUserId && createdById && String(currentUserId) === String(createdById);

      let hasAccess = isCreator;

      if (!hasAccess) {
        hasAccess = await this.checkParentCollectionAccess(filterByTk, fileCollectionName, currentRoles, ctx);
      }

      if (!hasAccess) {
        ctx.logger.warn(
          `[s3-private-storage] ACL Denied: User ${currentUserId} attempted to access attachment ${filterByTk} (creator: ${createdById}) without permission.`,
        );
        ctx.throw(403, 'No permission to access this attachment');
        return;
      }
    }
    const recordObj = typeof record.toJSON === 'function' ? record.toJSON() : { ...record };
    const storageId = await this.resolveStorageId(record, recordObj, fileManagerPlugin, recordCollection);
    if (storageId === undefined || storageId === null || storageId === '') {
      this.log.error(
        `[s3-private-storage] Attachment storageId not found ${safeDebugJson({
          ...summarizeAttachmentForLog(recordObj, recordCollection?.name || collection),
          requestedCollection: collection,
          recordCollection: recordCollection?.name,
          collectionStorage: recordCollection?.options?.storage,
          storageCache: summarizeStorageCache(fileManagerPlugin?.storagesCache),
        })}`,
      );
      ctx.throw(500, 'Attachment storageId not found');
      return;
    }
    recordObj.storageId = storageId;
    this.copyFileFieldsFromRecord(record, recordObj);
    await this.ensureFileFields(record, recordObj, recordCollection);
    this.copyFileFieldsFromRecord(record, recordObj);

    this.log.debug(
      `[s3-private-storage] Record prepared for stream ${safeDebugJson({
        ...summarizeAttachmentForLog(recordObj, recordCollection?.name || collection),
        storage: summarizeStorageForLog(findStorageFromCache(fileManagerPlugin?.storagesCache, recordObj.storageId)),
      })}`,
    );

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
      ctx.logger.error(`[s3-private-storage] S3 Stream error for file ${filterByTk}:`, error);
      if (error && (error.name === 'AccessDenied' || error.statusCode === 403)) {
        ctx.throw(403, 'S3 Access Denied: The file name or path may be incorrect on S3.');
      } else if (error && (error.name === 'NoSuchKey' || error.statusCode === 404)) {
        ctx.throw(404, 'File not found on S3');
      } else {
        ctx.throw(500, 'Failed to stream file');
      }
    }
  }

  private async resolveStorageId(record: any, recordObj: any, fileManagerPlugin: any, recordCollection?: any) {
    const collectionName = recordCollection?.name || recordObj?.collectionName;
    const rawStorageId =
      getRecordStorageId(record) ??
      recordObj?.storageId ??
      recordObj?.storage_id ??
      recordObj?.storage?.id ??
      recordObj?.storage?.filterByTk;

    const matchedCacheKey = findStorageCacheKey(fileManagerPlugin?.storagesCache, rawStorageId);
    if (matchedCacheKey !== undefined && matchedCacheKey !== null) {
      this.log.debug(
        `[s3-private-storage] storageId resolved from cache ${safeDebugJson({
          collection: collectionName,
          rawStorageId: toDebugValue(rawStorageId),
          matchedCacheKey: toDebugValue(matchedCacheKey),
        })}`,
      );
      return matchedCacheKey;
    }

    const storageName = recordObj?.storage?.name || recordObj?.storageName || recordCollection?.options?.storage;
    if (storageName && fileManagerPlugin?.storagesCache) {
      for (const [key, storage] of fileManagerPlugin.storagesCache.entries()) {
        if (storage?.name === storageName) {
          this.log.debug(
            `[s3-private-storage] storageId resolved by storage name ${safeDebugJson({
              collection: collectionName,
              storageName,
              matchedCacheKey: toDebugValue(key),
              storage: summarizeStorageForLog(storage),
            })}`,
          );
          return key;
        }
      }
    }

    const dbStorageId = await this.resolveStorageIdFromRecordTable(record, recordCollection);
    const matchedDbCacheKey = findStorageCacheKey(fileManagerPlugin?.storagesCache, dbStorageId);
    if (matchedDbCacheKey !== undefined && matchedDbCacheKey !== null) {
      this.log.debug(
        `[s3-private-storage] storageId resolved from DB column and cache ${safeDebugJson({
          collection: collectionName,
          dbStorageId: toDebugValue(dbStorageId),
          matchedCacheKey: toDebugValue(matchedDbCacheKey),
        })}`,
      );
      return matchedDbCacheKey;
    }

    if (dbStorageId !== undefined && dbStorageId !== null && dbStorageId !== '') {
      const storageRepo = this.db.getRepository('storages');
      const storage = await storageRepo.findOne({ filterByTk: dbStorageId });
      if (!storage) {
        this.log.debug(
          `[s3-private-storage] DB storageId not found in storages table; returning raw value ${safeDebugJson({
            collection: collectionName,
            dbStorageId: toDebugValue(dbStorageId),
          })}`,
        );
        return dbStorageId;
      }

      const parsedStorage =
        typeof fileManagerPlugin?.parseStorage === 'function'
          ? fileManagerPlugin.parseStorage(storage)
          : storage.toJSON();
      fileManagerPlugin?.storagesCache?.set?.(storage.get('id'), parsedStorage);
      this.log.debug(
        `[s3-private-storage] storageId resolved from DB and storages table ${safeDebugJson({
          collection: collectionName,
          dbStorageId: toDebugValue(dbStorageId),
          resolvedStorageId: toDebugValue(storage.get('id')),
          storage: summarizeStorageForLog(parsedStorage),
        })}`,
      );
      return storage.get('id');
    }

    if (rawStorageId === undefined || rawStorageId === null || rawStorageId === '') {
      const fallbackKey = findDefaultS3PrivateStorageCacheKey(fileManagerPlugin?.storagesCache);
      this.log.debug(
        `[s3-private-storage] storageId missing; using s3-private fallback ${safeDebugJson({
          collection: collectionName,
          fallbackKey: toDebugValue(fallbackKey),
          storage: summarizeStorageForLog(findStorageFromCache(fileManagerPlugin?.storagesCache, fallbackKey)),
          storageCache: summarizeStorageCache(fileManagerPlugin?.storagesCache),
        })}`,
      );
      return fallbackKey;
    }

    const storageRepo = this.db.getRepository('storages');
    const storage = await storageRepo.findOne({ filterByTk: rawStorageId });
    if (!storage) {
      this.log.debug(
        `[s3-private-storage] raw storageId not found in storages table; returning raw value ${safeDebugJson({
          collection: collectionName,
          rawStorageId: toDebugValue(rawStorageId),
        })}`,
      );
      return rawStorageId;
    }

    const parsedStorage =
      typeof fileManagerPlugin?.parseStorage === 'function'
        ? fileManagerPlugin.parseStorage(storage)
        : storage.toJSON();
    fileManagerPlugin?.storagesCache?.set?.(storage.get('id'), parsedStorage);
    this.log.debug(
      `[s3-private-storage] storageId resolved from raw value and storages table ${safeDebugJson({
        collection: collectionName,
        rawStorageId: toDebugValue(rawStorageId),
        resolvedStorageId: toDebugValue(storage.get('id')),
        storage: summarizeStorageForLog(parsedStorage),
      })}`,
    );
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
      this.log.warn(`[s3-private-storage] Failed to inspect table "${collection.name}" for storageId:`, error.message);
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

    this.log.debug(
      `[s3-private-storage] storageId DB lookup ${safeDebugJson({
        collection: collection.name,
        table: String(collection.getTableNameWithSchema()),
        primaryKey,
        recordId: toDebugValue(recordId),
        storageColumn,
        dbStorageId: toDebugValue(result?.['storageId']),
      })}`,
    );

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

  /**
   * Public API: Create an S3Client for a given storage config name.
   * Used by plugin-external-storage-manager to avoid bundling its own AWS SDK.
   */
  async createS3ClientForStorage(configName: string): Promise<{ client: S3Client; bucket: string }> {
    const storageRepo = this.db.getRepository('storages');
    const storage = await storageRepo.findOne({ filter: { name: configName } });
    if (!storage) {
      throw new Error(`[s3-private] Storage config "${configName}" not found`);
    }

    const parsed = this.app.environment ? this.app.environment.renderJsonTemplate(storage.toJSON()) : storage.toJSON();

    const options = parsed.options || {};
    const clientConfig: any = {
      region: options.region,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    };
    if (options.endpoint) {
      clientConfig.endpoint = options.endpoint;
      clientConfig.forcePathStyle = true;
    }

    return {
      client: new S3Client(clientConfig),
      bucket: options.bucket,
    };
  }

  /**
   * Public API: Expose SDK classes for external use.
   * This avoids other plugins needing to bundle their own AWS SDK (~8MB).
   */
  getS3SDK() {
    return {
      S3Client,
      ListObjectsV2Command,
      GetObjectCommand,
      PutObjectCommand,
      DeleteObjectCommand,
      DeleteObjectsCommand,
      HeadObjectCommand,
      CopyObjectCommand,
      Upload,
    };
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

function safeDebugJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item));
  } catch (error) {
    return JSON.stringify({ error: 'failed_to_serialize_debug_payload' });
  }
}

function toDebugValue(value: unknown) {
  if (value === undefined || value === null || value === '') {
    return value;
  }
  return String(value);
}

function summarizeAttachmentForLog(attachment: any, collectionName?: any) {
  return {
    id: toDebugValue(getAttachmentValue(attachment, 'id')),
    uid: toDebugValue(getAttachmentValue(attachment, 'uid')),
    collectionName: String(collectionName || getAttachmentValue(attachment, 'collectionName') || ''),
    storageId: toDebugValue(getAttachmentValue(attachment, 'storageId')),
    storageIdColumn: toDebugValue(getAttachmentValue(attachment, 'storage_id')),
    storageName: getAttachmentValue(attachment, 'storage')?.name || getAttachmentValue(attachment, 'storageName'),
    fieldsPresent: {
      key: hasText(getAttachmentValue(attachment, 'key')),
      filename: hasText(getAttachmentValue(attachment, 'filename')),
      path: hasText(getAttachmentValue(attachment, 'path')),
      url: hasText(getAttachmentValue(attachment, 'url')),
      mimetype: hasText(getAttachmentValue(attachment, 'mimetype')),
      title: hasText(getAttachmentValue(attachment, 'title')),
      extname: hasText(getAttachmentValue(attachment, 'extname')),
    },
  };
}

function getAttachmentValue(attachment: any, key: string) {
  if (!attachment) return undefined;
  if (typeof attachment.get === 'function') return attachment.get(key);
  return attachment[key];
}

function summarizeStorageForLog(storage: any) {
  if (!storage) {
    return null;
  }
  return {
    id: toDebugValue(storage.id),
    name: storage.name,
    type: storage.type,
    default: Boolean(storage.default),
    public: Boolean(storage.options?.public),
    paranoid: Boolean(storage.paranoid),
    hasBucket: hasText(storage.options?.bucket),
    hasEndpoint: hasText(storage.options?.endpoint),
  };
}

function summarizeStorageCache(cache: Map<any, any> | undefined) {
  if (!cache) {
    return { size: 0, storages: [] };
  }

  return {
    size: cache.size,
    storages: Array.from(cache.entries())
      .slice(0, 20)
      .map(([key, storage]) => ({
        cacheKey: toDebugValue(key),
        ...summarizeStorageForLog(storage),
      })),
  };
}

function findStorageFromCache(cache: Map<any, any> | undefined, storageId: any) {
  const cacheKey = findStorageCacheKey(cache, storageId);
  return cacheKey === undefined || cacheKey === null ? undefined : cache?.get(cacheKey);
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

function findDefaultS3PrivateStorageCacheKey(cache: Map<any, any> | undefined) {
  if (!cache) {
    return undefined;
  }

  const s3PrivateStorages = Array.from(cache.entries()).filter(
    ([, storage]) => storage?.type === STORAGE_TYPE_S3_PRIVATE,
  );
  const defaultStorage = s3PrivateStorages.find(([, storage]) => storage?.default);
  if (defaultStorage) {
    return defaultStorage[0];
  }

  if (s3PrivateStorages.length === 1) {
    return s3PrivateStorages[0][0];
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

export default PluginS3PrivateStorageServer;
