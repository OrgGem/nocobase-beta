/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Application, Plugin } from '@nocobase/client-v2';
import PluginDataVisualizationClient from '@nocobase/plugin-data-visualization/client-v2';

import { createAdvancedCharts } from './charts';
import { getDataVisualizationPlugin } from './compat/dataVisualizationPlugin';

type DataVisualizationPluginLike = PluginDataVisualizationClient & {
  charts?: PluginDataVisualizationClient['charts'];
};

export class PluginAdvanceChartsClientV2 extends Plugin<unknown, Application> {
  private readonly dataVisualizationLoadedEvents = [
    'plugin:data-visualization:loaded',
    'plugin:@nocobase/plugin-data-visualization:loaded',
  ];

  private removeDataVisualizationLoadedListeners() {
    this.dataVisualizationLoadedEvents.forEach((eventName) => {
      this.app.eventBus.removeEventListener(eventName, this.registerAfterDataVisualizationLoaded);
    });
  }

  private readonly registerAfterDataVisualizationLoaded = async () => {
    if (await this.register()) {
      this.removeDataVisualizationLoadedListeners();
    }
  };

  private getDataVisualizationPlugin() {
    return getDataVisualizationPlugin(this.app) as DataVisualizationPluginLike | undefined;
  }

  private registerAdvancedCharts() {
    const dataVisualization = this.getDataVisualizationPlugin();
    if (!dataVisualization?.charts) {
      this.context.logger?.warn?.('[plugin-advance-charts] @nocobase/plugin-data-visualization is required.');
      return false;
    }

    if (!dataVisualization.charts.getChart('advanced-charts.advanced-statistic')) {
      dataVisualization.charts.addGroup('advanced-charts', {
        title: String(this.t('Advanced Charts')),
        charts: createAdvancedCharts(),
        sort: -0.5,
      });
    }
    return true;
  }

  private async register() {
    if (!this.registerAdvancedCharts()) {
      return false;
    }
    return true;
  }

  async load() {
    if (await this.register()) {
      return;
    }

    this.removeDataVisualizationLoadedListeners();
    this.dataVisualizationLoadedEvents.forEach((eventName) => {
      this.app.eventBus.addEventListener(eventName, this.registerAfterDataVisualizationLoaded);
    });
  }
}

export default PluginAdvanceChartsClientV2;
