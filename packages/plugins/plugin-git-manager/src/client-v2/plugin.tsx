import { Plugin, Application } from '@nocobase/client-v2';

export class PluginGitManagerClient extends Plugin<Record<string, never>, Application> {
  async load() {
    // TODO: migrate v1 client UI to client-v2
  }
}

export default PluginGitManagerClient;
