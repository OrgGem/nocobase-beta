import { Plugin } from '@nocobase/client';
import React from 'react';

import { type DashboardTabKey, VisualizationTemplatesManager } from './work-monitor/VisualizationTemplatesManager';
import './work-monitor/templates';
import { namespace } from './locale';

const tabPages: { key: DashboardTabKey; title: string }[] = [
  { key: 'executive', title: 'Executive' },
  { key: 'monitor', title: 'Monitor' },
  { key: 'visualize', title: 'Visualize' },
  { key: 'tasks', title: 'Tasks' },
  { key: 'settings', title: 'Settings' },
];

const createTabPage = (key: DashboardTabKey) => (props: any) =>
  React.createElement(VisualizationTemplatesManager, {
    ...props,
    initialTab: key,
    visibleTabKeys: [key],
  });

export class PluginVisualizationTemplatesClient extends Plugin {
  async afterAdd() {
    try {
      this.app.pm.get('@nocobase/plugin-data-visualization') || this.app.pm.get('plugin-data-visualization');
    } catch {
      console.warn('[plugin-visualization-templates] plugin-data-visualization is not available');
    }
  }

  async load() {
    console.info('[plugin-visualization-templates] loading work dashboard settings page');

    this.app.pluginSettingsManager.add(namespace, {
      title: `{{t("Work dashboard", { ns: "${namespace}" })}}`,
      icon: 'DashboardOutlined',
      aclSnippet: `pm.${namespace}`,
      embedSettings: {
        requiresCollection: true,
      },
    });

    tabPages.forEach((page, index) => {
      this.app.pluginSettingsManager.add(`${namespace}.${page.key}`, {
        title: page.title,
        Component: createTabPage(page.key),
        aclSnippet: `pm.${namespace}`,
        sort: index + 1,
        embedSettings: {
          requiresCollection: true,
        },
      });
    });
  }

  async remove() {
    tabPages.forEach((page) => {
      this.app.pluginSettingsManager.remove(`${namespace}.${page.key}`);
    });
    this.app.pluginSettingsManager.remove(namespace);
    this.app.schemaInitializerManager.removeItem('page:addBlock', 'dataBlocks.visualizationTemplates');
    this.app.schemaInitializerManager.removeItem('mobile:addBlock', 'dataBlocks.visualizationTemplates');
    this.app.schemaInitializerManager.removeItem('popup:common:addBlock', 'dataBlocks.visualizationTemplates');
    this.app.schemaInitializerManager.removeItem('popup:addNew:addBlock', 'dataBlocks.visualizationTemplates');
  }
}

export default PluginVisualizationTemplatesClient;
