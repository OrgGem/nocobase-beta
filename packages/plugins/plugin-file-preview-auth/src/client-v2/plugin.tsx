import { Application, Plugin } from '@nocobase/client-v2';
import { registerAuthenticatedFilePreviewTypes } from './authenticatedPreviewTypes';

export class PluginFilePreviewAuthClient extends Plugin<Record<string, never>, Application> {
  async load() {
    registerAuthenticatedFilePreviewTypes(this.app);
  }
}

export default PluginFilePreviewAuthClient;
