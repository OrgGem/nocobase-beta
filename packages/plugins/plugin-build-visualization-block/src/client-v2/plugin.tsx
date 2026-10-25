/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin, Application } from '@nocobase/client-v2';
import { BuildVisualizationBlockModel } from './models/BuildVisualizationBlockModel';

export class PluginBuildVisualizationBlockClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.flowEngine.registerModels({ BuildVisualizationBlockModel });
    this.pluginSettingsManager.addMenuItem({
      key: 'plugin-build-visualization-block',
      title: this.t('Build Visualization Block'),
      icon: 'DashboardOutlined',
      aclSnippet: 'pm.plugin-build-visualization-block.settings',
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'plugin-build-visualization-block',
      key: 'index',
      title: this.t('Build Visualization Block'),
      aclSnippet: 'pm.plugin-build-visualization-block.settings',
      componentLoader: () => import('./pages/SettingsPage'),
    });
  }
}

export default PluginBuildVisualizationBlockClient;
