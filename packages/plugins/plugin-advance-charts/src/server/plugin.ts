import { Plugin } from '@nocobase/server';

export class PluginAdvanceChartsServer extends Plugin {
  requiredPlugins() {
    return ['@nocobase/plugin-data-visualization'];
  }

  async afterAdd() {}

  async beforeLoad() {}

  async load() {}

  async install() {}

  async afterEnable() {}

  async afterDisable() {}

  async remove() {}
}

export default PluginAdvanceChartsServer;
