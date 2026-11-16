// SPDX-License-Identifier: Apache-2.0

import { Plugin } from '@nocobase/client';
import PluginAIClient from '@nocobase/plugin-ai';
import { customLLMProviderOptions } from './llm-providers/custom-llm';

export class PluginCustomLLMClient extends Plugin {
  async afterAdd() {}

  async beforeLoad() {}

  async load() {
    this.aiPlugin.aiManager.registerLLMProvider('custom-llm', customLLMProviderOptions);
  }

  private get aiPlugin(): PluginAIClient {
    return this.app.pm.get('ai');
  }
}

export default PluginCustomLLMClient;
