import { Plugin, Application } from '@nocobase/client-v2';

export class PluginS3PrivateStorageClient extends Plugin<Record<string, never>, Application> {
  async load() {}
}

export default PluginS3PrivateStorageClient;
