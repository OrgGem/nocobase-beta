import { Plugin, Application } from '@nocobase/client-v2';
import type PluginAclClientV2 from '@nocobase/plugin-acl/client-v2';

export class PluginExternalStorageManagerClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.app.pm.get<PluginAclClientV2>('acl')?.settingsUI.addPermissionsTab({
      key: 'external-storage',
      label: this.t('External Storage'),
      sort: 25,
      componentLoader: () => import('./components/ExternalStoragePermissions'),
    });
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
