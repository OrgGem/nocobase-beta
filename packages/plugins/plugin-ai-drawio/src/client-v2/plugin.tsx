/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

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
