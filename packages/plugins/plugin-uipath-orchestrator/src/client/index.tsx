import { Plugin } from '@nocobase/client';
import { UiPathSettingsPage } from './components/UiPathSettingsPage';

export class PluginUiPathOrchestratorClient extends Plugin {
  async load() {
    this.app.pluginSettingsManager.add('uipath-orchestrator', {
      title: this.t('UiPath Orchestrator'),
      icon: 'RobotOutlined',
      Component: UiPathSettingsPage,
      aclSnippet: 'pm.plugin-uipath-orchestrator',
    });
  }
}

export default PluginUiPathOrchestratorClient;
