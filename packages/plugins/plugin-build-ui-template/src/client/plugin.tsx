import { Plugin } from '@nocobase/client';
import { BuildUITemplateManager } from './BuildUITemplateManager';

export class PluginBuildUITemplateClient extends Plugin {
  async load() {
    this.app.pluginSettingsManager.add('ai-build-ui-template', {
      icon: 'LayoutOutlined',
      title: 'Build UI Template',
      Component: BuildUITemplateManager,
      aclSnippet: 'pm.ai-build-ui-template',
    });
  }
}

export default PluginBuildUITemplateClient;
