// SPDX-License-Identifier: Apache-2.0

import { Plugin, Application } from '@nocobase/client-v2';
import { drawioClientTools } from './tools';

export class PluginAiDrawioClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'ai-drawio',
      title: this.t('AI Drawio'),
      icon: 'ApartmentOutlined',
      aclSnippet: 'pm.ai-drawio',
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai-drawio',
      key: 'index',
      title: this.t('AI Drawio'),
      aclSnippet: 'pm.ai-drawio',
      componentLoader: () => import('./DrawioManager').then((module) => ({ default: module.DrawioManager })),
    });

    for (const [name, options] of drawioClientTools) {
      this.ai.toolsManager.registerTools(name, options);
    }
  }
}

export default PluginAiDrawioClient;
