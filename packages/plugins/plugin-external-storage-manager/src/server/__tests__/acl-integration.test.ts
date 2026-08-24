/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { vi } from 'vitest';
import { PluginExternalStorageManagerServer } from '../plugin';

function makePlugin() {
  const snippets = new Map<string, { name: string; actions: string[] }>();
  const allowCalls: Array<{ resource: string; actions: string[]; role: string }> = [];

  const childLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const app: any = {
    name: 'plugin-external-storage-manager',
    context: { reqId: 'acl-test' },
    log: {
      child: vi.fn(() => childLogger),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    resourceManager: {
      registerActionHandler: vi.fn(),
      define: vi.fn(),
    },
    acl: {
      registerSnippet: vi.fn((snippet: { name: string; actions: string[] }) => {
        snippets.set(snippet.name, snippet);
      }),
      allow: vi.fn((resource: string, actions: string[], role: string) => {
        allowCalls.push({ resource, actions, role });
      }),
    },
  };

  const plugin = new PluginExternalStorageManagerServer(app, { name: 'plugin-external-storage-manager' } as any);
  return { app, plugin, snippets, allowCalls };
}

describe('plugin-external-storage-manager ACL registration', () => {
  it('registers browse and directories snippets with intended action coverage', async () => {
    const { plugin, snippets } = makePlugin();
    await plugin.load();

    expect(snippets.has('pm.plugin-external-storage-manager.browse')).toBe(true);
    expect(snippets.has('pm.plugin-external-storage-manager.directories')).toBe(true);

    const browse = snippets.get('pm.plugin-external-storage-manager.browse');
    expect(browse).toBeDefined();
    expect(browse.actions).toEqual(
      expect.arrayContaining([
        'extStorage:directories',
        'extStorage:list',
        'extStorage:stat',
        'extStorage:download',
        'extStorage:exists',
        'extStorage:upload',
        'extStorage:mkdir',
        'extStorage:rename',
        'extStorage:delete',
      ]),
    );
    expect(browse.actions).not.toEqual(
      expect.arrayContaining([
        'extStorage:storageOptions',
        'extStorage:rolePermissions',
        'extStorage:updateRolePermissions',
      ]),
    );

    const directories = snippets.get('pm.plugin-external-storage-manager.directories');
    expect(directories).toBeDefined();
    expect(directories.actions).toEqual(expect.arrayContaining(['externalStorageDirectories:*', 'extStorage:*']));
  });

  it('opens extStorage:download for loggedIn (token-carrying preview/download), nothing else', async () => {
    const { plugin, allowCalls } = makePlugin();
    await plugin.load();

    const extStorageAllows = allowCalls.filter((call) => call.resource === 'extStorage');
    expect(extStorageAllows).toEqual([{ resource: 'extStorage', actions: 'download', role: 'loggedIn' }]);
  });
});
