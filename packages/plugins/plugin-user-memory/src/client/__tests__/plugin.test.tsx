import { Application } from '@nocobase/client';
import { createMockClient } from '@nocobase/client-v2';

import PluginUserMemoryClient from '../index';
import PluginUserMemoryClientV2 from '../../client-v2/plugin';

describe('PluginUserMemoryClient', () => {
  it('registers the legacy admin settings page', async () => {
    const app = new Application({
      plugins: [[PluginUserMemoryClient, { name: 'user-memory', packageName: 'plugin-user-memory' }]],
    });

    await app.load();

    expect(app.pluginSettingsManager.get('plugin-user-memory')).toMatchObject({
      key: 'plugin-user-memory',
      title: 'User Memory',
      aclSnippet: 'pm.user-memory.admin',
      path: '/admin/settings/plugin-user-memory',
    });
  });

  it('registers the modern admin settings page with the same ACL snippet', async () => {
    const app = createMockClient({
      plugins: [[PluginUserMemoryClientV2, { name: 'user-memory', packageName: 'plugin-user-memory' }]],
    });

    await app.load();

    expect(app.pluginSettingsManager.get('plugin-user-memory')).toMatchObject({
      key: 'plugin-user-memory',
      title: 'User Memory',
      aclSnippet: 'pm.user-memory.admin',
    });
    expect(app.pluginSettingsManager.get('plugin-user-memory.index')).toMatchObject({
      menuKey: 'plugin-user-memory',
      pageKey: 'index',
      title: 'User Memory',
      aclSnippet: 'pm.user-memory.admin',
      componentLoader: expect.any(Function),
    });
  });
});
