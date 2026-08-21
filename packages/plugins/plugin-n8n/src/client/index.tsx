import { Plugin } from '@nocobase/client';

export class PluginN8nClient extends Plugin {
  async load() {
    this.app.pluginSettingsManager.add('n8n', {
      title: this.t('n8n Integration'),
      icon: 'ApiOutlined',
      aclSnippet: 'pm.plugin-n8n',
      componentLoader: () => import('./components/N8nSettingsPage').then((m) => ({ default: m.N8nSettingsPage })),
    });
  }
}

export default PluginN8nClient;
