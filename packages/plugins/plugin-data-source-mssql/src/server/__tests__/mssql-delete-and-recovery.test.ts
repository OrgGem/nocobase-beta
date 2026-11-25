// SPDX-License-Identifier: Apache-2.0

import { Database } from '@nocobase/database';
import { createMockServer, MockServer } from '@nocobase/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MssqlCollectionManager } from '../data-source/MssqlCollectionManager';
import { MssqlExternalDataSource, type MssqlDataSourceOptions } from '../data-source/MssqlExternalDataSource';
import { PluginDataSourceMssqlServer } from '../plugin';

function createProbeSource(tables: Array<{ name: string }>) {
  return Object.assign(Object.create(MssqlExternalDataSource.prototype) as MssqlExternalDataSource, {
    readTables: vi.fn().mockResolvedValue(tables),
    close: vi.fn().mockResolvedValue(undefined),
  });
}

async function seedDataSourceRow(
  app: MockServer,
  values: {
    key: string;
    displayName: string;
    options: MssqlDataSourceOptions;
    enabled?: boolean;
  },
) {
  const DataSourceModel = app.db.getModel('dataSources') as unknown as {
    prototype: { loadIntoApplication: () => Promise<void> };
  };
  const testConnection = vi.spyOn(MssqlExternalDataSource, 'testConnection').mockResolvedValue(true);
  const loadIntoApplication = vi.spyOn(DataSourceModel.prototype, 'loadIntoApplication').mockResolvedValue(undefined);
  try {
    return await app.db.getRepository('dataSources').create({
      values: {
        type: 'mssql',
        enabled: true,
        ...values,
      },
    });
  } finally {
    loadIntoApplication.mockRestore();
    testConnection.mockRestore();
  }
}

describe('MSSQL datasource delete, failed-connection recovery, and collection metadata updates', () => {
  let app: MockServer;
  let databaseDirectory: string;

  beforeAll(async () => {
    databaseDirectory = await mkdtemp(join(tmpdir(), 'mssql-delete-recovery-tests-'));
    app = await createMockServer({
      database: {
        dialect: 'sqlite',
        storage: join(databaseDirectory, 'main.sqlite'),
        logging: false,
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

  it('deletes a failed-connection MSSQL datasource even when ACL scopes, role actions, and collection metadata exist', async () => {
    const key = 'd_failed_with_acl';
    await seedDataSourceRow(app, {
      key,
      displayName: 'Broken MSSQL',
      options: {
        host: 'unreachable.mssql.local',
        port: 1433,
        database: 'broken_db',
        username: 'sa',
        password: 'secret',
      },
    });

    // Simulate failed startup state: not registered in dataSourceManager.dataSources, marked loading-failed.
    app.dataSourceManager.dataSources.delete(key);
    const dsmPlugin = app.pm.get('data-source-manager') as {
      dataSourceStatus: Record<string, string>;
      dataSourceErrors: Record<string, Error>;
    };
    dsmPlugin.dataSourceStatus[key] = 'loading-failed';
    dsmPlugin.dataSourceErrors[key] = new Error('Connection refused');

    await app.db.getRepository('dataSourcesCollections').create({
      values: { dataSourceKey: key, name: 'orders', title: 'Orders' },
      hooks: false,
    });
    await app.db.getRepository('dataSourcesFields').create({
      values: { dataSourceKey: key, collectionName: 'orders', name: 'order_no', type: 'string' },
      hooks: false,
    });
    await app.db.getRepository('dataSourcesRoles').create({
      values: { dataSourceKey: key, roleName: 'member' },
      hooks: false,
    });
    const scope = await app.db.getRepository('dataSourcesRolesResourcesScopes').findOne({
      filter: { dataSourceKey: key, key: 'all' },
    });
    const roleResource = await app.db.getRepository('dataSourcesRolesResources').create({
      values: { id: 91001, dataSourceKey: key, roleName: 'member', name: 'orders', usingActionsConfig: true },
      hooks: false,
    });
    await app.db.getRepository('dataSourcesRolesResourcesActions').create({
      values: {
        id: 92001,
        rolesResourceId: 91001,
        name: 'view',
        fields: ['order_no'],
        scopeId: scope?.get('id'),
      },
      hooks: false,
    });

    const response = await app.agent().resource('dataSources').destroy({ filterByTk: key });
    expect(response.status).toBe(200);

    const remainingRow = await app.db.getRepository('dataSources').findOne({ filterByTk: key });
    expect(remainingRow).toBeNull();
    expect(dsmPlugin.dataSourceStatus[key]).toBeUndefined();
    expect(dsmPlugin.dataSourceErrors[key]).toBeUndefined();

    const remainingCollections = await app.db.getRepository('dataSourcesCollections').count({
      filter: { dataSourceKey: key },
    });
    const remainingRoleResources = await app.db.getRepository('dataSourcesRolesResources').count({
      filter: { dataSourceKey: key },
    });
    const remainingActions = await app.db.getRepository('dataSourcesRolesResourcesActions').count({
      filter: { rolesResourceId: roleResource.get('id') },
    });
    expect(remainingCollections).toBe(0);
    expect(remainingRoleResources).toBe(0);
    expect(remainingActions).toBe(0);
  });

  it('does not hang dataSources:destroy when closing a broken MSSQL pool never resolves', async () => {
    const key = 'd_hung_close';
    await seedDataSourceRow(app, {
      key,
      displayName: 'Hung MSSQL Pool',
      options: {
        host: 'dead-socket.mssql.local',
        port: 1433,
        database: 'erp',
        username: 'sa',
        password: 'secret',
      },
    });

    const hungClose = vi.fn(() => new Promise<void>(() => {}));
    const hungSource = Object.assign(Object.create(MssqlExternalDataSource.prototype) as MssqlExternalDataSource, {
      options: { name: key, host: 'dead-socket.mssql.local', database: 'erp' },
      close: hungClose,
    });
    app.dataSourceManager.dataSources.set(key, hungSource);

    const startedAt = Date.now();
    const response = await app.agent().resource('dataSources').destroy({ filterByTk: key });
    const elapsedMs = Date.now() - startedAt;

    expect(response.status).toBe(200);
    expect(hungClose).toHaveBeenCalledOnce();
    expect(app.dataSourceManager.get(key)).toBeUndefined();
    expect(elapsedMs).toBeLessThan(4500);
  });

  it('probes stored options for readTables and returns a clean 400 instead of 500 when updating an offline loading-failed datasource', async () => {
    const key = 'd_offline_recover';
    await seedDataSourceRow(app, {
      key,
      displayName: 'Offline MSSQL',
      options: {
        host: 'recover.mssql.local',
        port: 1433,
        database: 'sales',
        username: 'sa',
        password: 'secret',
        addAllCollections: false,
        selectedCollections: ['orders'],
      },
    });
    app.dataSourceManager.dataSources.delete(key);
    const dsmPlugin = app.pm.get('data-source-manager') as {
      dataSourceStatus: Record<string, string>;
      dataSourceErrors: Record<string, Error>;
    };
    dsmPlugin.dataSourceStatus[key] = 'loading-failed';
    dsmPlugin.dataSourceErrors[key] = new Error('Login timeout expired');

    const probe = createProbeSource([{ name: 'orders' }, { name: 'customers' }]);
    vi.spyOn(app.dataSourceManager.factory, 'create').mockReturnValueOnce(probe);

    const readTablesRes = await app
      .agent()
      .resource('dataSources')
      .readTables({
        values: { dataSourceKey: key },
      });
    expect(readTablesRes.status).toBe(200);
    expect(readTablesRes.body.data).toEqual([{ name: 'orders' }, { name: 'customers' }]);
    expect(probe.close).toHaveBeenCalledOnce();

    // Updating without changing options while server remains unreachable returns 400 (not 500 setLogger crash).
    const DataSourceModel = app.db.getModel('dataSources') as unknown as {
      prototype: { loadIntoApplication: () => Promise<void> };
    };
    vi.spyOn(DataSourceModel.prototype, 'loadIntoApplication').mockResolvedValueOnce(undefined);

    const updateRes = await app
      .agent()
      .resource('dataSources')
      .update({
        filterByTk: key,
        values: {
          displayName: 'Still Offline',
          options: {
            host: 'recover.mssql.local',
            port: 1433,
            database: 'sales',
            username: 'sa',
            password: 'secret',
            addAllCollections: false,
            selectedCollections: ['orders'],
          },
        },
      });
    expect(updateRes.status).toBe(400);
  });

  it('preserves introspected fields, field types, repository, and view flags when collection.updateOptions runs', async () => {
    const db = new Database({
      dialect: 'sqlite',
      storage: ':memory:',
      logging: false,
    });
    try {
      const manager = new MssqlCollectionManager({ database: db });
      const orders = manager.defineCollection({
        name: 'orders',
        title: 'orders',
        tableName: 'Orders',
        schema: 'dbo',
        introspected: true,
        repository: 'mssql-repo',
        simplePaginate: true,
        fields: [
          { name: 'id', field: 'OrderID', type: 'integer', primaryKey: true, interface: 'integer' },
          {
            name: 'orderNumber',
            field: 'OrderNumber',
            type: 'string',
            interface: 'input',
            uiSchema: { title: 'OrderNumber', 'x-component': 'Input' },
          },
        ],
      });

      // Simulate DataSourcesCollectionModel.load() with a partial field override (missing `type`) and updated collection title/titleField.
      orders.updateOptions({
        name: 'orders',
        title: 'Sales Orders',
        titleField: 'orderNumber',
        fields: [
          {
            name: 'orderNumber',
            uiSchema: { title: 'Order Number' },
          } as never,
        ],
      });

      expect(orders.options.title).toBe('Sales Orders');
      expect(orders.options.titleField).toBe('orderNumber');
      expect(orders.options.repository).toBe('mssql-repo');
      expect(orders.options.tableName).toBe('Orders');
      expect(orders.options.fields).toHaveLength(2);
      const updatedField = orders.getField('orderNumber');
      expect(updatedField?.options.type).toBe('string');
      expect(updatedField?.options.field).toBe('OrderNumber');
      expect(updatedField?.options.uiSchema).toMatchObject({
        title: 'Order Number',
        'x-component': 'Input',
      });

      const viewCol = manager.defineCollection({
        name: 'v_orders',
        tableName: 'v_orders',
        schema: 'dbo',
        view: true,
        viewName: 'v_orders',
        template: 'view',
        introspected: true,
        repository: 'mssql-repo',
        fields: [{ name: 'id', type: 'integer', interface: 'integer' }],
      });
      viewCol.updateOptions({
        name: 'v_orders',
        title: 'Order Summary View',
        filterTargetKey: ['id'],
        fields: [],
      });
      expect(viewCol.options.view).toBe(true);
      expect(viewCol.options.template).toBe('view');
      expect(viewCol.options.repository).toBe('mssql-repo');
      expect(viewCol.getFields()).toHaveLength(1);
    } finally {
      await db.close();
    }
  });
});
