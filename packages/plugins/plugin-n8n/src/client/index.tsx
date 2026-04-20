import { Plugin } from '@nocobase/client';
import { N8nSettingsPage } from './components/N8nSettingsPage';

export class PluginN8nClient extends Plugin {
  async load() {
    this.app.pluginSettingsManager.add('n8n', {
      title: this.t('n8n Integration'),
      icon: 'ApiOutlined',
      Component: N8nSettingsPage,
      aclSnippet: 'pm.plugin-n8n',
    });
  }
}

export default PluginN8nClient;
