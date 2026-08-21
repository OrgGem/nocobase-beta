import { Plugin } from '@nocobase/client';
import { DrawioManager } from './DrawioManager';
import { namespace } from './locale';
import { drawioClientTools } from './tools';

export class PluginAIDrawioClient extends Plugin {
  async load() {
    this.app.pluginSettingsManager.add('ai-drawio', {
      icon: 'ApartmentOutlined',
      title: `{{t("AI Drawio", { ns: "${namespace}" })}}`,
      Component: DrawioManager,
      aclSnippet: 'pm.ai-drawio',
    });

    this.registerAITools();
  }

  private registerAITools() {
    const toolsManager = (this.app as any).aiManager?.toolsManager;
    if (!toolsManager) {
      console.warn('[plugin-ai-drawio] aiManager not available; skipping AI integration');
      return;
    }

    for (const [name, options] of drawioClientTools) {
      toolsManager.registerTools(name, options);
    }
  }
}

export default PluginAIDrawioClient;
