import { Plugin } from '@nocobase/server';

export class PluginAdvanceChartsServer extends Plugin {
  requiredPlugins() {
    return ['@nocobase/plugin-data-visualization'];
  }
}

export default PluginAdvanceChartsServer;
