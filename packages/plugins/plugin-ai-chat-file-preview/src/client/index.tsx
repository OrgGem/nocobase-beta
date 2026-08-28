/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin } from '@nocobase/client';

export class PluginAIChatFilePreviewClient extends Plugin {
  async load() {
    // Only register ChatFilePreviewProvider if plugin-ai is available.
    // Without it, the provider's hooks crash and block the entire app render.
    try {
      const aiPlugin = this.app.pm.get('@nocobase/plugin-ai') || this.app.pm.get('ai');
      if (!aiPlugin) {
        console.warn('[plugin-ai-chat-file-preview] plugin-ai not available, skipping provider registration');
        return;
      }
      const { ChatFilePreviewProvider } = await import('./ChatFilePreviewProvider');
      this.app.use(ChatFilePreviewProvider);
    } catch (e) {
      console.warn('[plugin-ai-chat-file-preview] Failed to load provider:', e?.message);
    }
  }
}

export default PluginAIChatFilePreviewClient;
