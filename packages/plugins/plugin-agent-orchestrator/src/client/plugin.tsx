import { Plugin } from '@nocobase/client';
import { OrchestratorSettings } from './OrchestratorSettings';

export class PluginAgentOrchestratorClient extends Plugin {
  async load() {
    // Register under the "AI" settings group for consistency with other AI plugins
    this.app.pluginSettingsManager.add('ai.orchestrator', {
      title: 'Agent Orchestrator',
      icon: 'ApartmentOutlined',
      Component: OrchestratorSettings,
    });
  }
}

export default PluginAgentOrchestratorClient;
