import { Application, Plugin } from '@nocobase/client-v2';
import { installAiChatFilePreviewEffect } from './chatFilePreviewEffect';

export class PluginAiChatFilePreviewClient extends Plugin<Record<string, never>, Application> {
  async load() {
    installAiChatFilePreviewEffect(this.app);
  }
}

export default PluginAiChatFilePreviewClient;
