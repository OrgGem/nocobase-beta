import { Plugin } from '@nocobase/client-v2';
import PluginAIClientV2, { formatModelLabel, type LLMProviderOptions } from '@nocobase/plugin-ai/client-v2';
import { ModelSettingsForm, ProviderSettingsForm } from './settings';

export const customLLMProviderOptions: LLMProviderOptions = {
  components: { ProviderSettingsForm, ModelSettingsForm },
  formatModelLabel,
};

export class PluginCustomLLMClient extends Plugin {
  async load() {
    this.app.pm.get(PluginAIClientV2).aiManager.registerLLMProvider('custom-llm', customLLMProviderOptions);
  }
}

export default PluginCustomLLMClient;
