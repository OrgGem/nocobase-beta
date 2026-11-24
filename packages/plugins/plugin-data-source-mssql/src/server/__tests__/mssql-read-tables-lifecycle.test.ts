// SPDX-License-Identifier: Apache-2.0

import { createMockServer, MockServer } from '@nocobase/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MssqlExternalDataSource, type MssqlDataSourceOptions } from '../data-source/MssqlExternalDataSource';
import { MssqlIntrospector } from '../data-source/MssqlIntrospector';
import { PluginDataSourceMssqlServer } from '../plugin';

function createRuntimeSource(readTables: () => Promise<Array<{ name: string }>>) {
  const source = Object.assign(Object.create(MssqlExternalDataSource.prototype) as MssqlExternalDataSource, {
    readTables: vi.fn(readTables),
    close: vi.fn().mockResolvedValue(undefined),
  });

  return source;
}

function createSelectionRuntimeSource(options: MssqlDataSourceOptions, initiallyLoaded: string[] = []) {
  type RuntimeCollection = {
    name: string;
    options: { name: string; title: string; tableName: string; schema: string; fields: Array<{ name: string }> };
    updateOptions(options: RuntimeCollection['options']): void;
    getFields(): Array<{ options: { name: string } }>;
  };
  const loaded = new Map<string, RuntimeCollection>();
  for (const name of initiallyLoaded) {
    loaded.set(name, {
      name,
      options: { name, title: name, tableName: name, schema: 'dbo', fields: [] },
      updateOptions(options) {
        this.options = options;
      },
      getFields() {
        return this.options.fields.map((field) => ({ options: field }));
      },
    });
  }
  const getCollection = vi.fn((name: string) => loaded.get(name));
  const defineCollection = vi.fn((collection: RuntimeCollection['options']) => {
    loaded.set(collection.name, {
      name: collection.name,
      options: collection,
      updateOptions(options) {
        this.options = options;
      },
      getFields() {
        return this.options.fields.map((field) => ({ options: field }));
      },
    });
  });
  const removeCollection = vi.fn((name: string) => loaded.delete(name));
  const authenticate = vi.fn().mockResolvedValue(undefined);
  const getTables = vi.fn().mockResolvedValue(['unselected_table']);
  const preloadFTSIndexedColumns = vi.fn().mockResolvedValue(undefined);
  const getCollectionFromSchema = vi.fn(
    async ({ tableInfo }: { tableInfo: { tableName: string; schema: string } }) => ({
      name: tableInfo.tableName,
      title: tableInfo.tableName,
      tableName: tableInfo.tableName,
      schema: tableInfo.schema,
      fields: [],
    }),
  );
  const database = {
    options: { schema: options.schema || 'dbo' },
    sequelize: { authenticate },
    checkVersion: vi.fn().mockResolvedValue(undefined),
    registerOperators: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const source = Object.assign(Object.create(MssqlExternalDataSource.prototype) as MssqlExternalDataSource, {
    options,
    collectionManager: {
      db: database,
      getCollection,
      getCollections: vi.fn(() => [...loaded.values()]),
      defineCollection,
      removeCollection,
    },
    introspector: {
      getTables,
      tableInfoToCollectionOptions: ({ tableName, schema }: { tableName: string; schema: string }) => ({
        name: tableName,
        title: tableName,
        tableName,
        schema,
      }),
      getCollection: getCollectionFromSchema,
      preloadAllColumns: vi.fn().mockResolvedValue(undefined),
      preloadAllPrimaryKeys: vi.fn().mockResolvedValue(undefined),
      preloadFTSIndexedColumns,
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    emitLoadingProgress: vi.fn(),
  });

  return {
    source,
    loaded,
    getTables,
    getCollectionFromSchema,
    preloadFTSIndexedColumns,
    defineCollection,
    removeCollection,
  };
}

async function createDataSourceRecord(
  app: MockServer,
  values: {
    key: string;
    type: string;
    displayName: string;
    enabled: boolean;
    options: MssqlDataSourceOptions;
  },
) {
  const DataSourceModel = app.db.getModel('dataSources') as unknown as {
    prototype: { loadIntoApplication: () => Promise<void> };
  };
  const testConnection = vi.spyOn(MssqlExternalDataSource, 'testConnection').mockResolvedValue(true);
  const loadIntoApplication = vi.spyOn(DataSourceModel.prototype, 'loadIntoApplication').mockResolvedValue(undefined);
  try {
    await app.db.getRepository('dataSources').create({ values });
  } finally {
    loadIntoApplication.mockRestore();
    testConnection.mockRestore();
  }
}

async function seedSelectedDataSource(
  app: MockServer,
  dataSourceKey: string,
  selectedCollections: string[],
  loadedCollections: string[] = selectedCollections,
  persistedOptionOverrides: Partial<MssqlDataSourceOptions> = {},
  runtimeOptionOverrides: Partial<MssqlDataSourceOptions> = {},
) {
  const persistedOptions: MssqlDataSourceOptions = {
    host: 'mock-host',
    database: 'mock-db',
    schema: 'dbo',
    addAllCollections: false,
    selectedCollections,
    ...persistedOptionOverrides,
  };
  const runtimeOptions: MssqlDataSourceOptions = { ...persistedOptions, ...runtimeOptionOverrides };
  await createDataSourceRecord(app, {
    key: dataSourceKey,
    type: 'mssql',
    displayName: dataSourceKey,
    enabled: false,
    options: persistedOptions,
  });

  const runtime = createSelectionRuntimeSource(runtimeOptions, selectedCollections);
  app.dataSourceManager.dataSources.set(dataSourceKey, runtime.source);
  const collections = app.db.getRepository('dataSourcesCollections');
  for (const name of loadedCollections) {
    await collections.create({ values: { name, dataSourceKey } });
  }

  for (const name of selectedCollections.filter((selected) => !loadedCollections.includes(selected))) {
    runtime.loaded.delete(name);
  }

  return runtime;
}

describe('MSSQL readTables datasource lifecycle through the core API', () => {
  let app: MockServer;
  let databaseDirectory: string;
  const transactionTrace: string[] = [];

  beforeAll(async () => {
    databaseDirectory = await mkdtemp(join(tmpdir(), 'mssql-datasource-tests-'));
    app = await createMockServer({
      database: {
        dialect: 'sqlite',
        storage: join(databaseDirectory, 'main.sqlite'),
        logging: (sql: string) => {
          const match = /Executing \(([^)]+)\):\s*(BEGIN(?: IMMEDIATE)?(?: TRANSACTION)?|COMMIT|ROLLBACK)/i.exec(sql);
          if (match) transactionTrace.push(`${match[1]}:${match[2].toUpperCase()}`);
        },
      },
      plugins: ['nocobase', [PluginDataSourceMssqlServer, { name: 'data-source-mssql' }]],
    });
  });

  afterAll(async () => {
    await app?.destroy();
    await rm(databaseDirectory, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('closes a temporary MSSQL probe after a successful readTables request', async () => {
    const probe = createRuntimeSource(async () => [{ name: 'orders' }]);
    vi.spyOn(app.dataSourceManager.factory, 'create').mockReturnValueOnce(probe);

    const response = await app
      .agent()
      .resource('dataSources')
      .readTables({
        values: {
          dataSourceKey: 'mssql-probe-success',
          dbOptions: { type: 'mssql', host: 'mock-host', database: 'mock-db' },
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([{ name: 'orders' }]);
    expect(probe.readTables).toHaveBeenCalledOnce();
    expect(probe.close).toHaveBeenCalledOnce();
  });

  it('closes a temporary MSSQL probe after readTables rejects', async () => {
    const probe = createRuntimeSource(async () => {
      throw new Error('mock catalog failure');
    });
    vi.spyOn(app.dataSourceManager.factory, 'create').mockReturnValueOnce(probe);

    const response = await app
      .agent()
      .resource('dataSources')
      .readTables({
        values: {
          dataSourceKey: 'mssql-probe-failure',
          dbOptions: { type: 'mssql', host: 'mock-host', database: 'mock-db' },
        },
      });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(probe.readTables).toHaveBeenCalledOnce();
    expect(probe.close).toHaveBeenCalledOnce();
  });

  it('leaves a registered MSSQL datasource open when reading through its saved key', async () => {
    const shared = createRuntimeSource(async () => [{ name: 'customers' }]);
    app.dataSourceManager.dataSources.set('mssql-shared-read', shared);

    const response = await app
      .agent()
      .resource('dataSources')
      .readTables({
        values: { dataSourceKey: 'mssql-shared-read' },
      });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([{ name: 'customers' }]);
    expect(shared.readTables).toHaveBeenCalledOnce();
    expect(shared.close).not.toHaveBeenCalled();

    app.dataSourceManager.dataSources.delete('mssql-shared-read');
  });

  it('persists and deduplicates selections sent to the core loadTables action and reloads them from saved options', async () => {
    const dataSourceKey = 'mssql-direct-load';
    const initialOptions = {
      host: 'mock-host',
      database: 'mock-db',
      schema: 'dbo',
      addAllCollections: false,
      selectedCollections: ['customers'],
    };
    await createDataSourceRecord(app, {
      key: dataSourceKey,
      type: 'mssql',
      displayName: 'MSSQL direct load test',
      enabled: false,
      options: initialOptions,
    });
    const runtime = createSelectionRuntimeSource(initialOptions, ['customers']);
    app.dataSourceManager.dataSources.set(dataSourceKey, runtime.source);
    const plugin = app.pm.get(PluginDataSourceMssqlServer) as PluginDataSourceMssqlServer;
    const sendSyncMessage = vi.spyOn(plugin, 'sendSyncMessage').mockResolvedValue(undefined);

    const response = await app
      .agent()
      .resource('dataSources')
      .loadTables({
        values: { dataSourceKey, tables: ['orders', 'orders'] },
      });

    expect(response.status).toBe(200);
    const saved = await app.db.getRepository('dataSources').findOne({ filterByTk: dataSourceKey });
    expect(saved.get('options').selectedCollections).toEqual(['customers', 'orders']);
    expect(runtime.getCollectionFromSchema).toHaveBeenCalledOnce();
    expect(runtime.defineCollection).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'orders', tableName: 'orders', introspected: true }),
    );
    expect(sendSyncMessage).toHaveBeenCalledWith({
      type: 'selectionChanged',
      dataSourceKey,
      refreshTables: ['orders'],
    });
    expect(runtime.preloadFTSIndexedColumns).toHaveBeenCalledWith('dbo', ['customers', 'orders']);

    const savedOptions = saved.get('options') as MssqlDataSourceOptions;
    const restored = createSelectionRuntimeSource(savedOptions);
    await restored.source.load();

    expect(restored.getTables).not.toHaveBeenCalled();
    expect(restored.getCollectionFromSchema.mock.calls.map(([input]) => input.tableInfo.tableName)).toEqual([
      'customers',
      'orders',
    ]);
    expect(restored.loaded.has('customers')).toBe(true);
    expect(restored.loaded.has('orders')).toBe(true);

    app.dataSourceManager.dataSources.delete(dataSourceKey);
  });

  it('matches rendered host, password and schema templates against the registered datasource settings', async () => {
    const dataSourceKey = 'mssql-templated-config';
    const env = app.environment;
    env.setVariable('MSSQL_PLUGIN_TEST_HOST', 'resolved-host');
    env.setVariable('MSSQL_PLUGIN_TEST_PASSWORD', 'unit-test-placeholder', { isSecret: true });
    env.setVariable('MSSQL_PLUGIN_TEST_SCHEMA', 'resolved-schema');

    try {
      const runtime = await seedSelectedDataSource(
        app,
        dataSourceKey,
        ['customers'],
        ['customers'],
        {
          host: '{{$env.MSSQL_PLUGIN_TEST_HOST}}',
          password: '{{$env.MSSQL_PLUGIN_TEST_PASSWORD}}',
          schema: '{{$env.MSSQL_PLUGIN_TEST_SCHEMA}}',
        },
        { host: 'resolved-host', password: 'unit-test-placeholder', schema: 'resolved-schema' },
      );
      const plugin = app.pm.get(PluginDataSourceMssqlServer) as PluginDataSourceMssqlServer;
      vi.spyOn(plugin, 'sendSyncMessage').mockResolvedValue(undefined);

      const response = await app
        .agent()
        .resource('dataSources')
        .loadTables({
          values: { dataSourceKey, tables: ['orders'] },
        });

      expect(response.status).toBe(200);
      const model = await app.db.getRepository('dataSources').findOne({ filterByTk: dataSourceKey });
      expect(model.get('options').selectedCollections).toEqual(['customers', 'orders']);
      expect(model.get('options')).toMatchObject({
        host: '{{$env.MSSQL_PLUGIN_TEST_HOST}}',
        password: '{{$env.MSSQL_PLUGIN_TEST_PASSWORD}}',
        schema: '{{$env.MSSQL_PLUGIN_TEST_SCHEMA}}',
      });
      expect(runtime.preloadFTSIndexedColumns).toHaveBeenCalledWith('resolved-schema', ['customers', 'orders']);
    } finally {
      env.removeVariable('MSSQL_PLUGIN_TEST_HOST');
      env.removeVariable('MSSQL_PLUGIN_TEST_PASSWORD');
      env.removeVariable('MSSQL_PLUGIN_TEST_SCHEMA');
    }
  });

  it('refreshes a same-name selected collection when a peer receives the loadTables sync event', async () => {
    const dataSourceKey = 'mssql-refresh-selected';
    const runtime = await seedSelectedDataSource(app, dataSourceKey, ['orders']);
    const plugin = app.pm.get(PluginDataSourceMssqlServer) as PluginDataSourceMssqlServer;

    await plugin.handleSyncMessage({ type: 'selectionChanged', dataSourceKey, refreshTables: ['orders'] });

    expect(runtime.getCollectionFromSchema).toHaveBeenCalledOnce();
    expect(runtime.preloadFTSIndexedColumns).toHaveBeenCalledWith('dbo', ['orders']);
    expect(runtime.removeCollection).toHaveBeenCalledWith('orders');
    expect(runtime.defineCollection).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'orders', tableName: 'orders', introspected: true }),
    );
    expect(runtime.loaded.has('orders')).toBe(true);
  });

  it('skips FTS catalog preloading during loadTables and selectionChanged sync when fullTextSearchMode is off', async () => {
    const dataSourceKey = 'mssql-fts-off-selected';
    const runtime = await seedSelectedDataSource(app, dataSourceKey, ['customers'], ['customers'], {
      fullTextSearchMode: 'off',
    });
    const plugin = app.pm.get(PluginDataSourceMssqlServer) as PluginDataSourceMssqlServer;
    vi.spyOn(plugin, 'sendSyncMessage').mockResolvedValue(undefined);

    const response = await app
      .agent()
      .resource('dataSources')
      .loadTables({
        values: { dataSourceKey, tables: ['orders'] },
      });

    expect(response.status).toBe(200);
    await plugin.handleSyncMessage({ type: 'selectionChanged', dataSourceKey, refreshTables: ['orders'] });
    expect(runtime.preloadFTSIndexedColumns).not.toHaveBeenCalled();

    app.dataSourceManager.dataSources.delete(dataSourceKey);
  });

  it('serializes concurrent collection deletions and publishes committed selection state', async () => {
    transactionTrace.length = 0;
    const dataSourceKey = 'mssql-concurrent-delete';
    const runtime = await seedSelectedDataSource(app, dataSourceKey, ['orders', 'customers', 'invoices']);
    const plugin = app.pm.get(PluginDataSourceMssqlServer) as PluginDataSourceMssqlServer;
    const repo = app.db.getRepository('dataSources');
    const syncStates: Array<{ message: unknown; selectedCollections: string[] }> = [];
    const publish = plugin.sendSyncMessage.bind(plugin);
    vi.spyOn(plugin, 'sendSyncMessage').mockImplementation(async (...args) => {
      const model = await repo.findOne({ filterByTk: dataSourceKey });
      syncStates.push({ message: args[0], selectedCollections: model.get('options').selectedCollections });
      await publish(...args);
    });

    const [ordersResponse, customersResponse] = await Promise.all([
      app.agent().resource('dataSources.collections', dataSourceKey).destroy({ filterByTk: 'orders' }),
      app.agent().resource('dataSources.collections', dataSourceKey).destroy({ filterByTk: 'customers' }),
    ]);

    expect(ordersResponse.status).toBe(200);
    expect(customersResponse.status).toBe(200);
    const lockTransactions = transactionTrace.filter((entry) => entry.includes('BEGIN IMMEDIATE'));
    expect(lockTransactions).toHaveLength(2);
    expect(new Set(lockTransactions.map((entry) => entry.split(':')[0])).size).toBe(2);
    const model = await repo.findOne({ filterByTk: dataSourceKey });
    const metadata = await app.db.getRepository('dataSourcesCollections').find({ filter: { dataSourceKey } });
    expect(metadata.map((record) => record.get('name'))).toEqual(['invoices']);
    expect(model.get('options').selectedCollections).toEqual(['invoices']);
    expect([...runtime.loaded.keys()]).toEqual(['invoices']);
    expect(syncStates).toHaveLength(2);
    const committedSelections = syncStates.map((state) => [...state.selectedCollections].sort());
    expect(committedSelections).toContainEqual(['invoices']);
    for (const state of syncStates) {
      expect(state.message).toEqual({ type: 'selectionChanged', dataSourceKey });
      expect(
        [['customers', 'invoices'], ['invoices', 'orders'], ['invoices']].map((snapshot) => [...snapshot].sort()),
      ).toContainEqual([...state.selectedCollections].sort());
    }
  });

  it('completes a deletion when another saved selected table is no longer available', async () => {
    const dataSourceKey = 'mssql-delete-stale-selection';
    const runtime = await seedSelectedDataSource(app, dataSourceKey, ['orders', 'stale_table'], ['orders']);
    runtime.source.prepareTables = vi.fn(async () => {
      throw new Error('stale table is unavailable');
    });
    const plugin = app.pm.get(PluginDataSourceMssqlServer) as PluginDataSourceMssqlServer;
    const sendSyncMessage = vi.spyOn(plugin, 'sendSyncMessage').mockResolvedValue(undefined);

    const response = await app.agent().resource('dataSources.collections', dataSourceKey).destroy({
      filterByTk: 'orders',
    });

    expect(response.status).toBe(200);
    const model = await app.db.getRepository('dataSources').findOne({ filterByTk: dataSourceKey });
    expect(model.get('options').selectedCollections).toEqual(['stale_table']);
    expect(runtime.loaded.size).toBe(0);
    expect(sendSyncMessage).toHaveBeenCalledWith({ type: 'selectionChanged', dataSourceKey });
  });

  it('deletes a batch of selected collection names through the core action', async () => {
    const dataSourceKey = 'mssql-delete-batch';
    const runtime = await seedSelectedDataSource(app, dataSourceKey, ['orders', 'customers', 'invoices']);
    const plugin = app.pm.get(PluginDataSourceMssqlServer) as PluginDataSourceMssqlServer;
    const sendSyncMessage = vi.spyOn(plugin, 'sendSyncMessage').mockResolvedValue(undefined);

    const response = await app
      .agent()
      .resource('dataSources.collections', dataSourceKey)
      .destroy({
        filterByTk: ['orders', 'customers'],
      });

    expect(response.status).toBe(200);
    const model = await app.db.getRepository('dataSources').findOne({ filterByTk: dataSourceKey });
    expect(model.get('options').selectedCollections).toEqual(['invoices']);
    const metadata = await app.db.getRepository('dataSourcesCollections').find({ filter: { dataSourceKey } });
    expect(metadata.map((record) => record.get('name'))).toEqual(['invoices']);
    expect([...runtime.loaded.keys()]).toEqual(['invoices']);
    expect(sendSyncMessage).toHaveBeenCalledWith({ type: 'selectionChanged', dataSourceKey });
  });

  it('rolls back stored selection, metadata and runtime state when collection deletion fails', async () => {
    const dataSourceKey = 'mssql-delete-rollback';
    const runtime = await seedSelectedDataSource(app, dataSourceKey, ['orders', 'invoices']);
    const plugin = app.pm.get(PluginDataSourceMssqlServer) as PluginDataSourceMssqlServer;
    const sendSyncMessage = vi.spyOn(plugin, 'sendSyncMessage');
    const collections = app.db.getRepository('dataSourcesCollections');
    vi.spyOn(collections, 'destroy').mockRejectedValueOnce(new Error('injected metadata deletion failure'));

    const response = await app.agent().resource('dataSources.collections', dataSourceKey).destroy({
      filterByTk: 'orders',
    });

    expect(response.status).toBe(500);
    const model = await app.db.getRepository('dataSources').findOne({ filterByTk: dataSourceKey });
    expect(model.get('options').selectedCollections).toEqual(['orders', 'invoices']);
    const metadata = await collections.find({ filter: { dataSourceKey } });
    expect(metadata.map((record) => record.get('name')).sort()).toEqual(['invoices', 'orders']);
    expect([...runtime.loaded.keys()].sort()).toEqual(['invoices', 'orders']);
    expect(runtime.removeCollection).not.toHaveBeenCalled();
    expect(sendSyncMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty filterByTk list', 'mssql-delete-empty', { filterByTk: [] }, true],
    [
      'an ACL filter that excludes the requested collection',
      'mssql-delete-acl-filter',
      { filterByTk: 'orders', filter: { name: 'invoices' } },
      false,
    ],
  ])('does not delete collections for %s', async (_description, dataSourceKey, params, requestRejected) => {
    const runtime = await seedSelectedDataSource(app, dataSourceKey, ['orders', 'invoices']);
    const plugin = app.pm.get(PluginDataSourceMssqlServer) as PluginDataSourceMssqlServer;
    const sendSyncMessage = vi.spyOn(plugin, 'sendSyncMessage');

    const response = await app.agent().resource('dataSources.collections', dataSourceKey).destroy(params);

    if (requestRejected) {
      expect(response.status).toBeGreaterThanOrEqual(400);
    } else {
      expect(response.status).toBe(200);
    }
    const model = await app.db.getRepository('dataSources').findOne({ filterByTk: dataSourceKey });
    expect(model.get('options').selectedCollections).toEqual(['orders', 'invoices']);
    const metadata = await app.db.getRepository('dataSourcesCollections').find({ filter: { dataSourceKey } });
    expect(metadata.map((record) => record.get('name')).sort()).toEqual(['invoices', 'orders']);
    expect([...runtime.loaded.keys()].sort()).toEqual(['invoices', 'orders']);
    if (requestRejected) {
      expect(sendSyncMessage).not.toHaveBeenCalled();
    } else {
      expect(sendSyncMessage).toHaveBeenCalledWith({ type: 'selectionChanged', dataSourceKey });
    }
  });

  it('closes tracked MSSQL datasource pools on dataSources:destroy and peer dataSourceRemoved sync messages', async () => {
    const dataSourceKey = 'mssql-destroy-cleanup';
    const runtime = await seedSelectedDataSource(app, dataSourceKey, ['orders']);
    const closeSpy = vi.spyOn(runtime.source, 'close');
    const plugin = app.pm.get(PluginDataSourceMssqlServer) as PluginDataSourceMssqlServer;
    const sendSyncMessage = vi.spyOn(plugin, 'sendSyncMessage').mockResolvedValue(undefined);

    // Register via trackedSources just as afterAddDataSource does on load.
    (plugin as unknown as { trackedSources: Map<string, MssqlExternalDataSource> }).trackedSources.set(
      dataSourceKey,
      runtime.source,
    );

    const response = await app.agent().resource('dataSources').destroy({
      filterByTk: dataSourceKey,
    });

    expect(response.status).toBe(200);
    expect(closeSpy).toHaveBeenCalledOnce();
    expect(runtime.source.collectionManager.db.close).toHaveBeenCalledOnce();
    expect(sendSyncMessage).toHaveBeenCalledWith(
      { type: 'dataSourceRemoved', dataSourceKey },
      expect.objectContaining({ transaction: expect.anything() }),
    );

    // Peer node receives dataSourceRemoved after core already removed the key from dataSources.
    const peerSource = createRuntimeSource(async () => []);
    (plugin as unknown as { trackedSources: Map<string, MssqlExternalDataSource> }).trackedSources.set(
      'mssql-peer-removed',
      peerSource,
    );
    await plugin.handleSyncMessage({ type: 'dataSourceRemoved', dataSourceKey: 'mssql-peer-removed' });
    expect(peerSource.close).toHaveBeenCalledOnce();
  });

  it('preserves FTS index cache when peer reconcileSelection refreshes one or multiple selected tables', async () => {
    const dataSourceKey = 'mssql-peer-fts-sync';
    const runtime = await seedSelectedDataSource(app, dataSourceKey, ['orders', 'customers']);
    const plugin = app.pm.get(PluginDataSourceMssqlServer) as PluginDataSourceMssqlServer;

    const fakeDb = {
      options: { schema: 'dbo' },
      fieldTypes: new Map(),
      logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      sequelize: {
        escape: (v: unknown) => `'${String(v).replace(/'/g, "''")}'`,
        query: vi.fn(async (sql: string) => {
          if (sql.includes('sys.fulltext_index_columns')) {
            return [
              { table_name: 'orders', column_name: 'OrderTitle' },
              { table_name: 'customers', column_name: 'FullName' },
            ];
          }
          if (sql.includes('sys.default_constraints')) {
            return [
              {
                table_name: 'orders',
                object_type: 'U ',
                column_name: 'OrderTitle',
                data_type: 'nvarchar',
                max_length: 200,
                is_nullable: true,
                is_identity: false,
                default_value: null,
                column_comment: null,
              },
              {
                table_name: 'customers',
                object_type: 'U ',
                column_name: 'FullName',
                data_type: 'nvarchar',
                max_length: 200,
                is_nullable: true,
                is_identity: false,
                default_value: null,
                column_comment: null,
              },
            ];
          }
          return [];
        }),
        getQueryInterface: () => ({
          describeTable: vi.fn(async () => ({
            OrderTitle: {
              type: 'NVARCHAR(100)',
              allowNull: true,
              defaultValue: null,
              primaryKey: false,
              autoIncrement: false,
            },
          })),
        }),
      },
    };
    const realIntrospector = new MssqlIntrospector({ db: fakeDb as never });
    (runtime.source as unknown as { introspector: MssqlIntrospector }).introspector = realIntrospector;

    // Single-table refresh (unpreparedTargets.length === 1) must not wipe FTS cache.
    await plugin.handleSyncMessage({ type: 'selectionChanged', dataSourceKey, refreshTables: ['orders'] });
    expect(realIntrospector.hasFTSIndex('orders', 'OrderTitle')).toBe(true);
    expect(realIntrospector.hasFTSIndex('customers', 'FullName')).toBe(true);

    // Multi-table refresh (unpreparedTargets.length > 1) must also keep FTS cache populated.
    await plugin.handleSyncMessage({
      type: 'selectionChanged',
      dataSourceKey,
      refreshTables: ['orders', 'customers'],
    });
    expect(realIntrospector.hasFTSIndex('orders', 'OrderTitle')).toBe(true);
    expect(realIntrospector.hasFTSIndex('customers', 'FullName')).toBe(true);
  });

  it('renders environment variable templates in dbOptions during temporary readTables probes', async () => {
    const env = app.environment;
    env.setVariable('MSSQL_READ_HOST', 'resolved-read-host');
    env.setVariable('MSSQL_READ_PASSWORD', 'resolved-read-secret', { isSecret: true });
    env.setVariable('MSSQL_READ_SCHEMA', 'resolved-read-schema');

    try {
      const probe = createRuntimeSource(async () => [{ name: 'orders' }]);
      const createSpy = vi.spyOn(app.dataSourceManager.factory, 'create').mockReturnValueOnce(probe);

      const response = await app
        .agent()
        .resource('dataSources')
        .readTables({
          values: {
            dataSourceKey: 'mssql-probe-env-template',
            dbOptions: {
              type: 'mssql',
              host: '{{$env.MSSQL_READ_HOST}}',
              password: '{{$env.MSSQL_READ_PASSWORD}}',
              schema: '{{$env.MSSQL_READ_SCHEMA}}',
              database: 'mock-db',
            },
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([{ name: 'orders' }]);
      expect(createSpy).toHaveBeenCalledWith(
        'mssql',
        expect.objectContaining({
          name: 'mssql-probe-env-template',
          host: 'resolved-read-host',
          password: 'resolved-read-secret',
          schema: 'resolved-read-schema',
          database: 'mock-db',
        }),
      );
      expect(probe.close).toHaveBeenCalledOnce();
    } finally {
      env.removeVariable('MSSQL_READ_HOST');
      env.removeVariable('MSSQL_READ_PASSWORD');
      env.removeVariable('MSSQL_READ_SCHEMA');
    }
  });

  it('broadcasts tablesLoaded in addAllCollections mode and syncs loaded tables on peer nodes', async () => {
    const dataSourceKey = 'mssql-all-tables-sync';
    const initialOptions: MssqlDataSourceOptions = {
      host: 'mock-host',
      database: 'mock-db',
      schema: 'dbo',
      addAllCollections: true,
    };
    await createDataSourceRecord(app, {
      key: dataSourceKey,
      type: 'mssql',
      displayName: 'MSSQL all tables sync test',
      enabled: false,
      options: initialOptions,
    });

    try {
      const primaryRuntime = createSelectionRuntimeSource(initialOptions, ['customers']);
      app.dataSourceManager.dataSources.set(dataSourceKey, primaryRuntime.source);
      const plugin = app.pm.get(PluginDataSourceMssqlServer) as PluginDataSourceMssqlServer;
      const sendSyncMessage = vi.spyOn(plugin, 'sendSyncMessage').mockResolvedValue(undefined);

      const response = await app
        .agent()
        .resource('dataSources')
        .loadTables({
          values: { dataSourceKey, tables: ['orders', 'orders'] },
        });

      expect(response.status).toBe(200);
      expect(primaryRuntime.loaded.has('orders')).toBe(true);
      expect(sendSyncMessage).toHaveBeenCalledWith({
        type: 'tablesLoaded',
        dataSourceKey,
        tableNames: ['orders'],
      });

      // Simulate a peer node whose runtime initially has customers + an older orders definition.
      const peerRuntime = createSelectionRuntimeSource(initialOptions, ['customers', 'orders']);
      app.dataSourceManager.dataSources.set(dataSourceKey, peerRuntime.source);

      await plugin.handleSyncMessage({
        type: 'tablesLoaded',
        dataSourceKey,
        tableNames: ['orders'],
      });

      expect(peerRuntime.getCollectionFromSchema).toHaveBeenCalledOnce();
      expect(peerRuntime.removeCollection).toHaveBeenCalledWith('orders');
      expect(peerRuntime.defineCollection).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'orders', tableName: 'orders', introspected: true }),
      );
      expect(peerRuntime.loaded.has('orders')).toBe(true);
    } finally {
      app.dataSourceManager.dataSources.delete(dataSourceKey);
    }
  });

  it('unloads introspected collections, cleans orphan field metadata, and broadcasts removal in addAllCollections mode', async () => {
    const dataSourceKey = 'mssql-delete-default-mode';
    const initialOptions: MssqlDataSourceOptions = {
      host: 'mock-host',
      database: 'mock-db',
      schema: 'dbo',
      addAllCollections: true,
    };
    await createDataSourceRecord(app, {
      key: dataSourceKey,
      type: 'mssql',
      displayName: 'MSSQL default mode delete test',
      enabled: false,
      options: initialOptions,
    });

    try {
      // Simulate freshly introspected collections with NO rows in dataSourcesCollections, plus an applied field row.
      const runtime = createSelectionRuntimeSource(initialOptions, ['orders', 'customers']);
      app.dataSourceManager.dataSources.set(dataSourceKey, runtime.source);
      await app.db.getRepository('dataSourcesFields').create({
        values: {
          key: 'f_orders_customer_ref',
          name: 'customerRef',
          type: 'belongsTo',
          target: 'customers',
          foreignKey: 'customerId',
          targetKey: 'id',
          collectionName: 'orders',
          dataSourceKey,
        },
        hooks: false,
      });

      const dsmPlugin = app.pm.get('data-source-manager') as { sendSyncMessage: (...args: unknown[]) => Promise<void> };
      const dsmSyncSpy = vi.spyOn(dsmPlugin, 'sendSyncMessage').mockResolvedValue(undefined);

      const response = await app
        .agent()
        .resource('dataSources.collections', dataSourceKey)
        .destroy({
          filterByTk: ['orders'],
        });

      expect(response.status).toBe(200);
      expect(runtime.removeCollection).toHaveBeenCalledWith('orders');
      expect([...runtime.loaded.keys()]).toEqual(['customers']);
      expect(dsmSyncSpy).toHaveBeenCalledWith({
        type: 'removeDataSourceCollection',
        dataSourceKey,
        collectionName: 'orders',
      });

      const remainingFields = await app.db.getRepository('dataSourcesFields').find({
        filter: { dataSourceKey, collectionName: 'orders' },
      });
      expect(remainingFields).toHaveLength(0);
    } finally {
      app.dataSourceManager.dataSources.delete(dataSourceKey);
    }
  });

  it('matches in-memory introspected collections when deleting with an ACL filter and no dataSourcesCollections rows', async () => {
    const dataSourceKey = 'mssql-delete-inmemory-acl';
    // Pass loadedCollections = [] so NO rows exist in dataSourcesCollections, then populate runtime.loaded in memory.
    const runtime = await seedSelectedDataSource(app, dataSourceKey, ['orders', 'invoices'], []);
    const ordersInit = createSelectionRuntimeSource({ addAllCollections: false }, ['orders', 'invoices']);
    for (const [name, col] of ordersInit.loaded.entries()) {
      runtime.loaded.set(name, col);
    }
    const plugin = app.pm.get(PluginDataSourceMssqlServer) as PluginDataSourceMssqlServer;
    vi.spyOn(plugin, 'sendSyncMessage').mockResolvedValue(undefined);

    const response = await app
      .agent()
      .resource('dataSources.collections', dataSourceKey)
      .destroy({
        filterByTk: 'orders',
        filter: { name: 'orders' },
      });

    expect(response.status).toBe(200);
    const model = await app.db.getRepository('dataSources').findOne({ filterByTk: dataSourceKey });
    expect(model.get('options').selectedCollections).toEqual(['invoices']);
    expect([...runtime.loaded.keys()]).toEqual(['invoices']);
  });

  it('restores the existing live collection when loadTables defineCollection throws and keeps repository=mssql-repo', async () => {
    const dataSourceKey = 'mssql-loadtables-rollback';
    const initialOptions: MssqlDataSourceOptions = {
      host: 'mock-host',
      database: 'mock-db',
      schema: 'dbo',
      addAllCollections: true,
    };
    await createDataSourceRecord(app, {
      key: dataSourceKey,
      type: 'mssql',
      displayName: 'MSSQL loadTables rollback test',
      enabled: false,
      options: initialOptions,
    });
    await app.db.getRepository('dataSourcesCollections').create({
      values: {
        name: 'orders',
        dataSourceKey,
        options: { title: 'Custom Orders', repository: 'Repository' },
      },
      hooks: false,
    });

    try {
      const runtime = createSelectionRuntimeSource(initialOptions, ['orders']);
      app.dataSourceManager.dataSources.set(dataSourceKey, runtime.source);

      // First verify repository='mssql-repo' is enforced even when localData stored repository='Repository'.
      const okResponse = await app
        .agent()
        .resource('dataSources')
        .loadTables({
          values: { dataSourceKey, tables: ['orders'] },
        });
      expect(okResponse.status).toBe(200);
      expect(runtime.loaded.get('orders')?.options).toMatchObject({
        name: 'orders',
        title: 'Custom Orders',
        repository: 'mssql-repo',
        introspected: true,
      });

      // Now inject a defineCollection failure on the new definition and confirm the previous live collection survives.
      const baseDefine = runtime.defineCollection.getMockImplementation();
      let failedOnce = false;
      runtime.defineCollection.mockImplementationOnce((col) => {
        if (!failedOnce) {
          failedOnce = true;
          throw new Error('broken association target');
        }
        baseDefine?.(col);
      });

      const failResponse = await app
        .agent()
        .resource('dataSources')
        .loadTables({
          values: { dataSourceKey, tables: ['orders'] },
        });
      expect(failResponse.status).toBe(500);
      expect(runtime.loaded.has('orders')).toBe(true);
      expect(runtime.loaded.get('orders')?.options).toMatchObject({
        name: 'orders',
        title: 'Custom Orders',
      });
    } finally {
      app.dataSourceManager.dataSources.delete(dataSourceKey);
    }
  });
});
