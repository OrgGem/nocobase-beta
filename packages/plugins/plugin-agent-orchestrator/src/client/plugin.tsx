import { Plugin } from '@nocobase/client';
import { OrchestratorSettings } from './OrchestratorSettings';
import { InteractionSchemasProvider } from './skill-hub/tools/InteractionSchemasProvider';
import { registerSkillLoopCards } from './skill-hub/tools/registerSkillLoopCards';
import { registerOrchestratorCards } from './tools/registerOrchestratorCards';

export class PluginAgentOrchestratorClient extends Plugin {
  async load() {
    (this as any).app.use(InteractionSchemasProvider);

    // Register under the "AI" settings group for consistency with other AI plugins
    (this as any).app.pluginSettingsManager.add('ai.orchestrator', {
      title: 'Agent Orchestrator',
      icon: 'ApartmentOutlined',
      Component: OrchestratorSettings,
    });

    await this.registerSkillUiCards();
  }

  private async registerSkillUiCards() {
    await registerOrchestratorCards((this as any).app);
    await registerSkillLoopCards((this as any).app);
  }
}

export default PluginAgentOrchestratorClient;
