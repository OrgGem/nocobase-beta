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
import { AI_API_ACL_SNIPPET } from '../../constants';
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
      'ai-api.usage-groups',
      'ai-api.usage',
    ]);
    for (const child of menu?.children ?? []) {
      expect(app.pluginSettingsManager.getAclSnippet(child.name), child.name).toBe(AI_API_ACL_SNIPPET);
    }
  });

  it('hides the whole settings surface when the snippet is denied', async () => {
    const app = await loadPlugin();
    app.pluginSettingsManager.setAclSnippets([`!${AI_API_ACL_SNIPPET}`]);

    expect(app.pluginSettingsManager.getList()).toEqual([]);
  });
});
