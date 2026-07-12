import { Application } from '@nocobase/client-v2';
import PluginFileSearchClientV2 from '../plugin';

describe('plugin-file-search client-v2 plugin', () => {
  it('registers settings menu and page without throwing', async () => {
    const app = new Application({ apiClient: { baseURL: 'http://localhost' } });
    const plugin = new PluginFileSearchClientV2({ name: 'plugin-file-search', packageName: 'plugin-file-search' }, app);

    await expect(plugin.load()).resolves.toBeUndefined();
    expect(app.pluginSettingsManager.get('plugin-file-search', false)).toMatchObject({
      name: 'plugin-file-search',
    });
  });
});
