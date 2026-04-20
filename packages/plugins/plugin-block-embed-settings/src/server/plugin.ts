import { Plugin } from '@nocobase/server';
import { resolve } from 'path';

export class PluginBlockEmbedSettingsServer extends Plugin {
  async load() {
    await this.db.import({
      directory: resolve(__dirname, 'collections'),
    });

    // REST actions for embedAllowedPlugins (CRUD is auto-provided by collection)
    // Register ACL
    this.app.acl.registerSnippet({
      name: `pm.${this.name}`,
      actions: ['embedAllowedPlugins:*'],
    });

    // Public read access so blocks can check allowed list
    this.app.acl.allow('embedAllowedPlugins', 'list', 'loggedIn');
  }
}

export default PluginBlockEmbedSettingsServer;
