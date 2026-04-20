/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

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
