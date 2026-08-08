/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createMockClient } from '@nocobase/client-v2';
import { AI_API_ACL_SNIPPET, AI_API_USER_PERMISSIONS_SNIPPET } from '../../constants';
import { PluginAiApiClient } from '../plugin';

/**
 * Guards the settings registration itself rather than any page's contents.
 *
 * Two regressions are cheap to reintroduce and invisible until a non-admin logs in:
 * omitting `aclSnippet` makes addPageTabItem default to `pm.ai-api.<key>`, a snippet the
 * server never registers, and omitting `sort` silently reorders the tabs alphabetically.
 *
 * The tabs deliberately span two snippets: everything sits under AI_API_ACL_SNIPPET except
 * user permissions, which is gated separately so granting it does not also grant gateway
 * configuration. Each snippet is evaluated independently, so denying one leaves the other's
 * tabs — and therefore the menu — reachable.
 */
describe('AI API v2 settings registration', () => {
  async function loadPlugin() {
    const app = createMockClient();
    await new PluginAiApiClient({}, app).load();
    return app;
  }

  it('registers every page under a snippet the server exposes', async () => {
    const app = await loadPlugin();
    const menu = app.pluginSettingsManager.get('ai-api', false);

    expect(menu?.aclSnippet).toBe(AI_API_ACL_SNIPPET);
    for (const child of menu?.children ?? []) {
      expect(app.pluginSettingsManager.getAclSnippet(child.name), child.name).toBe(
        child.name === 'ai-api.user-permissions' ? AI_API_USER_PERMISSIONS_SNIPPET : AI_API_ACL_SNIPPET,
      );
    }
  });

  it('leaves only the separately-gated tab when the main snippet is denied', async () => {
    const app = await loadPlugin();
    app.pluginSettingsManager.setAclSnippets([`!${AI_API_ACL_SNIPPET}`]);

    // User permissions carries its own snippet, so it survives on its own merit and keeps the
    // menu reachable. That separation is the point: a role can be allowed to hand out model
    // access without also being allowed to reconfigure the gateway.
    expect(app.pluginSettingsManager.get('ai-api')?.children?.map((item) => item.name)).toEqual([
      'ai-api.user-permissions',
    ]);
  });

  it('hides the menu and every tab when both snippets are denied', async () => {
    const app = await loadPlugin();
    app.pluginSettingsManager.setAclSnippets([`!${AI_API_ACL_SNIPPET}`, `!${AI_API_USER_PERMISSIONS_SNIPPET}`]);

    expect(app.pluginSettingsManager.get('ai-api')).toBeNull();
    expect(app.pluginSettingsManager.getList().map((item) => item.name)).not.toContain('ai-api');
  });

  it('hides only the user permissions tab when its own snippet is denied', async () => {
    const app = await loadPlugin();
    app.pluginSettingsManager.setAclSnippets([`!${AI_API_USER_PERMISSIONS_SNIPPET}`]);

    const children = app.pluginSettingsManager.get('ai-api')?.children?.map((item) => item.name) ?? [];
    expect(children).not.toContain('ai-api.user-permissions');
    expect(children).toContain('ai-api.user-quotas');
  });

  it('keeps registration order instead of sorting tabs by name', async () => {
    const app = await loadPlugin();
    app.pluginSettingsManager.setAclSnippets([]);

    expect(app.pluginSettingsManager.get('ai-api')?.children?.map((item) => item.name)).toEqual([
      'ai-api.index',
      'ai-api.model-pricing',
      'ai-api.model-metadata',
      'ai-api.user-permissions',
      'ai-api.user-quotas',
      'ai-api.usage',
    ]);
  });
});
