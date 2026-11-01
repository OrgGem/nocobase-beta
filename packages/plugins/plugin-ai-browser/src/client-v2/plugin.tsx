import { Plugin, Application } from '@nocobase/client-v2';
import type PluginAIClientV2 from '@nocobase/plugin-ai/client-v2';
import { BrowserWorkContext } from './BrowserWorkContext';
import BrowserToolCard from './components/BrowserToolCard';
import { AIBrowserBlockModel } from './models/AIBrowserBlockModel';

export class PluginAiBrowserClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.flowEngine.registerModels({ AIBrowserBlockModel });
    const ai = this.app.pm.get<PluginAIClientV2>('ai');
    if (ai) {
      ai.aiManager.registerWorkContext('browser', BrowserWorkContext);
      this.ai.toolsManager.registerTools('browser_open_url', { ui: { card: BrowserToolCard } });
    }
    this.pluginSettingsManager.addMenuItem({
      key: 'ai-browser',
      title: this.t('AI Browser'),
      icon: 'GlobalOutlined',
      aclSnippet: 'pm.ai-browser',
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai-browser',
      key: 'index',
      title: this.t('AI Browser'),

      componentLoader: () => {
        // The shared native settings screens use the historical short namespace.
        const i18n = this.app.i18n;
        for (const language of i18n.languages) {
          const resources = i18n.getResourceBundle(language, 'plugin-ai-browser');
          if (resources) i18n.addResourceBundle(language, 'ai-browser', resources, true, true);
        }
        return import('../client/AIBrowserManager').then((module) => ({ default: module.AIBrowserManager }));
      },
    });
  }
}

export default PluginAiBrowserClient;
