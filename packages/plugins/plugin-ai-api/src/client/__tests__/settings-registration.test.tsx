/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Application } from '@nocobase/client';
import { describe, expect, it } from 'vitest';
import { AI_API_ACL_SNIPPET, AI_API_USER_PERMISSIONS_SNIPPET } from '../../constants';
import { PluginAiApiClient } from '../plugin';

describe('AI API v1 settings registration', () => {
  async function loadPlugin() {
    const app = new Application({});
    await new PluginAiApiClient({}, app).load();
    return app;
  }

  it('registers the same ordered settings tabs and ACL boundaries as v2', async () => {
    const app = await loadPlugin();
    app.pluginSettingsManager.setAclSnippets([]);

    const menu = app.pluginSettingsManager.get('ai-api');

    expect(menu?.children?.map((item) => item.name)).toEqual([
      'ai-api.config',
      'ai-api.model-pricing',
      'ai-api.model-metadata',
      'ai-api.user-permissions',
      'ai-api.user-quotas',
      'ai-api.usage',
    ]);
    expect(app.pluginSettingsManager.getAclSnippet('ai-api.user-permissions')).toBe(AI_API_USER_PERMISSIONS_SNIPPET);
    expect(app.pluginSettingsManager.getRoutePath('ai-api.user-permissions')).toBe(
      '/admin/settings/ai-api/user-permissions',
    );
    expect(app.pluginSettingsManager.getList().map((item) => item.name)).not.toContain('ai-api-user-permissions');
  });

  it('requires access to the legacy parent before exposing the user permissions tab', async () => {
    const app = await loadPlugin();
    app.pluginSettingsManager.setAclSnippets([`!${AI_API_ACL_SNIPPET}`]);

    expect(app.pluginSettingsManager.getList()).toEqual([]);
  });

  it('hides only the user permissions tab when its own snippet is denied', async () => {
    const app = await loadPlugin();
    app.pluginSettingsManager.setAclSnippets([`!${AI_API_USER_PERMISSIONS_SNIPPET}`]);

    expect(app.pluginSettingsManager.get('ai-api')?.children?.map((item) => item.name)).toEqual([
      'ai-api.config',
      'ai-api.model-pricing',
      'ai-api.model-metadata',
      'ai-api.user-quotas',
      'ai-api.usage',
    ]);
  });

  it('hides both settings surfaces when both snippets are denied', async () => {
    const app = await loadPlugin();
    app.pluginSettingsManager.setAclSnippets([`!${AI_API_ACL_SNIPPET}`, `!${AI_API_USER_PERMISSIONS_SNIPPET}`]);

    expect(app.pluginSettingsManager.getList()).toEqual([]);
  });
});
