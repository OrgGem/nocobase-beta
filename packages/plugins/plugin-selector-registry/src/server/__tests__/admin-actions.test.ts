import { createAdminActions } from '../actions/admin-actions';
import { SelectorSettingsService } from '../services/settings-service';
import { FakeDatabase } from './helpers/fake-database';

const setup = () => {
  const database = new FakeDatabase();
  const settings = new SelectorSettingsService(() => database.repo('selectorSettings'));
  return { database, settings };
};

const seedApp = async (database: FakeDatabase) => {
  return database.repo('selectorApps').create({
    values: { name: 'crm', status: 'active', dryRun: false },
  });
};

const seedEntry = async (database: FakeDatabase, values?: Record<string, unknown>) => {
  return database.repo('selectorEntries').create({
    values: {
      appId: 1,
      elementKey: 'k1',
      currentSelector: '#login',
      selectorType: 'css',
      fallbackSelectors: [],
      signature: null,
      status: 'active',
      pinned: false,
      confidence: 0.5,
      hitCount: 0,
      successCount: 5,
      failCount: 0,
      failStreak: 0,
      probationSuccessCount: 3,
      version: 2,
      resolvedBy: 'client',
      ...values,
    },
  });
};

describe('admin-actions', () => {
  describe('stats', () => {
    it('returns aggregated counts without loading all entries', async () => {
      const { database, settings } = setup();
      await seedApp(database);
      await seedEntry(database, { status: 'active', failCount: 10 });
      await seedEntry(database, { elementKey: 'k2', status: 'probation', failCount: 3 });
      await seedEntry(database, { elementKey: 'k3', status: 'quarantined', failCount: 7 });
      await database.repo('selectorResolveLogs').create({ values: { appId: 1, elementKey: 'k1', path: 'cache_hit' } });
      await database.repo('selectorResolveLogs').create({ values: { appId: 1, elementKey: 'k2', path: 'heuristic' } });

      const actions = createAdminActions({
        database,
        pipeline: null as never,
        feedback: null as never,
        settings,
        pruneLogs: async () => ({ removedResolveLogs: 0, removedFeedbacks: 0 }),
      });

      const ctx = { request: {}, body: undefined, status: 200 } as never;
      await actions.stats(ctx);

      const body = (ctx as Record<string, unknown>).body as Record<string, unknown>;
      expect(body.entries).toMatchObject({ total: 3 });
      expect((body.entries as Record<string, unknown>).byStatus).toMatchObject({
        active: 1,
        probation: 1,
        quarantined: 1,
      });
      expect(body.apps).toMatchObject({ total: 1 });
      expect((body.recentResolves as Record<string, unknown>).byPath).toMatchObject({
        cache_hit: 1,
        heuristic: 1,
      });
    });

    it('returns top failing entries sorted by failCount', async () => {
      const { database, settings } = setup();
      await seedApp(database);
      for (let index = 0; index < 15; index += 1) {
        await seedEntry(database, { elementKey: `k${index}`, failCount: index });
      }

      const actions = createAdminActions({
        database,
        pipeline: null as never,
        feedback: null as never,
        settings,
        pruneLogs: async () => ({ removedResolveLogs: 0, removedFeedbacks: 0 }),
      });

      const ctx = { request: {}, body: undefined, status: 200 } as never;
      await actions.stats(ctx);

      const body = (ctx as Record<string, unknown>).body as Record<string, unknown>;
      const topFailing = body.topFailing as Array<{ failCount: number }>;
      expect(topFailing).toHaveLength(10);
      expect(topFailing[0].failCount).toBe(14);
      expect(topFailing[9].failCount).toBe(5);
    });

    it('computes cache hit rate from recent logs', async () => {
      const { database, settings } = setup();
      await seedApp(database);
      await seedEntry(database);
      for (const path of ['cache_hit', 'cache_hit', 'registry', 'heuristic']) {
        await database.repo('selectorResolveLogs').create({ values: { appId: 1, elementKey: 'k1', path } });
      }

      const actions = createAdminActions({
        database,
        pipeline: null as never,
        feedback: null as never,
        settings,
        pruneLogs: async () => ({ removedResolveLogs: 0, removedFeedbacks: 0 }),
      });

      const ctx = { request: {}, body: undefined, status: 200 } as never;
      await actions.stats(ctx);

      const body = (ctx as Record<string, unknown>).body as Record<string, unknown>;
      expect((body.recentResolves as Record<string, unknown>).cacheHitRate).toBeCloseTo(2 / 3, 4);
    });
  });

  describe('revalidate', () => {
    it('returns dry-run candidate without mutating the entry', async () => {
      const { database, settings } = setup();
      await seedApp(database);
      await seedEntry(database, { currentSelector: '#old-123', version: 1, status: 'active' });

      const { ResolvePipeline } = await import('../services/resolve-pipeline');
      const pipeline = new ResolvePipeline({ database, settings });

      const actions = createAdminActions({
        database,
        pipeline,
        feedback: null as never,
        settings,
        pruneLogs: async () => ({ removedResolveLogs: 0, removedFeedbacks: 0 }),
      });

      // The failed selector must have a dynamic suffix for the heuristic to
      // strip. "#old" has no suffix so repairIdDrift skips it; "#old-123"
      // triggers the id-drift path and produces "[id^=\"old\"]".
      const ctx = {
        request: {
          body: { entryId: 1, domSnippet: '<button id="old-123">Old Button</button><button id="new-btn">New</button>' },
        },
        body: undefined,
        status: 200,
      } as never;
      await actions.revalidate(ctx);

      const body = (ctx as Record<string, unknown>).body as Record<string, unknown>;
      expect(body.healTriggered).toBe(true);
      expect(body.dryRunCandidate).toBeDefined();
      expect(body.selector).toBe('#old-123'); // unchanged

      const entry = database.repo('selectorEntries').rows[0];
      expect(entry.currentSelector).toBe('#old-123');
      expect(entry.version).toBe(1);
    });
  });

  describe('rollbackVersion', () => {
    it('promotes a historical version to active', async () => {
      const { database, settings } = setup();
      await seedApp(database);
      await seedEntry(database, { currentSelector: '#new', version: 2 });
      await database.repo('selectorVersions').create({
        values: { entryId: 1, selector: '#old', selectorType: 'css', source: 'client', status: 'superseded' },
      });
      await database.repo('selectorVersions').create({
        values: { entryId: 1, selector: '#new', selectorType: 'css', source: 'heuristic', status: 'active' },
      });

      const actions = createAdminActions({
        database,
        pipeline: null as never,
        feedback: null as never,
        settings,
        pruneLogs: async () => ({ removedResolveLogs: 0, removedFeedbacks: 0 }),
      });

      const ctx = {
        request: { body: { entryId: 1, versionId: 1 } },
        body: undefined,
        status: 200,
      } as never;
      await actions.rollbackVersion(ctx);

      const body = (ctx as Record<string, unknown>).body as Record<string, unknown>;
      expect(body.selector).toBe('#old');
      expect(body.status).toBe('active');
      expect(body.version).toBe(3);

      const entry = database.repo('selectorEntries').rows[0];
      expect(entry.currentSelector).toBe('#old');
      expect(entry.resolvedBy).toBe('manual');
    });
  });

  describe('pruneLogs', () => {
    it('removes old logs and returns counts', async () => {
      const { database, settings } = setup();
      const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
      await database.repo('selectorResolveLogs').create({ values: { appId: 1, elementKey: 'k1', createdAt: oldDate } });
      await database.repo('selectorFeedbacks').create({ values: { appId: 1, elementKey: 'k1', createdAt: oldDate } });

      const pruneLogs = async () => {
        const filter = { createdAt: { $lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() } };
        const removedResolveLogs = await database.repo('selectorResolveLogs').destroy({ filter });
        const removedFeedbacks = await database.repo('selectorFeedbacks').destroy({ filter });
        return { removedResolveLogs, removedFeedbacks };
      };

      const actions = createAdminActions({
        database,
        pipeline: null as never,
        feedback: null as never,
        settings,
        pruneLogs,
      });

      const ctx = { request: {}, body: undefined, status: 200 } as never;
      await actions.pruneLogs(ctx);

      const body = (ctx as Record<string, unknown>).body as Record<string, unknown>;
      expect(body.removedResolveLogs).toBe(1);
      expect(body.removedFeedbacks).toBe(1);
      expect(database.repo('selectorResolveLogs').rows).toHaveLength(0);
    });
  });
});
