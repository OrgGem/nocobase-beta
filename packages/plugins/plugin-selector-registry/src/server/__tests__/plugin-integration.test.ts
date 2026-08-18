import { createMockServer, type MockServer } from '@nocobase/test';

import PluginSelectorRegistryServer from '../plugin';

const PAGE = `
<html><body>
  <form id="login-form">
    <input name="username" />
    <button id="btn-submit-9999" data-testid="submit" aria-label="Submit">Submit</button>
  </form>
</body></html>
`;

describe('Selector Registry plugin integration', () => {
  let app: MockServer | undefined;
  let botAgent: ReturnType<MockServer['agent']> | undefined;

  beforeAll(async () => {
    app = await createMockServer({
      acl: true,
      registerActions: true,
      plugins: [
        'field-sort',
        'system-settings',
        'users',
        'auth',
        'acl',
        'data-source-manager',
        'data-source-main',
        'error-handler',
        [PluginSelectorRegistryServer, { name: 'selector-registry' }],
      ],
    });
    await app.db.getRepository('roles').create({
      values: {
        name: 'bot-client',
        title: 'Bot client',
        snippets: ['pm.selector-registry.client'],
      },
    });
    const botUser = await app.db.getRepository('users').create({
      values: {
        nickname: 'UiPath bot',
        username: 'bot-client',
        roles: ['bot-client'],
      },
    });
    botAgent = await app.agent().login(botUser, 'bot-client');
  }, 180000);

  afterAll(async () => {
    await app?.destroy();
  });

  const requireApp = (): MockServer => {
    if (!app) {
      throw new Error('Selector Registry MockServer was not initialized.');
    }
    return app;
  };

  const requireBot = (): ReturnType<MockServer['agent']> => {
    if (!botAgent) {
      throw new Error('Bot agent was not initialized.');
    }
    return botAgent;
  };

  const rootAgent = async () => {
    const server = requireApp();
    const rootUser = await server.db.getRepository('users').findOne();
    if (!rootUser) {
      throw new Error('Root user was not found.');
    }
    return server.agent().login(rootUser);
  };

  it('loads all registry collections', () => {
    const server = requireApp();
    for (const collectionName of [
      'selectorApps',
      'selectorEntries',
      'selectorVersions',
      'selectorResolveLogs',
      'selectorFeedbacks',
      'selectorSettings',
    ]) {
      expect(server.db.getCollection(collectionName)).toBeTruthy();
    }
  });

  it('rejects anonymous resolve calls', async () => {
    const response = await requireApp()
      .agent()
      .post('/selectorRegistry:resolve')
      .send({ app: 'crm', elementKey: 'k1' });
    expect([401, 403]).toContain(response.status);
  });

  it('runs the full self-healing loop over HTTP', async () => {
    const server = requireApp();
    const admin = await rootAgent();
    const bot = requireBot();

    const created = await admin.resource('selectorApps').create({
      values: { name: 'crm', displayName: 'CRM portal' },
    });
    expect(created.status).toBe(200);

    // 1. Bootstrap: first sight of the element registers a probation entry.
    const bootstrap = await bot
      .post('/selectorRegistry:resolve')
      .send({ app: 'crm', elementKey: 'k1', selector: '#btn-submit-1234', agentId: 'uipath-bot-1' });
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.body.data).toMatchObject({
      source: 'registry',
      selector: '#btn-submit-1234',
      status: 'probation',
      version: 1,
    });

    // 2. Exact cache hit for an unchanged selector.
    const hit = await bot
      .post('/selectorRegistry:resolve')
      .send({ app: 'crm', elementKey: 'k1', selector: '#btn-submit-1234' });
    expect(hit.body.data.source).toBe('cache_hit');

    // 3. Drifted id reported with a DOM snapshot -> heuristic heal.
    const healed = await bot.post('/selectorRegistry:resolve').send({
      app: 'crm',
      elementKey: 'k1',
      selector: '#btn-submit-1234',
      failureType: 'not_found',
      domSnippet: PAGE,
    });
    expect(healed.status).toBe(200);
    expect(healed.body.data).toMatchObject({
      source: 'heuristic',
      selector: '[id^="btn-submit"]',
      healTriggered: true,
      version: 2,
    });
    expect(healed.body.data.fallbacks).toEqual([{ selector: '#btn-submit-1234', selectorType: 'css' }]);

    // 4. Three reported successes promote the healed selector to active.
    for (let index = 0; index < 3; index += 1) {
      const feedback = await bot.post('/selectorRegistry:report').send({
        app: 'crm',
        elementKey: 'k1',
        outcome: 'success',
        selectorUsed: '[id^="btn-submit"]',
        agentId: 'uipath-bot-1',
      });
      expect(feedback.status).toBe(200);
    }
    const entry = await server.db.getRepository('selectorEntries').findOne({ filter: { elementKey: 'k1' } });
    expect(entry?.get('status')).toBe('active');
    expect(entry?.get('currentSelector')).toBe('[id^="btn-submit"]');

    // 5. Delta sync: known version stays unchanged, unknown keys are reported.
    const bulk = await bot.post('/selectorRegistry:bulkLookup').send({
      app: 'crm',
      items: [{ elementKey: 'k1', version: 2 }, { elementKey: 'never-seen' }],
    });
    expect(bulk.status).toBe(200);
    expect(bulk.body.data).toMatchObject({ app: 'crm', unchanged: 1, unknown: ['never-seen'], updates: [] });
  });

  it('returns structured errors for unknown apps', async () => {
    const response = await requireBot()
      .post('/selectorRegistry:resolve')
      .send({ app: 'missing-app', elementKey: 'k1' });
    expect(response.status).toBe(404);
    expect(response.body.errors[0].code).toBe('APP_NOT_FOUND');
  });

  it('keeps admin resources away from the client role', async () => {
    const bot = requireBot();

    const settings = await bot.post('/selectorRegistryAdmin:getSettings');
    expect([401, 403]).toContain(settings.status);

    const createApp = await bot.resource('selectorApps').create({ values: { name: 'rogue' } });
    expect([401, 403]).toContain(createApp.status);
  });

  it('serves settings, stats and preview revalidation for root', async () => {
    const server = requireApp();
    const admin = await rootAgent();

    const settings = await admin.post('/selectorRegistryAdmin:getSettings');
    expect(settings.status).toBe(200);
    expect(settings.body.data.enabled).toBe(true);

    const updated = await admin.post('/selectorRegistryAdmin:updateSettings').send({ confidenceThreshold: 0.7 });
    expect(updated.status).toBe(200);
    expect(updated.body.data.confidenceThreshold).toBe(0.7);

    const stats = await admin.post('/selectorRegistryAdmin:stats');
    expect(stats.status).toBe(200);
    expect(stats.body.data.entries.total).toBeGreaterThanOrEqual(1);
    expect(stats.body.data.recentResolves.byPath.cache_hit).toBeGreaterThanOrEqual(1);

    // Revalidate previews a heal in dry-run and must not mutate the entry.
    const entry = await server.db.getRepository('selectorEntries').findOne({ filter: { elementKey: 'k1' } });
    const entryId = entry?.get('id') as number;
    const revalidation = await admin.post('/selectorRegistryAdmin:revalidate').send({ entryId, domSnippet: PAGE });
    expect(revalidation.status).toBe(200);
    expect(revalidation.body.data.healTriggered).toBe(true);

    const after = await server.db.getRepository('selectorEntries').findOne({ filterByTk: entryId });
    expect(after?.get('currentSelector')).toBe('[id^="btn-submit"]');
    expect(after?.get('status')).toBe('active');
    expect(after?.get('version')).toBe(2);
  });

  it('rolls back a version manually from the admin resource', async () => {
    const server = requireApp();
    const admin = await rootAgent();

    const entry = await server.db.getRepository('selectorEntries').findOne({ filter: { elementKey: 'k1' } });
    const entryId = entry?.get('id') as number;
    const firstVersion = await server.db
      .getRepository('selectorVersions')
      .findOne({ filter: { entryId, selector: '#btn-submit-1234' } });
    expect(firstVersion).toBeTruthy();

    const response = await admin.post('/selectorRegistryAdmin:rollbackVersion').send({
      entryId,
      versionId: firstVersion?.get('id'),
    });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ selector: '#btn-submit-1234', status: 'active', version: 3 });

    const after = await server.db.getRepository('selectorEntries').findOne({ filterByTk: entryId });
    expect(after?.get('currentSelector')).toBe('#btn-submit-1234');
    expect(after?.get('resolvedBy')).toBe('manual');
  });
});
