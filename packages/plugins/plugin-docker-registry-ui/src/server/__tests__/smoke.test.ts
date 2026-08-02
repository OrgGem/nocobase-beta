import { createMockServer, type MockServer } from '@nocobase/test';
import type { PluginDockerRegistryUiServer } from '../plugin';

describe('Docker Registry UI plugin smoke', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  it('loads the plugin, collection and resource without creating a desktop route', async () => {
    app = await createMockServer({
      plugins: ['nocobase', 'docker-registry-ui'],
    });

    const plugin = app.pm.get('docker-registry-ui') as PluginDockerRegistryUiServer | undefined;
    expect(plugin).toBeTruthy();
    expect(app.db.getCollection('dockerRegistrySettings')).toBeTruthy();
    expect(app.resourceManager.getResource('dockerRegistry')).toBeTruthy();

    const route = await app.db.getRepository('desktopRoutes').findOne({
      filter: { schemaUid: 'docker-registry-ui-main-menu' },
    });
    expect(route).toBeNull();

    const rootUser = await app.db.getRepository('users').findOne();
    expect(rootUser).toBeTruthy();
    const rootAgent = await app.agent().login(rootUser);
    const updateResponse = await rootAgent.post('/dockerRegistry:updateSettings').send({
      values: {
        displayName: 'Test Registry',
        registryUrl: 'http://docker-registry:5000',
        publicRegistryHost: 'localhost:15000',
        allowInsecureHttp: true,
      },
    });
    expect(updateResponse.status).toBe(200);
    expect(updateResponse.body.data).toMatchObject({
      displayName: 'Test Registry',
      registryUrl: 'http://docker-registry:5000',
      publicRegistryHost: 'localhost:15000',
      allowInsecureHttp: true,
    });
  });
});
