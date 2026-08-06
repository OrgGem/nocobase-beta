/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createMockClient } from '@nocobase/client-v2';
import { AI_API_ACL_SNIPPET } from '../../constants';
import { PluginAiApiClient } from '../plugin';

/**
 * Guards the settings registration itself rather than any page's contents.
 *
 * Two regressions are cheap to reintroduce and invisible until a non-admin logs in:
 * omitting `aclSnippet` makes addPageTabItem default to `pm.ai-api.<key>`, a snippet the
 * server never registers, and omitting `sort` silently reorders the tabs alphabetically.
 */
describe('AI API v2 settings registration', () => {
  async function loadPlugin() {
    const app = createMockClient();
    await new PluginAiApiClient({}, app).load();
    return app;
  }

  it('registers every page under the one snippet the server exposes', async () => {
    const app = await loadPlugin();
    const menu = app.pluginSettingsManager.get('ai-api', false);

    expect(menu?.aclSnippet).toBe(AI_API_ACL_SNIPPET);
    for (const child of menu?.children ?? []) {
      expect(app.pluginSettingsManager.getAclSnippet(child.name), child.name).toBe(AI_API_ACL_SNIPPET);
    }
  });

  it('hides the menu and every tab when the role denies that snippet', async () => {
    const app = await loadPlugin();
    app.pluginSettingsManager.setAclSnippets([`!${AI_API_ACL_SNIPPET}`]);

    expect(app.pluginSettingsManager.get('ai-api')).toBeNull();
    expect(app.pluginSettingsManager.getList().map((item) => item.name)).not.toContain('ai-api');
  });

  it('keeps registration order instead of sorting tabs by name', async () => {
    const app = await loadPlugin();
    app.pluginSettingsManager.setAclSnippets([]);

    expect(app.pluginSettingsManager.get('ai-api')?.children?.map((item) => item.name)).toEqual([
      'ai-api.index',
      'ai-api.model-pricing',
      'ai-api.model-metadata',
      'ai-api.user-quotas',
      'ai-api.usage',
    ]);
  });
});
