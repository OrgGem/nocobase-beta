import { Plugin } from '@nocobase/client';
import PluginDataVisualizationClient from '@nocobase/plugin-data-visualization/client';

import { createAdvancedCharts } from '../client-v2/charts';
import { patchDataVisualizationChartBlock } from '../client-v2/compat/registerDataVisualizationCompat';
import models from './models';

type DataVisualizationPluginLike = PluginDataVisualizationClient & {
  charts?: PluginDataVisualizationClient['charts'];
};

declare global {
  interface Window {
    __nocobaseAdvanceCharts?: {
      chartTypes: unknown;
      charts: string[];
    };
  }
}

export class PluginAdvanceChartsClient extends Plugin {
  private getDataVisualizationPlugin() {
    return (
      this.app.pm.get(PluginDataVisualizationClient) ||
      this.app.pm.get<DataVisualizationPluginLike>('@nocobase/plugin-data-visualization') ||
      this.app.pm.get<DataVisualizationPluginLike>('data-visualization')
    );
  }

  private registerAdvancedCharts() {
    const dataVisualization = this.getDataVisualizationPlugin();
    if (!dataVisualization?.charts) {
      return;
    }

    if (!dataVisualization.charts.getChart('advanced-charts.advanced-statistic')) {
      dataVisualization.charts.addGroup('advanced-charts', {
        title: this.t('Advanced Charts'),
        charts: createAdvancedCharts(),
        sort: -0.5,
      });
    }

    if (typeof window !== 'undefined') {
      window.__nocobaseAdvanceCharts = {
        chartTypes: dataVisualization.charts.getChartTypes(),
        charts: Object.keys(dataVisualization.charts.getCharts()),
      };
    }
  }

  async load() {
    this.flowEngine.registerModels(models);
    this.registerAdvancedCharts();
    await patchDataVisualizationChartBlock(this.flowEngine);
  }
}

export default PluginAdvanceChartsClient;
