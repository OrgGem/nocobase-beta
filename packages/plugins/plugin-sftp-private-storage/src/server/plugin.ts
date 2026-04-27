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
import { NAMESPACE, STORAGE_TYPE_SFTP_PRIVATE } from '../constants';
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
    this.patchFsReadFile();

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
    this.app.acl.allow('sftpStorageConfigs', 'testConnection', 'loggedIn');

    // Load existing configs into the connection manager on startup
    this.app.on('afterStart', async () => {
      await this.loadConfigs();
    });

    // Reload configs when they change
    const SftpConfigModel = this.db.getModel('sftpStorageConfigs');
    if (SftpConfigModel) {
      SftpConfigModel.afterSave(async () => {
        await this.loadConfigs();
        this.sendSyncMessage({ type: 'reloadSftpConfigs' });
      });
      SftpConfigModel.afterDestroy(async () => {
        await this.loadConfigs();
        this.sendSyncMessage({ type: 'reloadSftpConfigs' });
      });
    }
  }

  async handleSyncMessage(message: any) {
    if (message.type === 'reloadSftpConfigs') {
      await this.loadConfigs();
    }
  }

  /**
   * Load all SFTP configs from the database into the connection manager
   */
  async loadConfigs() {
    try {
      const repository = this.db.getRepository('sftpStorageConfigs');
      const configs = await repository.find({
        filter: { enabled: true },
      });

      // Clear existing and re-register
      for (const config of configs) {
        const sftpConfig: SftpConfig = {
          id: config.get('id'),
          host: config.get('host'),
          port: config.get('port') || 22,
          username: config.get('username'),
          authMethod: config.get('authMethod') || 'password',
          password: config.get('password'),
          privateKey: config.get('privateKey'),
          passphrase: config.get('passphrase'),
          basePath: config.get('basePath') || '/',
        };
        this.connectionManager.registerConfig(sftpConfig);
      }

      this.log.info(`[sftp-private] Loaded ${configs.length} SFTP configuration(s)`);
    } catch (error) {
      this.log.error('[sftp-private] Failed to load SFTP configs:', error);
    }
  }

  /**
   * Get the connection manager (public API for other plugins)
   */
  getConnectionManager(): SftpConnectionManager {
    return this.connectionManager;
  }

  /**
   * Get an SFTP config by name
   */
  async getConfigByName(name: string): Promise<SftpConfig | null> {
    const repository = this.db.getRepository('sftpStorageConfigs');
    const config = await repository.findOne({
      filter: { name, enabled: true },
    });

    if (!config) return null;

    return {
      id: config.get('id'),
      host: config.get('host'),
      port: config.get('port') || 22,
      username: config.get('username'),
      authMethod: config.get('authMethod') || 'password',
      password: config.get('password'),
      privateKey: config.get('privateKey'),
      passphrase: config.get('passphrase'),
      basePath: config.get('basePath') || '/',
    };
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

  private patchFsReadFile() {
    try {
      const fs = require('fs');
      if (fs.promises.readFile.__patchedBySftpPrivate) return;

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
              this.log.error(`[sftp-private-storage] Intercept readFile failed for ${pathStr}`, err);
            }
          }
        }
        return originalReadFile.call(fs.promises, pathLike, options);
      };
      fs.promises.readFile.__patchedBySftpPrivate = true;
    } catch (e) {
      this.log.error('[sftp-private-storage] Failed to patch fs.promises.readFile', e);
    }
  }

  private getParentCollections(fileCollectionName: string) {
    const parents: Array<{
      collectionName: string;
      throughTable: string;
      otherKey: string;
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
        this.log.warn(`[sftp-private-storage] Failed to query through table "${parent.throughTable}":`, error.message);
      }
    }

    return false;
  }

  async streamAction(ctx) {
    const { filterByTk, mode = 'inline' } = ctx.action.params;

    if (!filterByTk) {
      ctx.throw(400, 'Missing filterByTk parameter');
      return;
    }

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

    if (!isRoot) {
      const fileCollectionName = record.constructor?.collection?.name || 'attachments';
      const currentUserId = ctx.state.currentUser?.id;
      const createdById = record.get('createdById');
      const isCreator = currentUserId && createdById && String(currentUserId) === String(createdById);

      let hasAccess = isCreator;

      if (!hasAccess) {
        hasAccess = await this.checkParentCollectionAccess(filterByTk, fileCollectionName, currentRoles);
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
