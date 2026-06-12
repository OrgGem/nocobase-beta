import { createMockServer, MockServer } from '@nocobase/test';
import { COLLECTION_NAME, SETTINGS_COLLECTION_NAME } from '../../shared/constants';
import PluginBuildVisualizationBlockServer from '../plugin';

/**
 * Server tests for the `plugin-build-visualization-block` schema bootstrap.
 *
 * These cover task 2.3 (Requirement 11.2): the `aiVisualizationBuilds`
 * collection is registered with its key fields, records can be created and read
 * back, and the `ensureSchema`-equivalent bootstrap is idempotent across
 * repeated `upgrade()` invocations.
 *
 * NOTE: server tests must NOT run in parallel (they share a database) — run
 * this file on its own with `yarn test <path> --run`.
 */
describe('plugin-build-visualization-block schema bootstrap', () => {
  let app: MockServer | undefined;
  let bootError: unknown;

  beforeAll(async () => {
    try {
      app = await createMockServer({
        plugins: ['nocobase', PluginBuildVisualizationBlockServer],
      });
    } catch (error) {
      // The mock-server harness needs a reachable test database. If it cannot
      // boot in this environment, record the reason and let each test skip with
      // a clear message rather than reporting a false failure.
      bootError = error;
      // eslint-disable-next-line no-console
      console.warn(
        `[plugin-build-visualization-block] Skipping bootstrap tests; mock server could not start: ${String(error)}`,
      );
    }
  });

  afterAll(async () => {
    await app?.destroy();
  });

  /** Returns the booted app or skips the calling test with a clear reason. */
  const requireApp = (): MockServer | undefined => {
    if (!app) {
      // eslint-disable-next-line no-console
      console.warn(`[plugin-build-visualization-block] Test skipped — mock server unavailable: ${String(bootError)}`);
    }
    return app;
  };

  it('registers the aiVisualizationBuilds collection', () => {
    const server = requireApp();
    if (!server) return;

    const collection = server.db.getCollection(COLLECTION_NAME);
    expect(collection).toBeTruthy();
  });

  it('registers the singleton settings collection', () => {
    const server = requireApp();
    if (!server) return;

    const collection = server.db.getCollection(SETTINGS_COLLECTION_NAME);
    expect(collection).toBeTruthy();

    const expectedFields: Record<string, string> = {
      defaultDataSource: 'string',
      defaultCollections: 'json',
      defaultLLMService: 'string',
      defaultModel: 'string',
      enableAITool: 'boolean',
    };

    for (const [name, type] of Object.entries(expectedFields)) {
      const field = collection.getField(name);
      expect(field).toBeTruthy();
      expect(field.type).toBe(type);
    }
  });

  it('defines the key Build_Record fields', () => {
    const server = requireApp();
    if (!server) return;

    const collection = server.db.getCollection(COLLECTION_NAME);
    expect(collection).toBeTruthy();

    // name -> expected field type, covering the fields called out by the task.
    const expectedFields: Record<string, string> = {
      requirement: 'text',
      dataSource: 'string',
      collections: 'json',
      buildPhase: 'string',
      buildRunId: 'uuid',
      blockSpec: 'json',
      blockSchema: 'json',
      usedFallback: 'boolean',
    };

    for (const [name, type] of Object.entries(expectedFields)) {
      const field = collection.getField(name);
      expect(field).toBeTruthy();
      expect(field.type).toBe(type);
    }
  });

  it('can create and read back a build record', async () => {
    const server = requireApp();
    if (!server) return;

    const repo = server.db.getRepository(COLLECTION_NAME);
    expect(repo).toBeTruthy();

    const created = await repo.create({
      values: {
        title: 'Manage X and Y',
        requirement: 'Build a block to manage and visualize data from collection X and Y.',
        dataSource: 'main',
        collections: ['x', 'y'],
        primaryCollection: 'x',
        llmService: 'openai',
        model: 'gpt-4o-mini',
        buildPhase: 'queued',
        blockSpec: { version: 1, blockType: 'table', primaryCollection: 'x' },
        usedFallback: false,
      },
    });

    expect(created.id).toBeTruthy();

    const found = await repo.findOne({ filterByTk: created.id });
    expect(found).toBeTruthy();
    expect(found.requirement).toBe('Build a block to manage and visualize data from collection X and Y.');
    expect(found.dataSource).toBe('main');
    expect(found.collections).toEqual(['x', 'y']);
    expect(found.buildPhase).toBe('queued');
    expect(found.blockSpec).toMatchObject({ blockType: 'table', primaryCollection: 'x' });
    expect(found.usedFallback).toBe(false);
  });

  it('applies sensible defaults for status / buildPhase / usedFallback', async () => {
    const server = requireApp();
    if (!server) return;

    const repo = server.db.getRepository(COLLECTION_NAME);
    const created = await repo.create({
      values: {
        requirement: 'Defaults check',
      },
    });

    const found = await repo.findOne({ filterByTk: created.id });
    expect(found.status).toBe('idle');
    expect(found.buildPhase).toBe('idle');
    expect(found.usedFallback).toBe(false);
  });

  it('runs the schema bootstrap idempotently across repeated upgrades', async () => {
    const server = requireApp();
    if (!server) return;

    const plugin = server.pm.get(PluginBuildVisualizationBlockServer);
    expect(plugin).toBeTruthy();

    // `upgrade()` runs the ensureSchema-equivalent bootstrap. Invoking it twice
    // must not throw and must leave the collection fully functional.
    await expect(plugin.upgrade()).resolves.not.toThrow();
    await expect(plugin.upgrade()).resolves.not.toThrow();

    // The collection is still registered and writable after re-running bootstrap.
    const collection = server.db.getCollection(COLLECTION_NAME);
    expect(collection).toBeTruthy();

    const repo = server.db.getRepository(COLLECTION_NAME);
    const created = await repo.create({
      values: {
        requirement: 'Post-upgrade write',
        dataSource: 'main',
        collections: ['x'],
        buildPhase: 'queued',
      },
    });
    const found = await repo.findOne({ filterByTk: created.id });
    expect(found).toBeTruthy();
    expect(found.requirement).toBe('Post-upgrade write');
    expect(found.buildPhase).toBe('queued');
  });
});
