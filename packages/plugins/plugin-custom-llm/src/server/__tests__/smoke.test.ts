// SPDX-License-Identifier: Apache-2.0

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
