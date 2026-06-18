import { Plugin, Application } from '@nocobase/client-v2';

export class PluginBlockCrossJoinClient extends Plugin<Record<string, never>, Application> {
  async load() {}
}

export default PluginBlockCrossJoinClient;
