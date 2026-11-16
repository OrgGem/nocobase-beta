// SPDX-License-Identifier: Apache-2.0

import { Plugin } from '@nocobase/server';

export class PluginAdvanceSettingsServer extends Plugin {
  async load() {
    this.app.acl.registerSnippet({
      name: `pm.${this.name}`,
      actions: ['systemSettings:get', 'systemSettings:put'],
    });
  }
}

export default PluginAdvanceSettingsServer;
