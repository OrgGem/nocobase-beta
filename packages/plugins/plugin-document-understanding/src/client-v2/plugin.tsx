import { Application, Plugin } from '@nocobase/client-v2';

export class PluginDocumentUnderstandingClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'document-understanding',
      title: this.t('Document Understanding'),
      icon: 'FileSearchOutlined',
      aclSnippet: 'pm.document-understanding',
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'document-understanding',
      key: 'index',
      title: this.t('Document Understanding'),
      componentLoader: () => import('./components/PluginSettings'),
    });
  }
}

export default PluginDocumentUnderstandingClient;
