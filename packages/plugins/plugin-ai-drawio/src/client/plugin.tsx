import { Plugin } from '@nocobase/client';
import { DrawioBlock } from './DrawioBlock';
import { DrawioBlockInitializer } from './DrawioBlockInitializer';
import { DrawioBlockProvider } from './DrawioBlockProvider';
import { DrawioBlockModel } from './models/DrawioBlockModel';
import { DrawioManager } from './DrawioManager';
import { DiagramSelect } from './components/DiagramSelect';
import { drawioBlockSettings } from './schemaSettings';
import { namespace } from './locale';
import { drawioClientTools } from './tools';
import { DrawioWorkContext } from './workContext';

export class PluginAIDrawioClient extends Plugin {
  async load() {
    this.app.addComponents({
      DrawioBlock,
      DrawioBlockInitializer,
      DiagramSelect,
    });

    this.app.schemaSettingsManager.add(drawioBlockSettings);

    this.app.pluginSettingsManager.add('ai-drawio', {
      icon: 'ApartmentOutlined',
      title: `{{t("AI Drawio", { ns: "${namespace}" })}}`,
      Component: DrawioManager,
      aclSnippet: 'pm.ai-drawio',
    });

    const initializerItem = {
      title: `{{t("Drawio Diagram", { ns: "${namespace}" })}}`,
      Component: 'DrawioBlockInitializer',
    };

    this.app.schemaInitializerManager.addItem('page:addBlock', 'otherBlocks.aiDrawio', initializerItem);
    this.app.schemaInitializerManager.addItem('popup:common:addBlock', 'otherBlocks.aiDrawio', initializerItem);
    this.app.schemaInitializerManager.addItem('popup:addNew:addBlock', 'otherBlocks.aiDrawio', initializerItem);

    this.flowEngine.registerModels({
      DrawioBlockModel,
    });

    this.registerAITools();
  }

  private registerAITools() {
    const aiManager = (this.app as any).aiManager;
    if (!aiManager) {
      console.warn('[plugin-ai-drawio] aiManager not available; skipping AI integration');
      return;
    }
    const toolsManager = aiManager.toolsManager;
    if (toolsManager?.registerTools) {
      for (const [name, options] of drawioClientTools) {
        toolsManager.registerTools(name, options);
      }
    }
    if (aiManager.registerWorkContext) {
      aiManager.registerWorkContext('drawio', DrawioWorkContext);
    }
  }
}

export default PluginAIDrawioClient;
