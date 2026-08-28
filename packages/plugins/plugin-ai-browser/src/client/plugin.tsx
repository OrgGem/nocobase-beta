import { Plugin } from '@nocobase/client-v2';
import { AIBrowserManager } from './AIBrowserManager';
import { AIBrowserWorkContext } from './AIBrowserWorkContext';
import { namespace } from './locale';
import { aiBrowserClientTools } from './tools';
import { AIBrowserBlockModel } from './models';

export class PluginAIBrowserClient extends Plugin {
  async load() {
    // Register FlowModel (v2 pattern)
    this.flowEngine.registerModels({
      AIBrowserBlockModel,
    });

    // Settings page (pluginSettingsManager works in both v1 and v2)
    this.app.pluginSettingsManager.add('ai-browser', {
      icon: 'GlobalOutlined',
      title: `{{t("AI Browser", { ns: "${namespace}" })}}`,
      Component: AIBrowserManager,
      aclSnippet: 'pm.ai-browser',
    });

    this.registerAIWorkContext();
    this.registerAITools();
  }

  private registerAITools() {
    const toolsManager = this.app.ai?.toolsManager;
    if (!toolsManager) {
      console.warn('[plugin-ai-browser] aiManager not available; skipping AI integration');
      return;
    }

    for (const [name, options] of aiBrowserClientTools) {
      toolsManager.registerTools(name, options);
    }
  }

  private registerAIWorkContext() {
    try {
      const aiPlugin = this.app.pm.get('ai') || this.app.pm.get('@nocobase/plugin-ai');
      const aiManager = aiPlugin?.aiManager;
      if (aiManager?.registerWorkContext && !aiManager.getWorkContext?.('browser')) {
        aiManager.registerWorkContext('browser', AIBrowserWorkContext);
      }
    } catch {
      console.warn('[plugin-ai-browser] plugin-ai client not available; skipping work context registration');
    }
  }
}

export default PluginAIBrowserClient;
