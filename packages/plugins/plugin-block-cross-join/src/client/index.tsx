// SPDX-License-Identifier: Apache-2.0

import { Plugin } from '@nocobase/client-v2';
import { CrossJoinBlockModel } from './CrossJoinBlockModel';

export class PluginBlockCrossJoinClient extends Plugin {
  async load() {
    this.flowEngine.registerModels({ CrossJoinBlockModel });
  }
}

export default PluginBlockCrossJoinClient;
