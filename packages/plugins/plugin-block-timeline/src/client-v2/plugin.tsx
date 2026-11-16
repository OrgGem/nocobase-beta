// SPDX-License-Identifier: Apache-2.0

import { Plugin } from '@nocobase/client-v2';

export class PluginBlockTimelineClientV2 extends Plugin {
  async load() {
    this.flowEngine.registerModelLoaders({
      TimelineBlockModel: {
        loader: () => import('./models/TimelineBlockModel'),
      },
    });
  }
}

export default PluginBlockTimelineClientV2;
