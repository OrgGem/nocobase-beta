import { Plugin } from '@nocobase/client';
import models from './models';
import { PluginSettings } from './components/PluginSettings';

export class PluginDocumentUnderstandingClient extends Plugin {
  async load() {
    this.flowEngine?.registerModels(models);

    this.app.pluginSettingsManager.add('@nocobase/plugin-document-understanding', {
      title: this.t('Document Understanding'),
      icon: 'FileSearchOutlined',
      Component: PluginSettings,
      aclSnippet: 'pm.@nocobase/plugin-document-understanding',
    });
  }
}

export default PluginDocumentUnderstandingClient;
