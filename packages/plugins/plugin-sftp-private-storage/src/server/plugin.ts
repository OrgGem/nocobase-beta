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
import { STORAGE_TYPE_SFTP_PRIVATE } from '../constants';
import { SftpConnectionManager, SftpConfig } from './sftp-connection-manager';
import SftpPrivateStorage from './storages/sftp-private';

export class PluginSftpPrivateStorageServer extends Plugin {
  connectionManager: SftpConnectionManager;

  async afterAdd() {
    this.app.pm.get(PluginFileManagerServer);
  }

  async beforeLoad() {}

  async load() {
    this.connectionManager = new SftpConnectionManager(this.log);

    const fileManagerPlugin = this.app.pm.get(PluginFileManagerServer) as PluginFileManagerServer;
    fileManagerPlugin.registerStorageType(STORAGE_TYPE_SFTP_PRIVATE, SftpPrivateStorage);

    this.app.resourceManager.registerActionHandler('attachments:stream', this.streamAction.bind(this));
    this.app.acl.allow('attachments', 'stream', 'loggedIn');

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
  }  /**
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
      const parsed = this.app.environment
        ? this.app.environment.renderJsonTemplate(config.toJSON())
        : config.toJSON();

      sftpConfig = {
        id: config.get('id'),
        host: parsed.host,
        port: parsed.port || 22,
        username: parsed.username,
        authMethod: parsed.authMethod || 'password',
        password: parsed.password,
        privateKey: parsed.privateKey,
        passphrase: parsed.passphrase,
        basePath: parsed.basePath || '/',
        poolMax: parsed.poolMax,
        poolMin: parsed.poolMin,
        idleTimeoutMillis: parsed.idleTimeoutMillis,
        acquireTimeoutMillis: parsed.acquireTimeoutMillis,
        readyTimeout: parsed.readyTimeout,
      };
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

    const currentRoles: string[] = ctx.state.currentRoles || [];
    const isRoot = currentRoles.includes('root');

    const repository = ctx.db.getRepository(collection);
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
      ctx.logger.error(`[sftp-private-storage] Attachment not found. filterByTk=${filterByTk}, collection=${collection}`);
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

export default PluginSftpPrivateStorageServer;
