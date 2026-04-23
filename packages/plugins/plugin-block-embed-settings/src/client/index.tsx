import { Plugin, RemoteSelect } from '@nocobase/client';
import { EmbedSettingsBlockProvider } from './EmbedSettingsBlockProvider';
import { embedSettingsBlockSettings } from './schemaSettings';
import { EmbedSettingsManager } from './EmbedSettingsManager';
import { NAMESPACE } from './locale';
import { useEmbedSettingsPlugins } from './EmbedSettingsBlockInitializer';
import { EmbedSettingsBlockModel } from './models/EmbedSettingsBlockModel';
import { EmbedSettingsPluginSelect } from './EmbedSettingsPluginSelect';

export class PluginBlockEmbedSettingsClient extends Plugin {
  async load() {
    this.app.addComponents({ RemoteSelect, EmbedSettingsPluginSelect });
    this.app.schemaSettingsManager.add(embedSettingsBlockSettings);
    this.app.use(EmbedSettingsBlockProvider);

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

    this.app.schemaInitializerManager.addItem('page:addBlock', 'otherBlocks.embedSettings', commonSettings);
    this.app.schemaInitializerManager.addItem('popup:common:addBlock', 'otherBlocks.embedSettings', commonSettings);
    this.app.schemaInitializerManager.addItem('popup:addNew:addBlock', 'otherBlocks.embedSettings', commonSettings);
  }
}

export default PluginBlockEmbedSettingsClient;
