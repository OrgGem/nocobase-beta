import { Plugin } from '@nocobase/client-v2';

// This server-only plugin still needs a constructor for the V2 plugin manager.
export class PluginHaSchedulerClient extends Plugin {
  async load() {}
}

export default PluginHaSchedulerClient;
