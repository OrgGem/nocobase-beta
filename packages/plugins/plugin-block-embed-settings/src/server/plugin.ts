// SPDX-License-Identifier: Apache-2.0

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

    this.app.resourcer.define({
      name: 'embedSettings',
      only: ['enabled'],
      actions: {
        enabled: async (ctx, next) => {
          const records = await this.db.getCollection('embedAllowedPlugins').model.findAll({
            attributes: ['pluginName', 'title'],
            where: { enabled: true },
            raw: true,
          });
          ctx.body = records;
          await next();
        },
      },
    });
    this.app.acl.allow('embedSettings', 'enabled', 'loggedIn');
  }
}

export default PluginBlockEmbedSettingsServer;
