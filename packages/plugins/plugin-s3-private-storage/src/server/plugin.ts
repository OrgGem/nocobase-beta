/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin } from '@nocobase/server';
import PluginFileManagerServer from '@nocobase/plugin-file-manager';
import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { STORAGE_TYPE_S3_PRIVATE } from '../constants';
import S3PrivateStorage from './storages/s3-private';

export class PluginS3PrivateStorageServer extends Plugin {
  async afterAdd() {
    this.app.pm.get(PluginFileManagerServer);
  }

  async load() {
    const fileManagerPlugin = this.app.pm.get(PluginFileManagerServer) as PluginFileManagerServer;
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
            const parentIds = links.map(l => l.get(parent['foreignKey'])).filter(Boolean);
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
                  $and: [
                    { [pk]: { $in: parentIds } },
                    dataScopeFilter
                  ]
                }
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
    let record = await repository.findOne({
      filterByTk,
    });

    // Fallback for old URLs generated before the 'collection' parameter was added
    if (!record && collection === 'attachments') {
      const allCollections = Array.from(ctx.db.collections.values());
      const fileCollections = allCollections.filter(
        (c: any) => c.options?.template === 'file' || c.name === 'aiFiles'
      );
      
      for (const col of fileCollections as any[]) {
        if (col.name === 'attachments') continue;
        const repo = ctx.db.getRepository(col.name);
        if (repo) {
          try {
            record = await repo.findOne({ filterByTk });
            if (record) break;
          } catch (e) {
            // ignore format errors if filterByTk is incompatible with the collection
          }
        }
      }
    }

    if (!record) {
      console.error(`[s3-private-storage] Attachment not found. filterByTk=${filterByTk}, collection=${collection}`);
      ctx.throw(404, 'Attachment not found');
      return;
    }

    console.log(`[s3-private-storage] Record found: ID=${record.get('id')}, storage=${record.get('storageId')}`);

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
        ctx.logger.warn(`[s3-private-storage] ACL Denied: User ${currentUserId} attempted to access attachment ${filterByTk} (creator: ${createdById}) without permission.`);
        ctx.throw(403, 'No permission to access this attachment');
        return;
      }
    }

    const fileManagerPlugin = this.app.pm.get(PluginFileManagerServer) as PluginFileManagerServer;

    try {
      const { stream, contentType } = await fileManagerPlugin.getFileStream(record);
      ctx.set('Content-Type', contentType || 'application/octet-stream');

      const filename = encodeURIComponent(record.get('filename') || 'file');
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

    const parsed = this.app.environment
      ? this.app.environment.renderJsonTemplate(storage.toJSON())
      : storage.toJSON();

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
      Upload,
    };
  }
}

export default PluginS3PrivateStorageServer;
