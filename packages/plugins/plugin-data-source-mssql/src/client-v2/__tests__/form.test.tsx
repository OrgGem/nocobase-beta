// SPDX-License-Identifier: Apache-2.0

import { createMockClient } from '@nocobase/client-v2';
import { FlowEngineProvider } from '@nocobase/flow-engine';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Form } from 'antd';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MssqlConfigForm } from '../components/MssqlConfigForm';

afterEach(cleanup);
describe('MSSQL V2 native datasource settings', () => {
  it('discovers tables before creation through the core dbOptions contract and stores load-all under options', async () => {
    const app = createMockClient();
    app.flowEngine.context.defineProperty('message', { value: { error: vi.fn() } });
    app.apiMock.onPost('dataSources:readTables').reply(200, { data: [{ name: 'orders' }] });
    let values: Record<string, unknown>;
    function Fields() {
      const form = Form.useFormInstance();
      values = form.getFieldsValue(true);
      return <MssqlConfigForm mode="create" type={{ label: 'MSSQL' }} loadCollections={vi.fn()} />;
    }
    render(
      <FlowEngineProvider engine={app.flowEngine}>
        <Form
          initialValues={{ key: 'external', options: { host: 'db.test', database: 'sales', addAllCollections: false } }}
        >
          <Fields />
        </Form>
      </FlowEngineProvider>,
    );
    fireEvent.focus(await screen.findByRole('combobox'));
    await waitFor(() => expect(app.apiMock.history.post).toHaveLength(1));
    expect(JSON.parse(app.apiMock.history.post[0].data)).toMatchObject({
      dataSourceKey: 'external',
      dbOptions: { type: 'mssql', host: 'db.test', database: 'sales', addAllCollections: false },
    });
    expect(values).toMatchObject({ options: { addAllCollections: false } });
  });

  it('exposes advanced performance and timeout settings in a collapsible section', async () => {
    const app = createMockClient();
    app.flowEngine.context.defineProperty('message', { value: { error: vi.fn() } });
    render(
      <FlowEngineProvider engine={app.flowEngine}>
        <Form initialValues={{ key: 'external', options: { host: 'db.test', database: 'sales' } }}>
          <MssqlConfigForm mode="create" type={{ label: 'MSSQL' }} loadCollections={vi.fn()} />
        </Form>
      </FlowEngineProvider>,
    );

    const toggle = screen.getByText('Advanced performance & connection settings');
    fireEvent.click(toggle);

    expect(await screen.findByText('Trust server certificate')).toBeTruthy();
    expect(screen.getByText('Read-only intent')).toBeTruthy();
    expect(screen.getByText('Read uncommitted (avoid writer lock waits)')).toBeTruthy();
    expect(screen.getByText('Request timeout (ms)')).toBeTruthy();
    expect(screen.getByText('Lock timeout (ms)')).toBeTruthy();
    expect(screen.getByText('Full-text search mode')).toBeTruthy();
    expect(screen.getByText('Fast unfiltered count')).toBeTruthy();
    expect(screen.getByText('Slow query warning threshold (ms)')).toBeTruthy();
  });

  it('preserves saved advanced settings on validateFields() even when the Collapse panel stays closed', async () => {
    const app = createMockClient();
    app.flowEngine.context.defineProperty('message', { value: { error: vi.fn() } });
    let formRef!: ReturnType<typeof Form.useForm>[0];
    const savedInitial = {
      key: 'external',
      options: {
        host: 'db.test',
        port: 1433,
        database: 'sales',
        username: 'sa',
        requestTimeout: 30000,
        lockTimeout: 5000,
        readOnlyIntent: true,
        readUncommitted: true,
        fullTextSearchMode: 'off',
        fastCount: true,
        slowQueryThresholdMs: 1000,
      },
    };
    function Harness() {
      const [form] = Form.useForm();
      formRef = form;
      return (
        <Form form={form} initialValues={savedInitial}>
          <MssqlConfigForm
            mode="edit"
            type={{ label: 'MSSQL' }}
            initialValues={savedInitial}
            loadCollections={vi.fn()}
          />
        </Form>
      );
    }

    render(
      <FlowEngineProvider engine={app.flowEngine}>
        <Harness />
      </FlowEngineProvider>,
    );

    const validated = await formRef.validateFields();
    expect(validated.options).toMatchObject({
      requestTimeout: 30000,
      lockTimeout: 5000,
      readOnlyIntent: true,
      readUncommitted: true,
      fullTextSearchMode: 'off',
      fastCount: true,
      slowQueryThresholdMs: 1000,
    });
  });
});
