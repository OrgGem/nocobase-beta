import { Plugin, Application } from '@nocobase/client-v2';
import { drawioClientTools } from '../client/tools';

export class PluginAiDrawioClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.flowEngine.registerModelLoaders({
      DrawioBlockModel: {
        loader: () => import('./models/DrawioBlockModel'),
      },
    });

    this.pluginSettingsManager.addMenuItem({
      key: 'ai-drawio',
      title: this.t('AI Drawio'),
      icon: 'ApartmentOutlined',
      aclSnippet: 'pm.ai-drawio',
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai-drawio',
      key: 'index',
      title: this.t('AI Drawio'),
      componentLoader: () => import('../client/DrawioManager').then((module) => ({ default: module.DrawioManager })),
    });

    for (const [name, options] of drawioClientTools) {
      this.ai.toolsManager.registerTools(name, options);
    }
  }
}

export default PluginAiDrawioClient;
