/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createMockClient } from '@nocobase/client-v2';
import { describe, expect, it } from 'vitest';
import { collectEmbeddablePluginTabs } from '../EmbedSettingsPluginSelect';
import Plugin from '../plugin';

describe('Embed settings with native V2 registry', () => {
  it('excludes hidden/dynamic and denied tabs using the native settings snapshot', () => {
    const app = createMockClient();
    const manager = app.pluginSettingsManager;
    manager.addMenuItem({ key: 'demo', title: 'Demo' });
    manager.addPageTabItem({
      menuKey: 'demo',
      key: 'index',
      title: 'Index',
      componentLoader: async () => ({ default: () => null }),
    });
    manager.addPageTabItem({
      menuKey: 'demo',
      key: ':name',
      title: false,
      hidden: true,
      componentLoader: async () => ({ default: () => null }),
    });
    manager.setAclSnippets(['!pm.demo.:name']);
    expect(collectEmbeddablePluginTabs(app, 'demo').map((tab) => tab.value)).toEqual(['demo.index']);
    manager.setAclSnippets(['!pm.demo.index']);
    expect(collectEmbeddablePluginTabs(app, 'demo')).toEqual([]);
  });
  it('uses the server plugin name for both settings ACL entries', async () => {
    const app = createMockClient();
    await new Plugin({}, app).load();
    const menu = app.pluginSettingsManager.get('block-embed-settings');
    expect(menu.aclSnippet).toBe('pm.block-embed-settings');
    expect(menu.children[0].aclSnippet).toBe('pm.block-embed-settings');
  });
});
