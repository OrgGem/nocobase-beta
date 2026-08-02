import { Plugin, Application } from '@nocobase/client-v2';

export class PluginAiApiClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'ai-api',
      title: this.t('AI API Gateway'),
      icon: 'ApiOutlined',
      aclSnippet: 'pm.ai-api.configuration',
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai-api',
      key: 'index',
      title: this.t('Configuration'),
      componentLoader: () => import('./pages/GeneralPage'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai-api',
      key: 'model-pricing',
      title: this.t('Model pricing'),
      componentLoader: () => import('./pages/ModelPricingPage'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai-api',
      key: 'user-quotas',
      title: this.t('User quotas'),
      componentLoader: () => import('./pages/UserQuotasPage'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai-api',
      key: 'usage',
      title: this.t('Usage'),
      componentLoader: () => import('./pages/UsagePage'),
    });
  }
}

export default PluginAiApiClient;
