import { Plugin, RemoteSelect } from '@nocobase/client';
import { EmbedSettingsBlockProvider } from './EmbedSettingsBlockProvider';
import { HelpVisibilityProvider } from './HelpVisibilityProvider';
import { EmbedSettingsBlock } from './EmbedSettingsBlock';
import { embedSettingsBlockSettings } from './schemaSettings';
import { EmbedSettingsManager } from './EmbedSettingsManager';
import { NAMESPACE } from './locale';
import { useEmbedSettingsPlugins, EmbedSettingsBlockInitializer } from './EmbedSettingsBlockInitializer';
import { EmbedSettingsBlockModel } from './models/EmbedSettingsBlockModel';
import { EmbedSettingsCollectionSelect } from './EmbedSettingsCollectionSelect';
import { EmbedSettingsPluginSelect } from './EmbedSettingsPluginSelect';
import { EmbedSettingsTabSelect } from './EmbedSettingsTabSelect';

export class PluginBlockEmbedSettingsClient extends Plugin {
  async load() {
    // Register components globally (so string references in schema resolve)
    this.app.addComponents({
      EmbedSettingsBlock,
      EmbedSettingsBlockInitializer,
      EmbedSettingsCollectionSelect,
      EmbedSettingsPluginSelect,
      EmbedSettingsTabSelect,
      RemoteSelect,
    });

    // Register schema settings (gear icon)
    this.app.schemaSettingsManager.add(embedSettingsBlockSettings);

    // Register component provider for SchemaComponentOptions
    this.app.use(EmbedSettingsBlockProvider);
    this.app.use(HelpVisibilityProvider);

    // Register FlowEngine model
    this.flowEngine.registerModels({
      EmbedSettingsBlockModel,
    });

    // Register settings page
    this.app.pluginSettingsManager.add(NAMESPACE, {
      title: this.t('Embed Settings Block'),
      icon: 'BlockOutlined',
      Component: EmbedSettingsManager,
      aclSnippet: `pm.${NAMESPACE}`,
    });

    const title = `{{t("Plugin Settings", { ns: ["${NAMESPACE}", "client"], nsMode: "fallback" })}}`;

    const commonSettings = {
      title,
      type: 'subMenu',
      icon: 'SettingOutlined',
      useChildren: useEmbedSettingsPlugins,
    };

    // Register in all block initializers
    this.app.schemaInitializerManager.addItem('page:addBlock', 'otherBlocks.embedSettings', commonSettings);
    this.app.schemaInitializerManager.addItem('popup:common:addBlock', 'otherBlocks.embedSettings', commonSettings);
    this.app.schemaInitializerManager.addItem('popup:addNew:addBlock', 'otherBlocks.embedSettings', commonSettings);
  }
}

export default PluginBlockEmbedSettingsClient;
