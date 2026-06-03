import { createMockServer } from '@nocobase/test';
import PluginAIChatFilePreviewServer from '../plugin';

describe('AI Chat File Preview plugin smoke', () => {
  let app;

  afterEach(async () => {
    await app?.destroy();
  });

  it('loads without starting the full app', async () => {
    app = await createMockServer({
      plugins: ['nocobase', PluginAIChatFilePreviewServer],
    });

    expect(app).toBeTruthy();
  });
});
