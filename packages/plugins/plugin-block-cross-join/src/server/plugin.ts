/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin } from '@nocobase/server';
import { crossJoinQuery } from './actions/cross-join-query';

import path from 'path';

export class PluginBlockCrossJoinServer extends Plugin {
  async beforeLoad() {
    await this.db.import({ directory: path.resolve(__dirname, 'collections') });
  }

  async load() {
    this.app.resourcer.define({
      name: 'crossJoin',
      actions: {
        query: crossJoinQuery,
      },
    });

    this.app.acl.allow('crossJoin', 'query', 'loggedIn');
    this.app.acl.registerSnippet({
      name: 'ui.crossJoin',
      actions: ['crossJoin:*'],
    });
  }
}

export default PluginBlockCrossJoinServer;
