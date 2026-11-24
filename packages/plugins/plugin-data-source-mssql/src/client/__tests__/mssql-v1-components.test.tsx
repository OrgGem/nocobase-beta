// SPDX-License-Identifier: Apache-2.0

import { createForm } from '@formily/core';
import { FormProvider } from '@formily/react';
import { Checkbox, FormItem, Input, InputNumber, Password, SchemaComponentOptions } from '@nocobase/client';
import PluginDataSourceManagerClient from '@nocobase/plugin-data-source-manager/client';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginDataSourceMssqlClient } from '../index';
import { MssqlConfigForm, normalizeLoadedCollectionsForV1 } from '../components/MssqlConfigForm';
import { extractBulkSelectedNames } from '../components/MssqlDeleteCollection';

afterEach(cleanup);

describe('MSSQL legacy client v1 components', () => {
  it('binds MssqlConfigForm fields into Formily form.values so v1 Test Connection and Submit receive options', () => {
    const form = createForm({
      initialValues: {
        type: 'mssql',
        key: 'd_mssql_v1',
      },
    });

    const CollectionsTable = () => <div data-testid="v1-collections-table" />;
    const Text = (props: { value?: React.ReactNode }) => <span>{props.value}</span>;
    const createCollectionsSchema = vi.fn(() => ({
      type: 'array',
      'x-component': 'CollectionsTable',
    }));

    render(
      <FormProvider form={form}>
        <SchemaComponentOptions components={{ FormItem, Input, InputNumber, Password, Checkbox }}>
          <MssqlConfigForm
            from="create"
            loadCollections={vi.fn()}
            CollectionsTableField={() => ({
              CollectionsTable,
              Text,
              addAllCollectionsSchema: {
                type: 'boolean',
                'x-component': 'Checkbox',
                'x-display': 'hidden',
                default: true,
              },
              createCollectionsSchema,
            })}
          />
        </SchemaComponentOptions>
      </FormProvider>,
    );

    expect(screen.getByTestId('v1-collections-table')).toBeTruthy();
    expect(form.values.options).toMatchObject({
      port: 1433,
      trustServerCertificate: true,
      addAllCollections: true,
    });

    fireEvent.change(screen.getByPlaceholderText('localhost'), { target: { value: 'sql.internal.local' } });
    expect(form.values.options.host).toBe('sql.internal.local');
  });

  it('marks saved selectedCollections when normalizing v1 loadCollections output in edit mode', () => {
    const normalized = normalizeLoadedCollectionsForV1(
      { data: [{ name: 'orders' }, { name: 'customers' }, 'invoices'] },
      ['orders', 'invoices'],
      false,
    );

    expect(normalized).toEqual({
      data: [
        { name: 'orders', selected: true },
        { name: 'customers', selected: false },
        { name: 'invoices', selected: true },
      ],
    });
  });

  it('extracts bulk selected collection names from both array and grouped table selection state', () => {
    expect(extractBulkSelectedNames({ selectedRowKeys: ['orders', '', 'customers'] })).toEqual(['orders', 'customers']);
    expect(extractBulkSelectedNames({ selectedRowKeys: { page1: ['orders'], page2: ['invoices'] } })).toEqual([
      'orders',
      'invoices',
    ]);
    expect(extractBulkSelectedNames(undefined)).toEqual([]);
  });

  it('registers mssql type against @nocobase/plugin-data-source-manager/client in v1 client plugin', async () => {
    const registerType = vi.fn();
    const mockApp = {
      pm: {
        get: vi.fn((pluginClass: unknown) =>
          pluginClass === PluginDataSourceManagerClient ? { registerType } : undefined,
        ),
      },
    };
    const plugin = new PluginDataSourceMssqlClient({} as never, mockApp as never);

    expect(typeof PluginDataSourceManagerClient).toBe('function');
    await plugin.load();

    expect(mockApp.pm.get).toHaveBeenCalledWith(PluginDataSourceManagerClient);
    expect(registerType).toHaveBeenCalledWith(
      'mssql',
      expect.objectContaining({
        name: 'mssql',
        DataSourceSettingsForm: MssqlConfigForm,
      }),
    );
  });
});
