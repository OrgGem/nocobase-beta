import { Plugin } from '@nocobase/client';
import { UserGuideManager } from './UserGuideManager';
import { UserGuideBlockProvider } from './UserGuideBlockProvider';
import { UserGuideBlockInitializer } from './UserGuideBlockInitializer';
import { UserGuideBlockModel } from './models/UserGuideBlockModel';

export class PluginBuildGuideBlockClient extends Plugin {
  async load() {
    this.app.pluginSettingsManager.add('ai-build-guide', {
      icon: 'ReadOutlined',
      title: '{{t("Build Guide Block", { ns: "build-guide-block" })}}',
      Component: UserGuideManager,
      aclSnippet: 'pm.ai-build-guide',
    });

    this.app.use(UserGuideBlockProvider);

    const blocksInit = this.app.schemaInitializerManager.get('page:addBlock');
    blocksInit?.add('otherBlocks.aiUserGuide', {
      title: '{{t("User Guide", { ns: "build-guide-block" })}}',
      Component: 'UserGuideBlockInitializer',
    });

    this.flowEngine.registerModels({
      UserGuideBlockModel,
    });
  }
}

export default PluginBuildGuideBlockClient;
