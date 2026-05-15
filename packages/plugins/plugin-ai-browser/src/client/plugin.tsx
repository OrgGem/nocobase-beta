import { Plugin } from '@nocobase/client';
import { AIBrowserBlock } from './AIBrowserBlock';
import { AIBrowserSessionCard } from './AIBrowserSessionCard';
import { AIBrowserManager } from './AIBrowserManager';
import { AIBrowserWorkContext } from './AIBrowserWorkContext';
import { namespace } from './locale';
import { AIBrowserBlockInitializer } from './AIBrowserBlockInitializer';
import { aiBrowserBlockSettings } from './schemaSettings';
import { aiBrowserClientTools } from './tools';
import { AIBrowserBlockModel } from './models';

export class PluginAIBrowserClient extends Plugin {
  async load() {
    (this as any).app.addComponents({
      AIBrowserBlock,
      AIBrowserSessionCard,
      AIBrowserBlockInitializer,
    });

    (this as any).app.schemaSettingsManager.add(aiBrowserBlockSettings);

    (this as any).app.pluginSettingsManager.add('ai-browser', {
      icon: 'GlobalOutlined',
      title: `{{t("AI Browser", { ns: "${namespace}" })}}`,
      Component: AIBrowserManager,
      aclSnippet: 'pm.ai-browser',
    });

    const initializerItem = {
      title: `{{t("AI Browser", { ns: "${namespace}" })}}`,
      Component: 'AIBrowserBlockInitializer',
    };

    (this as any).app.schemaInitializerManager.addItem('page:addBlock', 'otherBlocks.aiBrowser', initializerItem);
    (this as any).app.schemaInitializerManager.addItem('popup:common:addBlock', 'otherBlocks.aiBrowser', initializerItem);
    (this as any).app.schemaInitializerManager.addItem('popup:addNew:addBlock', 'otherBlocks.aiBrowser', initializerItem);

    (this as any).flowEngine.registerModels({
      AIBrowserBlockModel,
    });

    this.registerAIWorkContext();
    this.registerAITools();
  }

  private registerAITools() {
    const toolsManager = (this as any).app.aiManager?.toolsManager;
    if (!toolsManager) {
      console.warn('[plugin-ai-browser] aiManager not available; skipping AI integration');
      return;
    }

    for (const [name, options] of aiBrowserClientTools) {
      toolsManager.registerTools(name, options);
    }
  }

  private registerAIWorkContext() {
    const getAIPlugin = () => {
      try {
        return (this as any).app.pm.get('ai') as any;
      } catch {
        try {
          return (this as any).app.pm.get('@nocobase/plugin-ai') as any;
        } catch {
          return null;
        }
      }
    };

    try {
      const aiManager = getAIPlugin()?.aiManager;
      if (aiManager?.registerWorkContext && !aiManager.getWorkContext?.('browser')) {
        aiManager.registerWorkContext('browser', AIBrowserWorkContext);
      }
    } catch {
      console.warn('[plugin-ai-browser] plugin-ai client not available; skipping work context registration');
    }
  }
}

export default PluginAIBrowserClient;
