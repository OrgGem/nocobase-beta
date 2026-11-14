// SPDX-License-Identifier: Apache-2.0

import { createMockServer, type MockServer } from '@nocobase/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Plugin from '../plugin';

describe('Embed settings allowlist resource ACL over HTTP', () => {
  let app: MockServer;
  let viewer: ReturnType<MockServer['agent']>;
  let manager: ReturnType<MockServer['agent']>;

  beforeAll(async () => {
    app = await createMockServer({
      acl: true,
      resourcer: { prefix: '/api' },
      database: { dialect: 'sqlite', storage: ':memory:' },
      plugins: [
        'field-sort',
        'system-settings',
        'users',
        'auth',
        'acl',
        'data-source-manager',
        'data-source-main',
        'error-handler',
        [Plugin, { name: 'plugin-block-embed-settings' }],
      ],
    });

    await app.db.getRepository('roles').create({ values: { name: 'embed-viewer', title: 'Viewer' } });
    await app.db.getRepository('roles').create({ values: { name: 'embed-manager', title: 'Manager' } });
    const viewerUser = await app.db
      .getRepository('users')
      .create({ values: { username: 'embed-viewer', roles: ['embed-viewer'] } });
    const managerUser = await app.db
      .getRepository('users')
      .create({ values: { username: 'embed-manager', roles: ['embed-manager'] } });

    app.acl.define({ role: 'embed-viewer' });
    app.acl.define({ role: 'embed-manager' }).snippets.add('pm.plugin-block-embed-settings');
    viewer = await app.agent().login(viewerUser, 'embed-viewer');
    manager = await app.agent().login(managerUser, 'embed-manager');

    const repository = app.db.getRepository('embedAllowedPlugins');
    await repository.create({ values: { pluginName: 'plugin-one', title: 'Plugin One', enabled: true } });
    await repository.create({ values: { pluginName: 'plugin-two', title: 'Plugin Two', enabled: false } });
  }, 120000);

  afterAll(async () => {
    await app?.destroy();
  });

  it('returns the enabled plugin catalog to a logged-in viewer without allowing list filters or fields to broaden it', async () => {
    const response = await viewer
      .get('/api/embedSettings:enabled')
      .query({ filter: { enabled: false }, fields: ['id', 'pluginName', 'title', 'enabled'] });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([{ pluginName: 'plugin-one', title: 'Plugin One' }]);
  });

  it('does not allow viewers to list or change the administrative allowlist', async () => {
    const deniedList = await viewer.resource('embedAllowedPlugins').list();
    const deniedCreate = await viewer.resource('embedAllowedPlugins').create({
      values: { pluginName: 'viewer-plugin', title: 'Viewer Plugin', enabled: true },
    });

    expect(deniedList.status).toBe(403);
    expect(deniedCreate.status).toBe(403);
  });

  it('keeps allowlist CRUD available to a role with the plugin management snippet', async () => {
    const list = await manager.resource('embedAllowedPlugins').list();
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(2);

    const created = await manager.resource('embedAllowedPlugins').create({
      values: { pluginName: 'managed-plugin', title: 'Managed Plugin', enabled: true },
    });
    expect(created.status).toBe(200);
    expect(created.body.data).toMatchObject({ pluginName: 'managed-plugin', title: 'Managed Plugin' });
  });

  it('does not expose the enabled catalog to anonymous requests', async () => {
    const response = await app.agent().get('/api/embedSettings:enabled');
    expect([401, 403]).toContain(response.status);
  });
});
