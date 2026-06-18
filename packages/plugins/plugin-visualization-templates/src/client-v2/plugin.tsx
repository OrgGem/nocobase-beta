import { Plugin, Application } from '@nocobase/client-v2';
import React from 'react';

export class PluginVisualizationTemplatesClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'plugin-visualization-templates',
      title: this.t('Work dashboard'),
      icon: 'DashboardOutlined',
      
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'plugin-visualization-templates',
      key: 'executive',
      title: this.t('Executive'),
      
      componentLoader: () => import('../client/work-monitor/VisualizationTemplatesManager').then(m => ({ default: (props: any) => React.createElement(m.VisualizationTemplatesManager, { ...props, initialTab: "executive", visibleTabKeys: ["executive"] }) })),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'plugin-visualization-templates',
      key: 'monitor',
      title: this.t('Monitor'),
      
      componentLoader: () => import('../client/work-monitor/VisualizationTemplatesManager').then(m => ({ default: (props: any) => React.createElement(m.VisualizationTemplatesManager, { ...props, initialTab: "monitor", visibleTabKeys: ["monitor"] }) })),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'plugin-visualization-templates',
      key: 'visualize',
      title: this.t('Visualize'),
      
      componentLoader: () => import('../client/work-monitor/VisualizationTemplatesManager').then(m => ({ default: (props: any) => React.createElement(m.VisualizationTemplatesManager, { ...props, initialTab: "visualize", visibleTabKeys: ["visualize"] }) })),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'plugin-visualization-templates',
      key: 'tasks',
      title: this.t('Tasks'),
      
      componentLoader: () => import('../client/work-monitor/VisualizationTemplatesManager').then(m => ({ default: (props: any) => React.createElement(m.VisualizationTemplatesManager, { ...props, initialTab: "tasks", visibleTabKeys: ["tasks"] }) })),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'plugin-visualization-templates',
      key: 'settings',
      title: this.t('Settings'),
      
      componentLoader: () => import('../client/work-monitor/VisualizationTemplatesManager').then(m => ({ default: (props: any) => React.createElement(m.VisualizationTemplatesManager, { ...props, initialTab: "settings", visibleTabKeys: ["settings"] }) })),
    });

  }
}

export default PluginVisualizationTemplatesClient;
