import { Plugin } from '@nocobase/client';

import { createAdvancedCharts } from '../client-v2/charts';
import { patchDataVisualizationChartBlock } from '../client-v2/compat/registerDataVisualizationCompat';
import models from './models';

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
    try {
      return (
        this.app.pm.get('@nocobase/plugin-data-visualization') ||
        this.app.pm.get('data-visualization')
      );
    } catch {
      return null;
    }
  }

  private registerAdvancedCharts() {
    const dataVisualization = this.getDataVisualizationPlugin();
    if (!dataVisualization?.charts) {
      return false;
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
    return true;
  }

  async load() {
    this.flowEngine.registerModels(models);
    if (this.registerAdvancedCharts()) {
      await patchDataVisualizationChartBlock(this.flowEngine);
    }
  }
}

export default PluginAdvanceChartsClient;
