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

    it('serves an exact cache hit for the same selector', async () => {
      const { database, pipeline } = setup();
      await seedApp(database);
      await pipeline.resolve({ app: 'crm', elementKey: 'k1', selector: '#login' });
      const response = await pipeline.resolve({ app: 'crm', elementKey: 'k1', selector: '#login' });
      expect(response.source).toBe('cache_hit');
      expect(database.repo('selectorEntries').rows[0].hitCount).toBe(2);
    });

    it('serves the trusted selector when the client sends a different one', async () => {
      const { database, pipeline } = setup();
      await seedApp(database);
      await pipeline.resolve({ app: 'crm', elementKey: 'k1', selector: '#login' });
      const response = await pipeline.resolve({ app: 'crm', elementKey: 'k1', selector: '#old-wrong' });
      expect(response.source).toBe('registry');
      expect(response.selector).toBe('#login');
    });

    it('returns a miss for unknown elements without a selector', async () => {
      const { database, pipeline } = setup();
      await seedApp(database);
      const response = await pipeline.resolve({ app: 'crm', elementKey: 'unknown' });
      expect(response).toMatchObject({ source: 'miss', selector: null, version: 0 });
    });

    it('never serves disabled entries', async () => {
      const { database, pipeline } = setup();
      await seedApp(database);
      await pipeline.resolve({ app: 'crm', elementKey: 'k1', selector: '#login' });
      database.repo('selectorEntries').rows[0].status = 'disabled';
      const response = await pipeline.resolve({ app: 'crm', elementKey: 'k1', selector: '#login' });
      expect(response.source).toBe('miss');
    });
  });

  describe('dirty evidence', () => {
    it('does not heal on page_error failures', async () => {
      const { database, pipeline } = setup();
      await seedApp(database);
      await pipeline.resolve({ app: 'crm', elementKey: 'k1', selector: '#login' });
      const response = await pipeline.resolve({
        app: 'crm',
        elementKey: 'k1',
        selector: '#login',
        failureType: 'page_error',
        domSnippet: PAGE,
      });
      expect(response.source).toBe('skipped');
      expect(response.healTriggered).toBe(false);
      expect(response.selector).toBe('#login');
      expect(database.repo('selectorEntries').rows[0].currentSelector).toBe('#login');
    });
  });

  describe('healing L3 (heuristic)', () => {
    it('heals a drifted id and demotes the old selector to fallback', async () => {
      const { database, pipeline } = setup();
      await seedApp(database);
      await pipeline.resolve({ app: 'crm', elementKey: 'k1', selector: '#btn-submit-1234' });

      const response = await pipeline.resolve({
        app: 'crm',
        elementKey: 'k1',
        selector: '#btn-submit-1234',
        failureType: 'not_found',
        domSnippet: PAGE,
      });

      expect(response).toMatchObject({
        source: 'heuristic',
        selector: '[id^="btn-submit"]',
        status: 'probation',
        version: 2,
        healTriggered: true,
      });
      expect(response.fallbacks).toEqual([{ selector: '#btn-submit-1234', selectorType: 'css' }]);
      expect(response.signature?.tag).toBe('button');

      const entry = database.repo('selectorEntries').rows[0];
      expect(entry.currentSelector).toBe('[id^="btn-submit"]');
      expect(entry.resolvedBy).toBe('heuristic');

      const versions = database.repo('selectorVersions').rows;
      expect(versions).toHaveLength(2);
      expect(versions[0].status).toBe('superseded');
      expect(versions[1]).toMatchObject({ source: 'heuristic', status: 'active' });
    });

    it('captures the healed element signature for future verification', async () => {
      const { database, pipeline } = setup();
      await seedApp(database);
      await pipeline.resolve({ app: 'crm', elementKey: 'k1', selector: '#btn-submit-1234' });
      const response = await pipeline.resolve({
        app: 'crm',
        elementKey: 'k1',
        selector: '#btn-submit-1234',
        failureType: 'not_found',
        domSnippet: PAGE,
      });
      expect(response.signature?.stableAttrs['data-testid']).toBe('submit');
      expect(database.repo('selectorEntries').rows[0].signature.stableAttrs['data-testid']).toBe('submit');
    });
  });

  describe('healing L4 (LLM)', () => {
    const llmGateway = (content: string): SelectorLLMGateway => ({
      complete: async () => ({ content, model: 'fake-model', usage: { promptTokens: 100, completionTokens: 20 } }),
    });

    it('uses the LLM when heuristics find nothing', async () => {
      const gateway = llmGateway(
        JSON.stringify({ candidates: [{ selector: '[data-testid="submit"]', confidence: 0.9 }] }),
      );
      const { database, pipeline } = setup({ gateway });
      await seedApp(database);
      await pipeline.resolve({ app: 'crm', elementKey: 'k1', selector: 'body > div.gone > span' });

      const response = await pipeline.resolve({
        app: 'crm',
        elementKey: 'k1',
        selector: 'body > div.gone > span',
        failureType: 'not_found',
        domSnippet: PAGE,
      });

      expect(response).toMatchObject({ source: 'llm', selector: '[data-testid="submit"]', healTriggered: true });
      const version = database.repo('selectorVersions').rows.at(-1);
      expect(version).toMatchObject({ source: 'llm', llmModel: 'fake-model', promptTokens: 100 });
    });

    it('rejects LLM candidates that point at the wrong element', async () => {
      // Stored signature says: the Submit button. LLM proposes the username input.
      // The failed selector has no id-drift/reanchor potential so L4 is reached.
      const gateway = llmGateway(
        JSON.stringify({ candidates: [{ selector: 'input[name="username"]', confidence: 0.9 }] }),
      );
      const { database, pipeline } = setup({ gateway });
      await seedApp(database);
      await pipeline.resolve({ app: 'crm', elementKey: 'k1', selector: 'body > div.gone > span' });
      database.repo('selectorEntries').rows[0].signature = {
        tag: 'button',
        stableAttrs: { 'data-testid': 'submit', 'aria-label': 'Submit' },
        textSample: 'Submit',
        textHash: 'x',
      };

      const response = await pipeline.resolve({
        app: 'crm',
        elementKey: 'k1',
        selector: 'body > div.gone > span',
        failureType: 'not_found',
        domSnippet: PAGE,
      });

      expect(response.source).toBe('miss');
      expect(database.repo('selectorEntries').rows[0].currentSelector).toBe('body > div.gone > span');
      expect(database.repo('selectorEntries').rows[0].status).toBe('degraded');
    });

    it('rejects LLM candidates that match multiple elements', async () => {
      const gateway = llmGateway(
        JSON.stringify({ candidates: [{ selector: 'form input, form button', confidence: 0.9 }] }),
      );
      const { database, pipeline } = setup({ gateway });
      await seedApp(database);
      const response = await pipeline.resolve({
        app: 'crm',
        elementKey: 'k1',
        selector: '#gone',
        failureType: 'not_found',
        domSnippet: PAGE,
      });
      expect(response.source).toBe('miss');
    });

    it('survives gateway errors and degrades the entry', async () => {
      const gateway: SelectorLLMGateway = {
        complete: async () => {
          throw new Error('llm down');
        },
      };
      const { database, pipeline } = setup({ gateway });
      await seedApp(database);
      await pipeline.resolve({ app: 'crm', elementKey: 'k1', selector: '#gone' });
      const response = await pipeline.resolve({
        app: 'crm',
        elementKey: 'k1',
        selector: '#gone',
        failureType: 'not_found',
        domSnippet: '<div>nothing useful</div>',
      });
      expect(response.source).toBe('miss');
      expect(database.repo('selectorEntries').rows[0].status).toBe('degraded');
    });
  });

  describe('pinned entries', () => {
    it('never heals a pinned entry', async () => {
      const { database, pipeline } = setup();
      await seedApp(database);
      await pipeline.resolve({ app: 'crm', elementKey: 'k1', selector: '#login' });
      database.repo('selectorEntries').rows[0].pinned = true;

      const response = await pipeline.resolve({
        app: 'crm',
        elementKey: 'k1',
        selector: '#login',
        failureType: 'not_found',
        domSnippet: PAGE,
      });
      expect(response.source).toBe('skipped');
      expect(database.repo('selectorEntries').rows[0].currentSelector).toBe('#login');
    });
  });

  describe('dry-run apps', () => {
    it('computes the heal but does not apply it', async () => {
      const { database, pipeline } = setup();
      await seedApp(database, { dryRun: true });
      await pipeline.resolve({ app: 'crm', elementKey: 'k1', selector: '#btn-submit-1234' });

      const response = await pipeline.resolve({
        app: 'crm',
        elementKey: 'k1',
        selector: '#btn-submit-1234',
        failureType: 'not_found',
        domSnippet: PAGE,
      });

      expect(response.dryRunCandidate?.selector).toBe('[id^="btn-submit"]');
      expect(response.selector).toBe('#btn-submit-1234');
      expect(database.repo('selectorEntries').rows[0].currentSelector).toBe('#btn-submit-1234');
      expect(database.repo('selectorVersions').rows).toHaveLength(1);
    });
  });

  describe('preview (admin revalidate)', () => {
    it('never mutates live state even when no repair is found', async () => {
      const { database, pipeline } = setup({ settings: { circuitBreakerMaxHeals: 1 } });
      await seedApp(database);
      await pipeline.resolve({ app: 'crm', elementKey: 'k1', selector: '#login' });
      const before = { ...database.repo('selectorEntries').rows[0] };

      // No dom snippet and no LLM -> nothing can be found. A normal heal would
      // degrade the entry and burn circuit-breaker budget; preview must not.
      const response = await pipeline.resolve(
        { app: 'crm', elementKey: 'k1', selector: '#login', failureType: 'not_found' },
        { forceDryRun: true },
      );

      expect(response.source).toBe('miss');
      const after = database.repo('selectorEntries').rows[0];
      expect(after.status).toBe(before.status);
      expect(after.healAttempts).toBe(before.healAttempts);
      expect(after.hitCount).toBe(before.hitCount);
      expect(after.currentSelector).toBe('#login');
    });

    it('returns the computed candidate without applying it', async () => {
      const { database, pipeline } = setup();
      await seedApp(database);
      await pipeline.resolve({ app: 'crm', elementKey: 'k1', selector: '#btn-submit-1234' });

      const response = await pipeline.resolve(
        { app: 'crm', elementKey: 'k1', selector: '#btn-submit-1234', failureType: 'not_found', domSnippet: PAGE },
        { forceDryRun: true },
      );

      expect(response.dryRunCandidate?.selector).toBe('[id^="btn-submit"]');
      expect(database.repo('selectorEntries').rows[0].currentSelector).toBe('#btn-submit-1234');
      expect(database.repo('selectorEntries').rows[0].status).toBe('probation');
    });
  });

  describe('circuit breaker', () => {
    it('quarantines an entry after repeated failed heals', async () => {
      const { database, pipeline } = setup({ settings: { circuitBreakerMaxHeals: 1 } });
      await seedApp(database);
      await pipeline.resolve({ app: 'crm', elementKey: 'k1', selector: '#gone' });

      const first = await pipeline.resolve({
        app: 'crm',
        elementKey: 'k1',
        selector: '#gone',
        failureType: 'not_found',
      });
      expect(first.source).toBe('miss');

      const second = await pipeline.resolve({
        app: 'crm',
        elementKey: 'k1',
        selector: '#gone',
        failureType: 'not_found',
      });
      expect(second.source).toBe('miss');

      const entry = database.repo('selectorEntries').rows[0];
      expect(entry.status).toBe('quarantined');
      expect(entry.circuitBrokenUntil).toBeTruthy();
      expect(entry.healAttempts).toBe(1);

      const third = await pipeline.resolve({
        app: 'crm',
        elementKey: 'k1',
        selector: '#gone',
        failureType: 'not_found',
      });
      expect(third.source).toBe('miss');
      expect(database.repo('selectorEntries').rows[0].healAttempts).toBe(1);
    });
  });

  describe('idempotency and dedup', () => {
    it('returns the stored response for a repeated idempotency key', async () => {
      let calls = 0;
      const gateway: SelectorLLMGateway = {
        complete: async () => {
          calls += 1;
          return { content: JSON.stringify({ candidates: [{ selector: '[data-testid="submit"]', confidence: 0.9 }] }) };
        },
      };
      const { database, pipeline } = setup({ gateway });
      await seedApp(database);

      const payload = {
        app: 'crm',
        elementKey: 'k1',
        selector: '#gone',
        failureType: 'not_found' as const,
        domSnippet: PAGE,
        idempotencyKey: 'run-42',
      };
      const first = await pipeline.resolve(payload);
      const second = await pipeline.resolve(payload);

      expect(first.source).toBe('llm');
      expect(second).toEqual(first);
      expect(calls).toBe(1);
    });

    it('deduplicates concurrent heals for the same element', async () => {
      let calls = 0;
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const gateway: SelectorLLMGateway = {
        complete: async () => {
          calls += 1;
          await gate;
          return { content: JSON.stringify({ candidates: [{ selector: '[data-testid="submit"]', confidence: 0.9 }] }) };
        },
      };
      const { database, pipeline } = setup({ gateway });
      await seedApp(database);

      const payload = {
        app: 'crm',
        elementKey: 'k1',
        selector: '#gone',
        failureType: 'not_found' as const,
        domSnippet: PAGE,
      };
      const firstPromise = pipeline.resolve(payload);
      const secondPromise = pipeline.resolve(payload);
      // Let both requests reach the heal path (first holds the gate, second dedups onto it).
      await new Promise((resolve) => setTimeout(resolve, 10));
      release();
      const [first, second] = await Promise.all([firstPromise, secondPromise]);

      expect(first).toEqual(second);
      expect(calls).toBe(1);
    });
  });

  describe('logging', () => {
    it('writes a resolve log per request with trimmed payload', async () => {
      const { database, pipeline } = setup();
      await seedApp(database);
      await pipeline.resolve({
        app: 'crm',
        elementKey: 'k1',
        selector: '#login',
        domSnippet: 'X'.repeat(5000),
        agentId: 'uipath-bot-1',
      });
      const logs = database.repo('selectorResolveLogs').rows;
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ path: 'registry', agentId: 'uipath-bot-1', elementKey: 'k1' });
      expect(String(logs[0].requestPayload.domSnippet).length).toBeLessThanOrEqual(2001);
      expect(logs[0].responsePayload.selector).toBe('#login');
    });
  });
});
