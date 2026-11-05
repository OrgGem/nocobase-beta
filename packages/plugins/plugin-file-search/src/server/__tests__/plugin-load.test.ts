/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { PluginFileSearchServer } from '../plugin';
import { ResourceManager } from '@nocobase/resourcer';

function createMockApp() {
  const resourceManager = new ResourceManager();
  vi.spyOn(resourceManager, 'registerActionHandlers');
  return {
    resourceManager,
    acl: {
      registerSnippet: vi.fn(),
      allow: vi.fn(),
    },
    aiManager: {
      toolsManager: {
        registerTools: vi.fn(),
      },
    },
    on: vi.fn(),
    log: {
      warn: vi.fn(),
    },
  };
}

describe('plugin-file-search server plugin load', () => {
  it('loads server registrations without throwing', async () => {
    const app = createMockApp();
    const plugin = new PluginFileSearchServer(app as never, {
      name: 'plugin-file-search',
      packageName: 'plugin-file-search',
      enabled: true,
    });

    await expect(plugin.load()).resolves.toBeUndefined();
    expect(app.resourceManager.registerActionHandlers).toHaveBeenCalled();
    expect(app.resourceManager.getAction('fileSearch', 'search')).toBeTruthy();
    expect(app.resourceManager.getAction('fileSearch', 'overview')).toBeTruthy();
    expect(app.acl.registerSnippet).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'pm.plugin-file-search.manage' }),
    );
  });
});
