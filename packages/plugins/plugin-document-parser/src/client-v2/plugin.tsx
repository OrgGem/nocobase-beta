import { Plugin, Application } from '@nocobase/client-v2';

export class PluginDocumentParserClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'document-parser',
      title: this.t('Document Parser'),
      icon: 'FileTextOutlined',
      aclSnippet: 'pm.document-parser.settings',
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'document-parser',
      key: 'index',
      title: this.t('Document Parser'),
      componentLoader: () => import('./pages/DocumentParserSettingsPage'),
    });
  }
}

export default PluginDocumentParserClient;
