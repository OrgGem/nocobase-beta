import { useApp } from '@nocobase/client-v2';
import PluginDataVisualizationClient from '@nocobase/plugin-data-visualization/client-v2';

type DataVisualizationPluginLike = PluginDataVisualizationClient & {
  charts?: PluginDataVisualizationClient['charts'];
};

function looksLikeDataVisualizationPlugin(plugin: unknown): plugin is DataVisualizationPluginLike {
  return !!(plugin as DataVisualizationPluginLike | undefined)?.charts?.getCharts;
}

function findPluginWithCharts(pm: unknown) {
  const manager = pm as
    | {
        pluginInstances?: Map<unknown, unknown>;
        pluginsAliases?: Record<string, unknown>;
      }
    | undefined;

  const aliases = manager?.pluginsAliases ? Object.values(manager.pluginsAliases) : [];
  const instances = manager?.pluginInstances ? Array.from(manager.pluginInstances.values()) : [];

  return [...aliases, ...instances].find(looksLikeDataVisualizationPlugin);
}

export function getDataVisualizationPlugin(app: {
  pm?: {
    get<T = unknown>(nameOrClass: unknown): T;
  };
}) {
  const pm = app?.pm;
  const plugin =
    pm?.get<DataVisualizationPluginLike>(PluginDataVisualizationClient) ||
    pm?.get<DataVisualizationPluginLike>('@nocobase/plugin-data-visualization') ||
    pm?.get<DataVisualizationPluginLike>('data-visualization');

  return looksLikeDataVisualizationPlugin(plugin) ? plugin : findPluginWithCharts(pm);
}

export function useDataVisualizationPluginCompat() {
  const app = useApp();
  return getDataVisualizationPlugin(app);
}

export function useChartsCompat() {
  return useDataVisualizationPluginCompat()?.charts?.getCharts?.() || {};
}

export function useDefaultChartTypeCompat() {
  return useDataVisualizationPluginCompat()?.charts?.getDefaultChartType?.();
}
