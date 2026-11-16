// SPDX-License-Identifier: Apache-2.0

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
