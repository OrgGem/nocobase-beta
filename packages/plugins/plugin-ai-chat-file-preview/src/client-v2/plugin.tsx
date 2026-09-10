import { Application, Plugin } from '@nocobase/client-v2';
import { installAiChatFilePreviewEffect } from './chatFilePreviewEffect';

export class PluginAiChatFilePreviewClient extends Plugin<Record<string, never>, Application> {
  async load() {
    // Only install the preview effect when plugin-ai is available; without it the runtime lookups
    // never resolve and the listeners/intervals would run for nothing.
    const aiPlugin = this.app.pm.get('@nocobase/plugin-ai') || this.app.pm.get('ai');
    if (!aiPlugin) {
      console.warn('[plugin-ai-chat-file-preview] plugin-ai not available, skipping v2 effect');
      return;
    }
    installAiChatFilePreviewEffect(this.app);
  }
}

export default PluginAiChatFilePreviewClient;
