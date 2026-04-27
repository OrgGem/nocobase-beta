/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin } from '@nocobase/server';
import { NAMESPACE, STORAGE_TYPE_S3, STORAGE_TYPE_SFTP } from '../constants';
import { DirectoryACL } from './acl/directory-acl';
import { IStorageAdapter } from './adapters/types';
import { S3Adapter } from './adapters/s3-adapter';
import { SftpAdapter } from './adapters/sftp-adapter';
import { createExtStorageActions } from './actions/ext-storage';

export class PluginExternalStorageManagerServer extends Plugin {
  private directoryACL: DirectoryACL;

  async afterAdd() {}

  async beforeLoad() {}

  async load() {
    this.directoryACL = new DirectoryACL(this.db);

    // Register ACL snippets for admin management of directories and permissions
    this.app.acl.registerSnippet({
      name: `pm.${this.name}.directories`,
      actions: ['externalStorageDirectories:*'],
    });

    this.app.acl.registerSnippet({
      name: `pm.${this.name}.permissions`,
      actions: ['externalStorageDirectoryPermissions:*'],
    });

    const extStorageActions = createExtStorageActions(this.directoryACL, this.getAdapter.bind(this));

    // Register all action handlers globally BEFORE defining the resource
    // This allows the Resource constructor to pick them up via getRegisteredHandlers()
    // without placing functions directly inside the resource options, avoiding JSON serialization errors.
    for (const [key, handler] of Object.entries(extStorageActions)) {
      this.app.resourceManager.registerActionHandler(`extStorage:${key}`, handler as any);
    }

    // Define the extStorage resource
    this.app.resourceManager.define({
      name: 'extStorage',
      actions: {
        directories: {},
        list: {},
        stat: {},
        download: {},
        upload: {},
        mkdir: {},
        delete: {},
        storageOptions: {},
      },
    });

    // Allow logged-in users to access browse API (fine-grained ACL is per-directory)
    this.app.acl.allow('extStorage', ['directories', 'list', 'stat', 'download', 'storageOptions'], 'loggedIn');
    this.app.acl.allow('extStorage', ['upload', 'mkdir', 'delete'], 'loggedIn');

    this.log.info(`[ext-storage-manager] Plugin loaded successfully`);
  }

  /**
   * Resolve the appropriate storage adapter for a directory record.
   * Creates S3 or SFTP adapter based on the directory's storageType.
   */
  private async getAdapter(directory: any): Promise<IStorageAdapter> {
    const storageType = directory.get('storageType');
    const storageConfigName = directory.get('storageConfigName');

    if (storageType === STORAGE_TYPE_S3) {
      return this.getS3Adapter(storageConfigName);
    } else if (storageType === STORAGE_TYPE_SFTP) {
      return this.getSftpAdapter(storageConfigName);
    } else {
      throw new Error(`[ext-storage-manager] Unsupported storage type: ${storageType}`);
    }
  }

  /**
   * Create an S3 adapter from a storage config name.
   * Uses plugin-s3-private-storage's public API to get S3 client and SDK classes,
   * avoiding the need to bundle a separate copy of the AWS SDK.
   */
  private async getS3Adapter(configName: string): Promise<IStorageAdapter> {
    let s3Plugin: any;
    try {
      s3Plugin = this.app.pm.get('plugin-s3-private-storage');
    } catch {
      throw new Error('[ext-storage-manager] plugin-s3-private-storage is not installed or enabled');
    }

    if (!s3Plugin) {
      throw new Error('[ext-storage-manager] plugin-s3-private-storage is not available');
    }

    const { client, bucket } = await s3Plugin.createS3ClientForStorage(configName);
    const sdk = s3Plugin.getS3SDK();

    return new S3Adapter({ client, bucket, sdk });
  }

  /**
   * Create an SFTP adapter from an SFTP config name.
   * Gets the connection manager from plugin-sftp-private-storage.
   */
  private async getSftpAdapter(configName: string): Promise<IStorageAdapter> {
    // Get the SFTP plugin
    let sftpPlugin: any;
    try {
      sftpPlugin = this.app.pm.get('plugin-sftp-private-storage');
    } catch {
      throw new Error('[ext-storage-manager] plugin-sftp-private-storage is not installed or enabled');
    }

    if (!sftpPlugin) {
      throw new Error('[ext-storage-manager] plugin-sftp-private-storage is not available');
    }

    // Find the SFTP config from storages
    const configRepo = this.db.getRepository('storages');
    const config = await configRepo.findOne({
      filter: { 
        name: configName,
        type: { $in: ['sftp', 'sftp-private'] }
      },
    });

    if (!config) {
      throw new Error(`[ext-storage-manager] SFTP config "${configName}" not found or disabled`);
    }

    const connectionManager = sftpPlugin.getConnectionManager();
    if (!connectionManager) {
      throw new Error('[ext-storage-manager] SFTP connection manager is not available');
    }

    const basePath = config.get('options')?.basePath || config.get('basePath') || '/';

    // Register the config into the connection manager dynamically to support configs from 'storages'
    const options = config.get('options') || {};
    connectionManager.registerConfig({
      id: config.get('id'),
      host: options.host || config.get('host'),
      port: options.port || config.get('port') || 22,
      username: options.username || config.get('username'),
      authMethod: options.authMethod || config.get('authMethod') || 'password',
      password: options.password || config.get('password'),
      privateKey: options.privateKey || config.get('privateKey'),
      passphrase: options.passphrase || config.get('passphrase'),
      basePath: basePath,
    });

    return new SftpAdapter(connectionManager, config.get('id'), basePath);
  }

  async disable() {}
  async remove() {}
}

export default PluginExternalStorageManagerServer;
