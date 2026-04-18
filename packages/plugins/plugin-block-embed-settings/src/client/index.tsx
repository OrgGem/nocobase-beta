import { Plugin } from '@nocobase/client';
import { EmbedSettingsBlockProvider } from './EmbedSettingsBlockProvider';
import { embedSettingsBlockSettings } from './schemaSettings';
import { NAMESPACE } from './locale';

export class PluginBlockEmbedSettingsClient extends Plugin {
  async load() {
    this.app.schemaSettingsManager.add(embedSettingsBlockSettings);
    this.app.use(EmbedSettingsBlockProvider);

    const title = `{{t("Plugin Settings", { ns: ["${NAMESPACE}", "client"], nsMode: "fallback" })}}`;

    const blockInitializers = this.app.schemaInitializerManager.get('page:addBlock');
    blockInitializers?.add('otherBlocks.embedSettings', {
      title,
      Component: 'EmbedSettingsBlockInitializer',
    });

    const popupCommon = this.app.schemaInitializerManager.get('popup:common:addBlock');
    popupCommon?.add('otherBlocks.embedSettings', {
      title,
      Component: 'EmbedSettingsBlockInitializer',
    });

    const popupAddNew = this.app.schemaInitializerManager.get('popup:addNew:addBlock');
    popupAddNew?.add('otherBlocks.embedSettings', {
      title,
      Component: 'EmbedSettingsBlockInitializer',
    });
  }
}

export default PluginBlockEmbedSettingsClient;
