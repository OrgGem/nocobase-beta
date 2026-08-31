import { DEFAULT_SETTINGS, SelectorSettingsService } from '../services/settings-service';
import { ResolvePipeline } from '../services/resolve-pipeline';
import { LLMResolver, type SelectorLLMGateway } from '../services/llm-resolver';
import { FakeDatabase } from './helpers/fake-database';

const PAGE = `
<html><body>
  <form id="login-form">
    <input name="username" />
    <button id="btn-submit-9999" data-testid="submit" aria-label="Submit">Submit</button>
  </form>
</body></html>
`;

const setup = (options?: {
  settings?: Partial<typeof DEFAULT_SETTINGS>;
  gateway?: SelectorLLMGateway | null;
  now?: () => Date;
}) => {
  const database = new FakeDatabase();
  // LLM settings default on so the L4 branch is reachable; tests that opt out
  // pass gateway: null (no resolver factory) instead.
  const settingsValues = {
    ...DEFAULT_SETTINGS,
    llmService: 'test-llm',
    llmModel: 'fake-model',
    ...(options?.settings ?? {}),
  };
  const settings = { get: async () => settingsValues } as unknown as SelectorSettingsService;
  let gatewayCalls = 0;
  const pipeline = new ResolvePipeline({
    database,
    settings,
    now: options?.now,
    createLLMResolver:
      options?.gateway === null
        ? undefined
        : ({ llmService, model }) => {
            gatewayCalls += 1;
            return new LLMResolver(
              options?.gateway ?? {
                complete: async () => {
                  throw new Error(`unexpected llm call (${llmService}/${model})`);
                },
              },
            );
          },
  });
  return { database, pipeline, settingsValues, gatewayCalls: () => gatewayCalls };
};

const seedApp = async (database: FakeDatabase, values?: Record<string, unknown>) => {
  return database.repo('selectorApps').create({
    values: { name: 'crm', status: 'active', dryRun: false, ...values },
  });
};

describe('ResolvePipeline', () => {
  describe('validation', () => {
    it('rejects when the registry is disabled', async () => {
      const { pipeline } = setup({ settings: { enabled: false } });
      await expect(pipeline.resolve({ app: 'crm', elementKey: 'k' })).rejects.toThrow(/disabled/);
    });

    it('rejects unknown apps', async () => {
      const { pipeline } = setup();
      await expect(pipeline.resolve({ app: 'missing', elementKey: 'k' })).rejects.toThrow(/not registered/);
    });

    it('requires elementKey or logicalId', async () => {
      const { database, pipeline } = setup();
      await seedApp(database);
      await expect(pipeline.resolve({ app: 'crm', selector: '#a' })).rejects.toThrow(/elementKey/);
    });

    it('derives a stable elementKey from logicalId', async () => {
      const { database, pipeline } = setup();
      await seedApp(database);
      const first = await pipeline.resolve({ app: 'crm', logicalId: 'login-btn', selector: '#a' });
      const second = await pipeline.resolve({ app: 'crm', logicalId: 'login-btn', selector: '#a' });
      expect(first.elementKey).toBe(second.elementKey);
      expect(database.repo('selectorEntries').rows).toHaveLength(1);
    });
  });

  describe('lookup path', () => {
    it('bootstraps a probation entry on first sight', async () => {
      const { database, pipeline } = setup();
      await seedApp(database);
      const response = await pipeline.resolve({ app: 'crm', elementKey: 'k1', selector: '#login' });
      expect(response).toMatchObject({
        selector: '#login',
        source: 'registry',
        status: 'probation',
        version: 1,
        healTriggered: false,
      });
      expect(database.repo('selectorVersions').rows[0]).toMatchObject({ source: 'client', status: 'active' });
    });

    it('serves a cache hit for an unchanged selector', async () => {
      const { database, pipeline } = setup();
      await seedApp(database);
      await pipeline.resolve({ app: 'crm', elementKey: 'k1', selector: '#login' });
      const hit = await pipeline.resolve({ app: 'crm', elementKey: 'k1', selector: '#login' });
      expect(hit.source).toBe('cache_hit');
      expect(hit.selector).toBe('#login');
    });

    it('serves the registry selector when the client selector differs', async () => {
      const { database, pipeline } = setup();
      await seedApp(database);
      await pipeline.resolve({ app: 'crm', elementKey: 'k1', selector: '#login' });
      const lookup = await pipeline.resolve({ app: 'crm', elementKey: 'k1', selector: '#other' });
      expect(lookup.source).toBe('registry');
      expect(lookup.selector).toBe('#login');
    });

    it('serves miss when no entry exists and no selector was sent', async () => {
      const { database, pipeline } = setup();
      await seedApp(database);
      const miss = await pipeline.resolve({ app: 'crm', elementKey: 'k1' });
      expect(miss.source).toBe('miss');
      expect(miss.selector).toBeNull();
    });
  });

  describe('healing path', () => {
    it('heals a drifted id via heuristics', async () => {
      const { database, pipeline } = setup();
      await seedApp(database);
      await pipeline.resolve({ app: 'crm', elementKey: 'k1', selector: '#btn-submit-1234' });
      const healed = await pipeline.resolve({
        app: 'crm',
        elementKey: 'k1',
        selector: '#btn-submit-1234',
        failureType: 'not_found',
        domSnippet: PAGE,
      });
      expect(healed).toMatchObject({
        source: 'heuristic',
        selector: '[id^="btn-submit"]',
        healTriggered: true,
        version: 2,
        status: 'probation',
      });
      expect(healed.fallbacks).toEqual([{ selector: '#btn-submit-1234', selectorType: 'css' }]);
      expect(healed.signature?.tag).toBe('button');
      expect(healed.signature?.stableAttrs['data-testid']).toBe('submit');
    });

    it('falls back to LLM when heuristics find nothing', async () => {
      const { database, pipeline } = setup({
        gateway: {
          complete: async () => ({
            content: JSON.stringify({
              candidates: [
                { selector: '[data-testid="submit"]', selectorType: 'css', confidence: 0.8, reasoning: 'stable attr' },
              ],
            }),
            model: 'test-model',
            usage: { promptTokens: 10, completionTokens: 5 },
          }),
        },
      });
      await seedApp(database);
      await pipeline.resolve({ app: 'crm', elementKey: 'k1', selector: '#gone' });
      const healed = await pipeline.resolve({
        app: 'crm',
        elementKey: 'k1',
        selector: '#gone',
        failureType: 'not_found',
        domSnippet: PAGE,
      });
      expect(healed).toMatchObject({
        source: 'llm',
        selector: '[data-testid="submit"]',
        healTriggered: true,
        version: 2,
      });
    });

    it('skips healing when the entry is pinned', async () => {
      const { database, pipeline } = setup();
      await seedApp(database);
      await pipeline.resolve({ app: 'crm', elementKey: 'k1', selector: '#login' });
      await database.repo('selectorEntries').update({
        filterByTk: 1,
        values: { pinned: true },
      });
      const result = await pipeline.resolve({
        app: 'crm',
        elementKey: 'k1',
        selector: '#login',
        failureType: 'not_found',
        domSnippet: PAGE,
      });
      expect(result.source).toBe('skipped');
      expect(result.healTriggered).toBe(false);
      expect(result.selector).toBe('#login');
    });

    it('serves last known good on dirty evidence (page_error)', async () => {
      const { database, pipeline } = setup();
      await seedApp(database);
      await pipeline.resolve({ app: 'crm', elementKey: 'k1', selector: '#login' });
      const result = await pipeline.resolve({
        app: 'crm',
        elementKey: 'k1',
        selector: '#login',
        failureType: 'page_error',
        domSnippet: PAGE,
      });
      expect(result.source).toBe('skipped');
      expect(result.selector).toBe('#login');
    });

    it('returns cached response for duplicate idempotency keys', async () => {
      const { database, pipeline } = setup();
      await seedApp(database);
      await pipeline.resolve({ app: 'crm', elementKey: 'k1', selector: '#btn-submit-1234' });
      const first = await pipeline.resolve({
        app: 'crm',
        elementKey: 'k1',
        selector: '#btn-submit-1234',
        failureType: 'not_found',
        domSnippet: PAGE,
        idempotencyKey: 'run-1:step-1',
      });
      expect(first.source).toBe('heuristic');

      const second = await pipeline.resolve({
        app: 'crm',
        elementKey: 'k1',
        selector: '#btn-submit-1234',
        failureType: 'not_found',
        domSnippet: PAGE,
        idempotencyKey: 'run-1:step-1',
      });
      expect(second.source).toBe('heuristic');
      expect(second.selector).toBe(first.selector);
      // Only one version should have been created (the heal), not two.
      const versions = database.repo('selectorVersions').rows;
      expect(versions).toHaveLength(2); // bootstrap + heal
    });
  });

  describe('circuit breaker', () => {
    it('trips after max heals within the window', async () => {
      const { database, pipeline } = setup({
        settings: { circuitBreakerMaxHeals: 2, circuitBreakerWindowMs: 60000, circuitBreakerCooldownMs: 300000 },
      });
      await seedApp(database);
      // Use a selector that exists in PAGE so the heuristic can find it.
      await pipeline.resolve({ app: 'crm', elementKey: 'k1', selector: '#btn-submit-9999' });

      // First heal: succeeds (count=1)
      const heal1 = await pipeline.resolve({
        app: 'crm',
        elementKey: 'k1',
        selector: '#btn-submit-9999',
        failureType: 'not_found',
        domSnippet: PAGE,
      });
      expect(heal1.source).toBe('heuristic');

      // Second heal: succeeds (count=2)
      const heal2 = await pipeline.resolve({
        app: 'crm',
        elementKey: 'k1',
        selector: '#btn-submit-9999',
        failureType: 'not_found',
        domSnippet: PAGE,
      });
      expect(heal2.source).toBe('heuristic');

      // Third heal: breaker trips, entry quarantined
      const heal3 = await pipeline.resolve({
        app: 'crm',
        elementKey: 'k1',
        selector: '#btn-submit-9999',
        failureType: 'not_found',
        domSnippet: PAGE,
      });
      expect(heal3.source).toBe('miss');
      expect(heal3.healTriggered).toBe(true);
      const entry = database.repo('selectorEntries').rows[0];
      expect(entry.status).toBe('quarantined');
      expect(entry.circuitBrokenUntil).toBeTruthy();
    });
  });

  describe('dry run', () => {
    it('returns a candidate without mutating the entry', async () => {
      const { database, pipeline } = setup();
      await seedApp(database, { dryRun: true });
      await pipeline.resolve({ app: 'crm', elementKey: 'k1', selector: '#btn-submit-1234' });
      const result = await pipeline.resolve({
        app: 'crm',
        elementKey: 'k1',
        selector: '#btn-submit-1234',
        failureType: 'not_found',
        domSnippet: PAGE,
      });
      expect(result.dryRunCandidate).toBeDefined();
      expect(result.dryRunCandidate?.selector).toBe('[id^="btn-submit"]');
      expect(result.selector).toBe('#btn-submit-1234'); // unchanged
      expect(result.version).toBe(1); // unchanged
      const entry = database.repo('selectorEntries').rows[0];
      expect(entry.currentSelector).toBe('#btn-submit-1234');
    });
  });

  describe('inflight dedup', () => {
    it('concurrent heals for the same element share a single promise', async () => {
      const { database, pipeline } = setup();
      await seedApp(database);
      await pipeline.resolve({ app: 'crm', elementKey: 'k1', selector: '#btn-submit-1234' });

      const [r1, r2] = await Promise.all([
        pipeline.resolve({
          app: 'crm',
          elementKey: 'k1',
          selector: '#btn-submit-1234',
          failureType: 'not_found',
          domSnippet: PAGE,
        }),
        pipeline.resolve({
          app: 'crm',
          elementKey: 'k1',
          selector: '#btn-submit-1234',
          failureType: 'not_found',
          domSnippet: PAGE,
        }),
      ]);
      expect(r1).toBe(r2);
      expect(r1.source).toBe('heuristic');
    });
  });
});
