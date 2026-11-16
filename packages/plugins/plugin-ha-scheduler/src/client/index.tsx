// SPDX-License-Identifier: Apache-2.0

import { Plugin } from '@nocobase/client';

// Server-only plugin — no client-side functionality needed.
// Empty plugin class exported to satisfy PluginManager's constructor check.
export class PluginHaSchedulerClient extends Plugin {
  async load() {}
}

export default PluginHaSchedulerClient;
