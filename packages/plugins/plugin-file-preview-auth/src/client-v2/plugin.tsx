import { Application, Plugin } from '@nocobase/client-v2';
import { registerAuthenticatedFilePreviewTypes } from './authenticatedPreviewTypes';
import { registerFilePreviewAIWorkContext } from './AIFilePreviewAction';

export class PluginFilePreviewAuthClient extends Plugin<Record<string, never>, Application> {
  async load() {
    registerFilePreviewAIWorkContext(this.app);
    registerAuthenticatedFilePreviewTypes(this.app);
  }
}

export default PluginFilePreviewAuthClient;
