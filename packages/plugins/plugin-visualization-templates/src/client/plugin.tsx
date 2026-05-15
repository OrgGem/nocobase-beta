import { Plugin } from '@nocobase/client';

import { VisualizationTemplateBlockInitializer } from './VisualizationTemplateBlockInitializer';
import { namespace } from './locale';

export class PluginVisualizationTemplatesClient extends Plugin {
  async afterAdd() {
    this.app.pm.get('plugin-data-visualization');
  }

  async load() {
    this.app.addComponents({
      VisualizationTemplateBlockInitializer,
    });

    const initializerItem = {
      title: `{{t("Visualization templates", { ns: "${namespace}" })}}`,
      Component: 'VisualizationTemplateBlockInitializer',
    };

    this.app.schemaInitializerManager.addItem(
      'page:addBlock',
      'dataBlocks.visualizationTemplates',
      initializerItem,
    );
    this.app.schemaInitializerManager.addItem(
      'mobile:addBlock',
      'dataBlocks.visualizationTemplates',
      initializerItem,
    );
    this.app.schemaInitializerManager.addItem(
      'popup:common:addBlock',
      'dataBlocks.visualizationTemplates',
      initializerItem,
    );
  }

  async remove() {
    this.app.schemaInitializerManager.removeItem('page:addBlock', 'dataBlocks.visualizationTemplates');
    this.app.schemaInitializerManager.removeItem('mobile:addBlock', 'dataBlocks.visualizationTemplates');
    this.app.schemaInitializerManager.removeItem('popup:common:addBlock', 'dataBlocks.visualizationTemplates');
  }
}

export default PluginVisualizationTemplatesClient;
