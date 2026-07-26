import { Plugin, Application } from '@nocobase/client-v2';
import React from 'react';

export class PluginExternalStorageManagerClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'external-storage-manager',
      title: this.t('External Storage'),
      icon: 'HddOutlined',
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'external-storage-manager',
      key: 'browse',
      title: this.t('Browse Files'),
      aclSnippet: 'pm.plugin-external-storage-manager.browse',
      componentLoader: () => import('./components/FileBrowser'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'external-storage-manager',
      key: 'settings',
      title: this.t('Directory Settings'),
      aclSnippet: 'pm.plugin-external-storage-manager.directories',
      componentLoader: () => import('./components/DirectoryManager'),
    });
  }
}

export default PluginExternalStorageManagerClient;
