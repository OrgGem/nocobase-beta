import { Application, Plugin } from '@nocobase/client-v2';
import PluginDataVisualizationClient from '@nocobase/plugin-data-visualization/client-v2';

import { createAdvancedCharts } from './charts';
import { getDataVisualizationPlugin } from './compat/dataVisualizationPlugin';
import { patchDataVisualizationChartBlock } from './compat/registerDataVisualizationCompat';

type DataVisualizationPluginLike = PluginDataVisualizationClient & {
  charts?: PluginDataVisualizationClient['charts'];
};

export class PluginAdvanceChartsClientV2 extends Plugin<unknown, Application> {
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
        title: this.t('Advanced Charts'),
        charts: createAdvancedCharts(),
        sort: -0.5,
      });
    }
    return true;
  }

  private async ensureChartBlockModelLoaded() {
    await patchDataVisualizationChartBlock(this.flowEngine);
  }

  private async register() {
    if (!this.registerAdvancedCharts()) {
      return;
    }
    await this.ensureChartBlockModelLoaded();
  }

  async load() {
    await this.register();

    const registerAfterDataVisualizationLoaded = async () => {
      await this.register();
    };
    this.app.eventBus.addEventListener('plugin:data-visualization:loaded', registerAfterDataVisualizationLoaded);
    this.app.eventBus.addEventListener(
      'plugin:@nocobase/plugin-data-visualization:loaded',
      registerAfterDataVisualizationLoaded,
    );
  }
}

export default PluginAdvanceChartsClientV2;
