// SPDX-License-Identifier: Apache-2.0

import { Plugin } from '@nocobase/server';
import PluginAIServer from '@nocobase/plugin-ai';
import { customLLMProviderOptions } from './llm-providers/custom-llm';

export class PluginCustomLLMServer extends Plugin {
  async afterAdd() {}

  async beforeLoad() {}

  async load() {
    this.aiPlugin.aiManager.registerLLMProvider('custom-llm', customLLMProviderOptions);
  }

  async install() {}

  async afterEnable() {}

  async afterDisable() {}

  async remove() {}

  private get aiPlugin(): PluginAIServer {
    return this.app.pm.get('ai');
  }
}

export default PluginCustomLLMServer;
