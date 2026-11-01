import { Plugin, Application } from '@nocobase/client-v2';
import { CrossJoinBlockModel } from './CrossJoinBlockModel';

export class PluginBlockCrossJoinClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.flowEngine.registerModels({ CrossJoinBlockModel });
  }
}

export default PluginBlockCrossJoinClient;
