/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin } from '@nocobase/server';
import path from 'path';

export class PluginCustomSubpathServer extends Plugin {
  async afterAdd() {}

  async beforeLoad() {}

  async load() {
    // Load collection definitions from the collections directory
    await this.importCollections(path.resolve(__dirname, 'collections'));

    // Register ACL snippet for managing custom subpaths
    this.app.acl.registerSnippet({
      name: `pm.${this.name}.custom-subpaths`,
      actions: ['customSubpaths:*'],
    });

    // Allow logged-in users to list subpaths (needed for client-side route registration)
    this.app.acl.allow('customSubpaths', 'list', 'loggedIn');
  }

  async install() {}

  async afterEnable() {}

  async afterDisable() {}

  async remove() {}
}

export default PluginCustomSubpathServer;
