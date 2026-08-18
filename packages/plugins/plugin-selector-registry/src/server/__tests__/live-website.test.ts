import { describeElement, parseDom, selectOneCss, type ElementDescriptor } from '../services/dom-analyzer';
import { heuristicRepair } from '../services/heuristic-repair';
import { ResolvePipeline } from '../services/resolve-pipeline';
import { DEFAULT_SETTINGS, type SelectorSettingsService } from '../services/settings-service';
import { FakeDatabase } from './helpers/fake-database';
import type { Element } from 'domhandler';

// A real, long-lived public test site (Sauce Labs' "the-internet"). The login
// page exposes stable fields (#username, #password, a submit button) that we
// can deliberately "break" and then ask the registry to heal against the live
// DOM — proving self-healing works on real-world HTML, not just fixtures.
const TARGET_URL = 'https://the-internet.herokuapp.com/login';

const fetchHtml = async (url: string, attempts = 3): Promise<string> => {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': 'plugin-selector-registry-live-test/0.1' },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const text = await response.text();
      if (text.length > 200) {
        return text;
      }
      throw new Error('Response body was unexpectedly small.');
    } catch (error) {
      lastError = error;
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Could not fetch ${url} after ${attempts} attempts: ${reason}`);
};

const requireElement = (dom: ReturnType<typeof parseDom>, selector: string): Element => {
  const element = selectOneCss(dom, selector);
  if (!element) {
    throw new Error(`Expected "${selector}" to match an element on the live page.`);
  }
  return element;
};

const descriptorOf = (element: Element): ElementDescriptor => describeElement(element);

// Fetched once at module load; when the site is unreachable the whole suite is
// skipped instead of failing (offline machines, air-gapped CI).
const fetchedHtml = await fetchHtml(TARGET_URL).catch(() => null);
const liveHtml = fetchedHtml ?? '';

describe.skipIf(fetchedHtml === null)('Self-healing against a live website (the-internet.herokuapp.com/login)', () => {
  it('fetched the real login page with the expected fields', () => {
    expect(liveHtml.length).toBeGreaterThan(500);
    const dom = parseDom(liveHtml);
    const username = requireElement(dom, '#username');
    const password = requireElement(dom, '#password');
    expect(descriptorOf(username).tag).toBe('input');
    expect(descriptorOf(username).attrs['name']).toBe('username');
    expect(descriptorOf(password).attrs['type']).toBe('password');
  });

  describe('heuristicRepair on the live DOM', () => {
    it('heals a drifted dynamic id into a stable prefix anchor (username field)', () => {
      const candidates = heuristicRepair({
        failedSelector: '#username-4821',
        selectorType: 'css',
        domSnippet: liveHtml,
      });
      const drift = candidates.find((candidate) => candidate.source === 'id-drift');
      expect(drift).toBeDefined();
      expect(drift?.selector).toBe('[id^="username"]');
      expect(drift?.unique).toBe(true);

      // The healed selector must really resolve the username input on the page.
      const healed = requireElement(parseDom(liveHtml), drift?.selector ?? '');
      expect(descriptorOf(healed).tag).toBe('input');
      expect(descriptorOf(healed).attrs['name']).toBe('username');
    });

    it('reanchors on the final unique segment of a broken structural selector (password field)', () => {
      const candidates = heuristicRepair({
        failedSelector: 'form#login > div.row > div.columns > div.removed-wrapper > input[name="password"]',
        selectorType: 'css',
        domSnippet: liveHtml,
      });
      const reanchor = candidates.find((candidate) => candidate.source === 'segment-reanchor');
      expect(reanchor).toBeDefined();
      expect(reanchor?.selector).toBe('input[name="password"]');
      expect(reanchor?.unique).toBe(true);

      const healed = requireElement(parseDom(liveHtml), reanchor?.selector ?? '');
      expect(descriptorOf(healed).attrs['type']).toBe('password');
    });

    it('validates a client-provided attribute candidate (submit button)', () => {
      const candidates = heuristicRepair({
        failedSelector: '#login-btn-stale-99',
        selectorType: 'css',
        domSnippet: liveHtml,
        candidates: [{ tag: 'button', attrs: { type: 'submit' } }],
      });
      const client = candidates.find((candidate) => candidate.source === 'client-candidate');
      expect(client).toBeDefined();
      expect(client?.selector).toBe('button[type="submit"]');
      expect(client?.unique).toBe(true);

      const healed = requireElement(parseDom(liveHtml), client?.selector ?? '');
      expect(descriptorOf(healed).tag).toBe('button');
    });
  });

  describe('ResolvePipeline end-to-end on the live DOM', () => {
    const buildPipeline = () => {
      const database = new FakeDatabase();
      const settings = { get: async () => ({ ...DEFAULT_SETTINGS }) } as unknown as SelectorSettingsService;
      const pipeline = new ResolvePipeline({ database, settings });
      return { database, pipeline };
    };

    it('bootstraps, serves a cache hit, then heals a drifted id', async () => {
      const { database, pipeline } = buildPipeline();
      await database.repo('selectorApps').create({
        values: { name: 'the-internet', status: 'active', dryRun: false },
      });

      // 1. Bootstrap: the bot first saw the username field with a dynamic-id selector.
      const bootstrap = await pipeline.resolve({
        app: 'the-internet',
        elementKey: 'login-username',
        selector: '#username-4821',
      });
      expect(bootstrap).toMatchObject({ source: 'registry', status: 'probation', version: 1 });

      // 2. Exact cache hit for the unchanged selector.
      const hit = await pipeline.resolve({
        app: 'the-internet',
        elementKey: 'login-username',
        selector: '#username-4821',
      });
      expect(hit.source).toBe('cache_hit');

      // 3. The id rotated and the stored selector stops matching; the bot
      //    reports not_found together with a fresh snapshot of the live page.
      const healed = await pipeline.resolve({
        app: 'the-internet',
        elementKey: 'login-username',
        selector: '#username-4821',
        failureType: 'not_found',
        domSnippet: liveHtml,
      });
      expect(healed).toMatchObject({
        source: 'heuristic',
        selector: '[id^="username"]',
        healTriggered: true,
        version: 2,
      });
      // The registry captured a signature of the real element for future checks.
      expect(healed.signature?.tag).toBe('input');

      const entry = database.repo('selectorEntries').rows[0];
      expect(entry.currentSelector).toBe('[id^="username"]');
      expect(entry.resolvedBy).toBe('heuristic');

      // And the healed anchor genuinely resolves the username input live.
      const resolved = requireElement(parseDom(liveHtml), '[id^="username"]');
      expect(descriptorOf(resolved).attrs['name']).toBe('username');
    });

    it('keeps serving the healed selector from the registry afterwards', async () => {
      const { database, pipeline } = buildPipeline();
      await database.repo('selectorApps').create({
        values: { name: 'the-internet', status: 'active', dryRun: false },
      });
      await pipeline.resolve({ app: 'the-internet', elementKey: 'login-password', selector: '#password-77' });
      await pipeline.resolve({
        app: 'the-internet',
        elementKey: 'login-password',
        selector: '#password-77',
        failureType: 'not_found',
        domSnippet: liveHtml,
      });

      // A subsequent lookup (no failure) returns the healed, trusted selector.
      const lookup = await pipeline.resolve({
        app: 'the-internet',
        elementKey: 'login-password',
        selector: '#password-77',
      });
      expect(lookup.source).toBe('registry');
      expect(lookup.selector).toBe('[id^="password"]');

      const resolved = requireElement(parseDom(liveHtml), '[id^="password"]');
      expect(descriptorOf(resolved).attrs['type']).toBe('password');
    });
  });
});
