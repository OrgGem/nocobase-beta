import { Application } from '@nocobase/client';

import PluginAppObservabilityClient from '../index';

const MENU_KEY = 'plugin-app-observability';
const ACL_SNIPPET = 'pm.plugin-app-observability';
const PAGES = [
  ['index', 'Overview'],
  ['nodes', 'Nodes'],
  ['services', 'Services'],
  ['capacity', 'Capacity'],
  ['settings', 'Settings'],
] as const;

describe('PluginAppObservabilityClient', () => {
  it('registers the legacy menu and every observability page with the shared ACL gate', async () => {
    const app = new Application({
      plugins: [[PluginAppObservabilityClient, { name: MENU_KEY, packageName: 'plugin-app-observability' }]],
    });

    await app.load();

    const menu = app.pluginSettingsManager.get(MENU_KEY);
    expect(menu).toMatchObject({
      key: MENU_KEY,
      title: 'App observability',
      aclSnippet: ACL_SNIPPET,
      path: `/admin/settings/${MENU_KEY}`,
    });
    expect(menu.icon).toBeTruthy();
    for (const [key, title] of PAGES) {
      expect(app.pluginSettingsManager.get(`${MENU_KEY}.${key}`)).toMatchObject({
        key: `${MENU_KEY}.${key}`,
        title,
        aclSnippet: ACL_SNIPPET,
        Component: expect.anything(),
      });
    }
  });
});
