// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { createMockClient } from '@nocobase/client-v2';
import { FlowEngineProvider } from '@nocobase/flow-engine';
import NativeManager from '@nocobase/plugin-data-source-manager/client-v2';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Form } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Plugin from '../plugin';
import { MssqlLoadTables } from '../MssqlLoadTables';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('MSSQL client-v2 plugin edit drawer, normalization, and table loading', () => {
  it('mounts SettingsForm synchronously without React.Suspense and normalizes edited options cleanly', async () => {
    const app = createMockClient();
    await app.pm.add(NativeManager);
    const manager = app.pm.get(NativeManager);
    await new Plugin({}, app).load();

    const mssqlType = manager.getType('mssql');
    expect(mssqlType).toBeDefined();
    expect(mssqlType?.allowCollectionCreate).toBe(true);
    expect(mssqlType?.AddCollection).toBe(MssqlLoadTables);
    if (!mssqlType?.SettingsForm || !mssqlType.normalizeValues) {
      throw new Error('Expected SettingsForm and normalizeValues to be registered');
    }

    const SettingsForm = mssqlType.SettingsForm;
    const normalizeValues = mssqlType.normalizeValues;
    const existingRecord = {
      key: 'd_erp_mssql',
      displayName: 'ERP SQL Server',
      type: 'mssql',
      options: {
        host: '10.0.0.12',
        port: 1433,
        database: 'ERP',
        username: 'sa',
        password: 'secret',
        addAllCollections: false,
        selectedCollections: ['Orders', 'Customers'],
        dialectOptions: { options: { encrypt: false } },
        pool: { max: 8 },
      },
    };

    let formInstance!: ReturnType<typeof Form.useForm>[0];
    function EditDrawerWithoutSuspense() {
      const [form] = Form.useForm();
      formInstance = form;
      return (
        <Form form={form} initialValues={existingRecord}>
          <SettingsForm
            mode="edit"
            type={mssqlType}
            initialValues={existingRecord}
            loadCollections={vi.fn().mockResolvedValue([{ name: 'Orders' }, { name: 'Customers' }])}
          />
        </Form>
      );
    }

    // Must render synchronously with NO <React.Suspense> ancestor, matching DataSourceForm in ctx.viewer.drawer().
    render(
      <FlowEngineProvider engine={app.flowEngine}>
        <EditDrawerWithoutSuspense />
      </FlowEngineProvider>,
    );

    expect(screen.getByDisplayValue('10.0.0.12')).toBeTruthy();
    await waitFor(() => expect(formInstance.getFieldValue('collections')).toEqual(['Orders', 'Customers']));

    const validatedSelective = await formInstance.validateFields();
    const normalizedSelective = normalizeValues(validatedSelective);
    expect(normalizedSelective.options).toMatchObject({
      host: '10.0.0.12',
      port: 1433,
      database: 'ERP',
      username: 'sa',
      password: 'secret',
      addAllCollections: false,
      selectedCollections: ['Orders', 'Customers'],
      dialectOptions: { options: { encrypt: false } },
      pool: { max: 8 },
    });

    // Switching back to Load all collections must remove stale selectedCollections.
    fireEvent.click(screen.getByLabelText('Load all collections'));
    const validatedAll = await formInstance.validateFields();
    const normalizedAll = normalizeValues(validatedAll);
    expect(normalizedAll.options.addAllCollections).toBe(true);
    expect(normalizedAll.options.selectedCollections).toBeUndefined();
    expect(normalizedAll.collections).toBeUndefined();
  });

  it('restricts createFieldInterfaces to supported relation interfaces for tables and views', async () => {
    const app = createMockClient();
    await app.pm.add(NativeManager, { name: 'data-source-manager' });
    const manager = app.pm.get<NativeManager>('data-source-manager');
    await new Plugin({}, app).load();

    const mssqlType = manager.getType('mssql');
    const resolveFilter = mssqlType?.createFieldInterfaces;
    expect(typeof resolveFilter).toBe('function');
    if (typeof resolveFilter === 'function') {
      expect(resolveFilter({ collection: { name: 'Orders', template: 'general' } })).toEqual({
        groups: ['relation'],
        exclude: ['o2o', 'subTable', 'linkTo'],
      });
      expect(resolveFilter({ collection: { name: 'v_Orders', view: true, template: 'view' } })).toEqual({
        include: ['m2o'],
      });
    }
  });

  it('loads unselected SQL Server tables via MssqlLoadTables on the Configure Collections page', async () => {
    const app = createMockClient();
    const message = { error: vi.fn(), success: vi.fn(), warning: vi.fn() };
    app.flowEngine.context.defineProperty('message', { value: message });

    const reload = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(app.flowEngine.dataSourceManager, 'getDataSource').mockReturnValue({
      reload,
      collectionManager: {
        getCollections: () => [{ name: 'orders', options: { tableName: 'Orders' } }],
      },
    } as never);

    app.apiMock.onPost('dataSources:readTables').reply(200, {
      data: [{ name: 'Orders' }, { name: 'Invoices' }],
    });
    app.apiMock.onPost('dataSources:loadTables').reply(200, { data: {} });

    const onSubmitted = vi.fn();
    render(
      <FlowEngineProvider engine={app.flowEngine}>
        <MssqlLoadTables dataSourceKey="d_erp" onSubmitted={onSubmitted} />
      </FlowEngineProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Load tables' }));
    await waitFor(() => expect(app.apiMock.history.post).toHaveLength(1));
    expect(JSON.parse(app.apiMock.history.post[0].data)).toEqual({ dataSourceKey: 'd_erp' });

    const selector = await screen.findByRole('combobox', { name: 'Select tables to load' });
    fireEvent.mouseDown(selector);
    const invoiceOption = await screen.findByTitle('Invoices');
    expect(screen.queryByTitle('Orders')).toBeNull();
    fireEvent.click(invoiceOption);

    fireEvent.click(screen.getByRole('button', { name: /OK/i }));
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledOnce());
    expect(JSON.parse(app.apiMock.history.post[1].data)).toEqual({
      dataSourceKey: 'd_erp',
      tables: ['Invoices'],
    });
    expect(reload).toHaveBeenCalledOnce();
    expect(message.success).toHaveBeenCalledOnce();
  });
});
