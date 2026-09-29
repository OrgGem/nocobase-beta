import { Plugin, Application } from '@nocobase/client-v2';

export class PluginTenantPathClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'tenant-path',
      title: this.t('Tenant Path'),
      icon: 'ClusterOutlined',
      aclSnippet: 'pm.plugin-tenant-path',
      sort: 1010,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'tenant-path',
      key: 'tenants',
      title: this.t('Tenants'),
      componentLoader: () => import('./TenantsSettingsPage').then((m) => ({ default: m.TenantsSettingsPage })),
      aclSnippet: 'pm.plugin-tenant-path',
    });
  }
}

export default PluginTenantPathClient;
