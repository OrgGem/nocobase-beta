import { Plugin, Application } from '@nocobase/client-v2';

export class PluginUipathOrchestratorClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'uipath-orchestrator',
      title: this.t('UiPath Orchestrator'),
      icon: 'RobotOutlined',
      aclSnippet: 'pm.plugin-uipath-orchestrator',
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'uipath-orchestrator',
      key: 'index',
      title: this.t('UiPath Orchestrator'),

      componentLoader: () => import('./components/UiPathSettingsPage').then((m) => ({ default: m.UiPathSettingsPage })),
    });
  }
}

export default PluginUipathOrchestratorClient;
