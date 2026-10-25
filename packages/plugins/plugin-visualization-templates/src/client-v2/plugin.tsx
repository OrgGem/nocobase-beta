/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin, Application } from '@nocobase/client-v2';
import React from 'react';
import { namespace } from './locale';
import type { DashboardTabKey, VisualizationTemplatesManagerProps } from './work-monitor/VisualizationTemplatesManager';
import '../client/work-monitor/templates';

const pages: Array<{ key: DashboardTabKey; title: string }> = [
  { key: 'executive', title: 'Executive' },
  { key: 'monitor', title: 'Monitor' },
  { key: 'visualize', title: 'Visualize' },
  { key: 'tasks', title: 'Tasks' },
  { key: 'settings', title: 'Settings' },
];
export class PluginVisualizationTemplatesClient extends Plugin<Record<string, never>, Application> {
  async load() {
    const aclSnippet = 'pm.' + namespace;
    this.pluginSettingsManager.addMenuItem({
      key: namespace,
      title: this.t('Work dashboard'),
      icon: 'DashboardOutlined',
      aclSnippet,
      embedSettings: { requiresCollection: true },
    });
    pages.forEach((page, index) =>
      this.pluginSettingsManager.addPageTabItem({
        menuKey: namespace,
        key: page.key,
        title: this.t(page.title),
        aclSnippet,
        sort: index + 1,
        embedSettings: { requiresCollection: true },
        componentLoader: () =>
          import('./work-monitor/VisualizationTemplatesManager').then(({ VisualizationTemplatesManager }) => ({
            default: (props: VisualizationTemplatesManagerProps) => (
              <VisualizationTemplatesManager {...props} initialTab={page.key} visibleTabKeys={[page.key]} />
            ),
          })),
      }),
    );
  }
}
export default PluginVisualizationTemplatesClient;
