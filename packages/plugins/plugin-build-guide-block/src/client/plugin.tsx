import { Plugin } from '@nocobase/client';
import { UserGuideManager } from './UserGuideManager';
import { UserGuideBlockProvider } from './UserGuideBlockProvider';
import { UserGuideBlockInitializer } from './UserGuideBlockInitializer';
import { UserGuideBlock } from './UserGuideBlock';
import { UserGuideBlockModel } from './models/UserGuideBlockModel';
import { userGuideBlockSettings } from './schemaSettings';
import { BuildButton } from './components/BuildButton';
import { LLMServiceSelect } from './components/LLMServiceSelect';
import { ModelSelect } from './components/ModelSelect';
import { StatusTag } from './components/StatusTag';
import { SpaceSelect } from './components/SpaceSelect';
import { namespace } from './locale';

export class PluginBuildGuideBlockClient extends Plugin {
  async load() {
    this.app.addComponents({
      UserGuideBlock,
      UserGuideBlockInitializer,
      BuildButton,
      LLMServiceSelect,
      ModelSelect,
      StatusTag,
      SpaceSelect,
    });

    this.app.schemaSettingsManager.add(userGuideBlockSettings);

    this.app.use(UserGuideBlockProvider);

    this.app.pluginSettingsManager.add('ai-build-guide', {
      icon: 'ReadOutlined',
      title: `{{t("Build Guide Block", { ns: "${namespace}" })}}`,
      Component: UserGuideManager,
      aclSnippet: 'pm.ai-build-guide',
    });

    const initializerItem = {
      title: `{{t("User Guide", { ns: "${namespace}" })}}`,
      Component: 'UserGuideBlockInitializer',
    };

    this.app.schemaInitializerManager.addItem('page:addBlock', 'otherBlocks.aiUserGuide', initializerItem);
    this.app.schemaInitializerManager.addItem('popup:common:addBlock', 'otherBlocks.aiUserGuide', initializerItem);
    this.app.schemaInitializerManager.addItem('popup:addNew:addBlock', 'otherBlocks.aiUserGuide', initializerItem);

    this.flowEngine.registerModels({
      UserGuideBlockModel,
    });
  }
}

export default PluginBuildGuideBlockClient;
