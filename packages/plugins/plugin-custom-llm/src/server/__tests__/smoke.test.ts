/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { createMockServer } from '@nocobase/test';

describe('plugin-custom-llm smoke', () => {
  let app: any;

  afterEach(async () => {
    await app?.destroy();
  });

  it('should load the plugin', async () => {
    app = await createMockServer({
      plugins: ['nocobase'],
    });
    await app.pm.enable('plugin-custom-llm');
    const plugin = app.pm.get('plugin-custom-llm');
    expect(plugin).toBeTruthy();
    expect(plugin.enabled).toBeTruthy();
  });
});
