import { Application } from '@nocobase/client';

import PluginMicrosoftGraphGatewayClient from '../plugin';

describe('PluginMicrosoftGraphGatewayClient', () => {
  it('registers the legacy admin settings menu and all tabs', async () => {
    const app = new Application({
      plugins: [
        [
          PluginMicrosoftGraphGatewayClient,
          { name: 'microsoft-graph-gateway', packageName: 'plugin-microsoft-graph-gateway' },
        ],
      ],
    });

    await app.load();

    expect(app.pluginSettingsManager.get('microsoft-graph-gateway')).toMatchObject({
      title: 'Microsoft Graph Gateway',
      aclSnippet: 'pm.microsoft-graph-gateway',
      path: '/admin/settings/microsoft-graph-gateway',
    });
    for (const key of ['index', 'api-keys', 'operations', 'api-docs']) {
      expect(app.pluginSettingsManager.get(`microsoft-graph-gateway.${key}`)).toMatchObject({
        aclSnippet: 'pm.microsoft-graph-gateway',
        Component: expect.any(Object),
      });
    }
  });
});
