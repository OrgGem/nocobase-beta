import { Plugin } from '@nocobase/server';

export class PluginAdvanceSettingsServer extends Plugin {
  async load() {
    this.app.acl.registerSnippet({
      name: `pm.${this.name}`,
      actions: [],
    });
  }
}

export default PluginAdvanceSettingsServer;
