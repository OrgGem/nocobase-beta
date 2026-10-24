import { Plugin, Application } from '@nocobase/client-v2';
import { UserGuideBlockModel } from './models/UserGuideBlockModel';

export class PluginBuildGuideBlockClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.flowEngine.registerModels({ UserGuideBlockModel });
    this.pluginSettingsManager.addMenuItem({
      key: 'ai-build-guide',
      title: this.t('Build Guide Block'),
      icon: 'ReadOutlined',
      aclSnippet: 'pm.ai-build-guide',
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai-build-guide',
      key: 'index',
      title: this.t('Build Guide Block'),

      componentLoader: () => import('../client/UserGuideManager').then((m) => ({ default: m.UserGuideManager })),
    });
  }
}

export default PluginBuildGuideBlockClient;
