import { Plugin } from '@nocobase/server';

export class PluginVisualizationTemplatesServer extends Plugin {
  async load() {
    this.app.acl.registerSnippet({
      name: 'pm.plugin-visualization-templates',
      actions: [],
    });
  }
}

export default PluginVisualizationTemplatesServer;
