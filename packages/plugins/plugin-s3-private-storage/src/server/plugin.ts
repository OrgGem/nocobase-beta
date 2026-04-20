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

    this.patchFsReadFile();
  }

  /**
   * Monkey patches fs.promises.readFile to intercept `/api/attachments:stream` URLs.
   * This is required because plugins like `plugin-ai` treat URLs not starting with `http`
   * as local file paths, and try to use `fs.readFile` on them.
   */
  private patchFsReadFile() {
    try {
      const fs = require('fs');
      if (fs.promises.readFile.__patchedByS3Private) return;

      const originalReadFile = fs.promises.readFile;
      fs.promises.readFile = async (pathLike: any, options?: any) => {
        const pathStr = typeof pathLike === 'string' ? pathLike : pathLike?.toString();
        if (pathStr && pathStr.includes('/api/attachments:stream?filterByTk=')) {
          const match = pathStr.match(/filterByTk=([^&]+)/);
          if (match) {
            const id = match[1];
            try {
              const repository = this.db.getRepository('attachments');
              const record = await repository.findOne({ filterByTk: id });
              if (record) {
                const fileManagerPlugin = this.app.pm.get(PluginFileManagerServer) as PluginFileManagerServer;
                const { stream } = await fileManagerPlugin.getFileStream(record);

                const chunks: Buffer[] = [];
                for await (const chunk of stream) {
                  chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
                }
                const buffer = Buffer.concat(chunks);

                if (options) {
                  const encoding = typeof options === 'string' ? options : options.encoding;
                  if (encoding) return buffer.toString(encoding);
                }
                return buffer as any;
              }
            } catch (err) {
              this.log.error(`[s3-private-storage] Intercept readFile failed for ${pathStr}`, err);
            }
          }
        }
        return originalReadFile.call(fs.promises, pathLike, options);
      };
      fs.promises.readFile.__patchedByS3Private = true;
    } catch (e) {
      this.log.error('[s3-private-storage] Failed to patch fs.promises.readFile', e);
    }
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
          const count = await throughCollection.repository.count({
            filter: {
              [parent.otherKey]: attachmentId,
            },
          });
          if (count > 0) {
            return true;
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
    const { filterByTk, mode = 'inline' } = ctx.action.params;

    if (!filterByTk) {
      ctx.throw(400, 'Missing filterByTk parameter');
      return;
    }

    // Root role bypasses all permission checks
    const currentRoles: string[] = ctx.state.currentRoles || [];
    const isRoot = currentRoles.includes('root');

    const repository = ctx.db.getRepository('attachments');
    const record = await repository.findOne({
      filterByTk,
    });

    if (!record) {
      ctx.throw(404, 'Attachment not found');
      return;
    }

    // Check role-based permission via parent collection reverse lookup
    if (!isRoot) {
      const fileCollectionName = record.constructor?.collection?.name || 'attachments';
      const hasAccess = await this.checkParentCollectionAccess(filterByTk, fileCollectionName, currentRoles);

      if (!hasAccess) {
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
      ctx.logger.error('[s3-private-storage] Stream error:', error);
      ctx.throw(500, 'Failed to stream file');
    }
  }
}

export default PluginS3PrivateStorageServer;
