import { createMockServer } from '@nocobase/test';
import PluginDocumentUnderstandingServer from '../plugin';

describe('Document Understanding plugin smoke', () => {
  let app;
  let agent;

  beforeEach(async () => {
    app = await createMockServer({
      plugins: ['nocobase', PluginDocumentUnderstandingServer],
      acl: false,
    });
    await app.install();

    const adminUser = await app.db.getRepository('users').findOne();
    agent = app.agent();
    if (adminUser) {
      await agent.login(adminUser);
    }
  });

  afterEach(async () => {
    await app?.destroy();
  });

  it('registers collections', async () => {
    for (const name of [
      'doc_understanding_config',
      'doc_understanding_endpoints',
      'doc_understanding_pipelines',
      'doc_understanding_pipeline_steps',
      'doc_understanding_jobs',
    ]) {
      expect(app.db.getCollection(name)).toBeTruthy();
    }
  });

  it('returns and updates default config through actions', async () => {
    const getRes = await agent.resource('docUnderstanding').getConfig();
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.baseUrl).toBe('http://localhost:8000');
    expect(getRes.body.data.authType).toBe('none');

    const updateRes = await agent.resource('docUnderstanding').updateConfig({
      values: {
        baseUrl: 'https://processor.example.com',
        authType: 'bearer',
        authKey: 'test-token',
      },
    });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.data.baseUrl).toBe('https://processor.example.com');
    expect(updateRes.body.data.authType).toBe('bearer');
  });
});
