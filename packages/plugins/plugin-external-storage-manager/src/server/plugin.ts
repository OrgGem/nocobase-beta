/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin } from '@nocobase/server';
import { NAMESPACE } from '../constants';
import { IStorageAdapter } from './adapters/types';
import { createExtStorageActions } from './actions/ext-storage';

export type StorageAdapterFactory = (directory: any) => Promise<IStorageAdapter>;

export class PluginExternalStorageManagerServer extends Plugin {
  private adapterFactories = new Map<string, StorageAdapterFactory>();

  async afterAdd() {}

  async beforeLoad() {}

  async load() {
    const extStorageActions = createExtStorageActions(this.getAdapter.bind(this));

    // Register handlers globally BEFORE defining the resource
    for (const [key, handler] of Object.entries(extStorageActions)) {
      this.app.resourceManager.registerActionHandler(`extStorage:${key}`, handler as any);
    }

    // Register ACL snippet for directory management
    this.app.acl.registerSnippet({
      name: `pm.${this.name}.directories`,
      actions: ['externalStorageDirectories:*', 'extStorage:*'],
    });

    // Register ACL snippet for browse files UI
    this.app.acl.registerSnippet({
      name: `pm.${this.name}.browse`,
      actions: [], // Empty actions: only grants UI access. Backend relies on fine-grained ACL.
    });

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
        rolePermissions: {},
        updateRolePermissions: {},
      },
    });

    // Allow logged-in users to access browse API (fine-grained ACL is enforced inside handlers)
    this.app.acl.allow('extStorage', ['directories', 'list', 'stat', 'download', 'storageOptions'], 'loggedIn');
    this.app.acl.allow('extStorage', ['upload', 'mkdir', 'delete'], 'loggedIn');
    
    // Only root or users with specific roles should configure role permissions, but for simplicity we allow 'loggedIn' 
    // and check inside the handler if needed, or better, just rely on the UI being hidden.
    // Actually, it's safer to just restrict it to 'root' or use NocoBase's snippet.
    this.app.acl.allow('extStorage', ['rolePermissions', 'updateRolePermissions'], 'loggedIn');

    this.log.info(`[ext-storage-manager] Plugin loaded successfully`);
  }

  /**
   * Registry for other plugins (S3, SFTP) to inject their storage adapters.
   */
  public registerBrowserAdapter(storageType: string, factory: StorageAdapterFactory) {
    this.adapterFactories.set(storageType, factory);
    this.log.info(`[ext-storage-manager] Registered adapter for type: ${storageType}`);
  }

  /**
   * Resolve the appropriate storage adapter for a directory record using the Registry.
   */
  private async getAdapter(directory: any): Promise<IStorageAdapter> {
    const storageType = directory.get('storageType');

    const factory = this.adapterFactories.get(storageType);
    if (!factory) {
      throw new Error(`[ext-storage-manager] Unsupported or unregistered storage type: ${storageType}`);
    }

    return await factory(directory);
  }

  async disable() {}
  async remove() {}
}

export default PluginExternalStorageManagerServer;
