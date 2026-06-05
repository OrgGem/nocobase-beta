import { createMockServer, MockServer } from '@nocobase/test';

describe('plugin-carbone-template-manager smoke', () => {
  let app: MockServer;

  beforeEach(async () => {
    app = await createMockServer({
      plugins: ['error-handler', 'plugin-carbone-template-manager'],
      acl: false,
    });
  });

  afterEach(async () => {
    await app?.destroy();
  });

  it('loads the plugin and registers resources', async () => {
    const plugin = app.pm.get('plugin-carbone-template-manager');
    expect(plugin).toBeTruthy();

    const agent = app.agent();
    const getRes = await agent.resource('carboneSettings').get();
    expect(getRes.status).toBe(200);
  });
});
