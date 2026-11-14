/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { vi } from 'vitest';
import { ACL } from '@nocobase/acl';
import type { Context } from '@nocobase/actions';
import { guardDirectoryManagement, PluginExternalStorageManagerServer } from '../plugin';

function makePlugin() {
  const snippets = new Map<string, { name: string; actions: string[] }>();
  const allowCalls: Array<{ resource: string; actions: string[]; role: string }> = [];
  const acl = new ACL();
  const registerAclSnippet = acl.registerSnippet.bind(acl);
  const allowAcl = acl.allow.bind(acl);
  const resourceMiddlewares: Array<{ middleware: unknown; options: Record<string, unknown> }> = [];

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
      use: vi.fn((middleware: unknown, options: Record<string, unknown>) => {
        resourceMiddlewares.push({ middleware, options });
      }),
    },
    acl: Object.assign(acl, {
      registerSnippet: vi.fn((snippet: { name: string; actions: string[] }) => {
        snippets.set(snippet.name, snippet);
        registerAclSnippet(snippet);
      }),
      allow: vi.fn((resource: string, actions: string[], role: string) => {
        allowCalls.push({ resource, actions, role });
        allowAcl(resource, actions, role);
      }),
    }),
  };

  const plugin = new PluginExternalStorageManagerServer(app, { name: 'plugin-external-storage-manager' } as any);
  return { app, plugin, snippets, allowCalls, resourceMiddlewares };
}

function guardContext(acl: ACL, role: string, resourceName: string, actionName: string) {
  return {
    action: { resourceName, actionName, params: {} },
    state: { currentRoles: [role], currentRole: role },
    t: (key: string) => key,
    can: (options: { resource: string; action: string }) => acl.can({ roles: [role], ...options }),
    throw(status: number, message: string) {
      const error = new Error(message) as Error & { status: number };
      error.status = status;
      throw error;
    },
  } as unknown as Context;
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

  it('registers a directory-management guard after ACL middleware', async () => {
    const { plugin, app } = makePlugin();
    await plugin.load();

    expect(app.resourceManager.use).toHaveBeenCalledWith(guardDirectoryManagement, {
      tag: 'external-storage-directory-management',
      after: 'acl',
    });
  });

  it('does not let file update/delete grants authorize directory mapping CRUD or association writes', async () => {
    const { plugin, app } = makePlugin();
    await plugin.load();
    app.acl.define({
      role: 'file-manager',
      actions: {
        'externalStorageDirectories:view': {},
        'externalStorageDirectories:update': {},
        'externalStorageDirectories:destroy': {},
        'extStorage:upload': {},
        'extStorage:delete': {},
      },
    });
    const next = vi.fn().mockResolvedValue(undefined);

    await expect(
      guardDirectoryManagement(guardContext(app.acl, 'file-manager', 'externalStorageDirectories', 'update'), next),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      guardDirectoryManagement(guardContext(app.acl, 'file-manager', 'externalStorageDirectories', 'destroy'), next),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      guardDirectoryManagement(
        guardContext(app.acl, 'file-manager', 'externalStorageDirectories.tags', 'create'),
        next,
      ),
    ).rejects.toMatchObject({ status: 403 });

    await guardDirectoryManagement(guardContext(app.acl, 'file-manager', 'externalStorageDirectories', 'list'), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('allows mapping CRUD only for the plugin directories snippet', async () => {
    const { plugin, app } = makePlugin();
    await plugin.load();
    const manager = app.acl.define({ role: 'directory-manager' });
    manager.snippets.add('pm.plugin-external-storage-manager.directories');
    const next = vi.fn().mockResolvedValue(undefined);

    await guardDirectoryManagement(
      guardContext(app.acl, 'directory-manager', 'externalStorageDirectories', 'update'),
      next,
    );
    await guardDirectoryManagement(
      guardContext(app.acl, 'directory-manager', 'externalStorageDirectories.files', 'create'),
      next,
    );

    expect(next).toHaveBeenCalledTimes(2);
  });
});
