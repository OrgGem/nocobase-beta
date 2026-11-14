// SPDX-License-Identifier: Apache-2.0

import { createMockClient } from '@nocobase/client-v2';
import { FlowEngineProvider } from '@nocobase/flow-engine';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('antd', async (importOriginal) => {
  const antd = await importOriginal<typeof import('antd')>();
  const ReactModule = await import('react');
  return {
    ...antd,
    Select: ({ onFocus, onBlur }: { onFocus?: () => void; onBlur?: () => void }) =>
      ReactModule.createElement('button', { type: 'button', role: 'combobox', onFocus, onBlur }),
  };
});

import { Form } from 'antd';
import { MssqlConfigForm } from '../components/MssqlConfigForm';

afterEach(cleanup);

async function blurPicker() {
  fireEvent.blur(screen.getByRole('combobox'));
  await act(async () => Promise.resolve());
}

describe('MSSQL V2 collection picker request cache', () => {
  it('deduplicates while loading and reloads when connection values change', async () => {
    const app = createMockClient();
    app.flowEngine.context.defineProperty('message', { value: { error: vi.fn() } });
    let resolveCollections: ((value: { data: Array<{ name: string }> }) => void) | undefined;
    const loadCollections = vi.fn(
      () =>
        new Promise<{ data: Array<{ name: string }> }>((resolve) => {
          resolveCollections = resolve;
        }),
    );
    app.apiMock.onPost('dataSources:readTables').reply(200, { data: [{ name: 'orders-v2' }] });
    let form!: ReturnType<typeof Form.useForm>[0];
    function FormHarness() {
      const [formInstance] = Form.useForm();
      form = formInstance;
      return (
        <Form
          form={formInstance}
          initialValues={{
            key: 'external',
            options: { host: 'db.test', port: 1433, database: 'sales', addAllCollections: false },
          }}
        >
          <MssqlConfigForm
            mode="edit"
            type={{ label: 'MSSQL' }}
            initialValues={{
              key: 'external',
              options: { host: 'db.test', port: 1433, database: 'sales', addAllCollections: false },
            }}
            loadCollections={loadCollections}
          />
        </Form>
      );
    }

    render(
      <FlowEngineProvider engine={app.flowEngine}>
        <FormHarness />
      </FlowEngineProvider>,
    );

    fireEvent.focus(await screen.findByRole('combobox'));
    await waitFor(() => expect(loadCollections).toHaveBeenCalledOnce());
    await blurPicker();
    fireEvent.focus(screen.getByRole('combobox'));
    expect(loadCollections).toHaveBeenCalledOnce();

    resolveCollections?.({ data: [{ name: 'orders' }] });
    await act(async () => loadCollections.mock.results[0].value);
    await blurPicker();
    act(() => form.setFieldValue(['options', 'host'], 'db-v2.test'));
    expect(form.getFieldValue(['options', 'host'])).toBe('db-v2.test');
    fireEvent.focus(screen.getByRole('combobox'));

    await waitFor(() => expect(app.apiMock.history.post).toHaveLength(1));
    expect(JSON.parse(app.apiMock.history.post[0].data)).toMatchObject({
      dataSourceKey: 'external',
      dbOptions: { type: 'mssql', host: 'db-v2.test', database: 'sales' },
    });
  });

  it('restores saved selections and retries a failed table-list request', async () => {
    const app = createMockClient();
    const messageError = vi.fn();
    app.flowEngine.context.defineProperty('message', { value: { error: messageError } });
    app.apiMock.onPost('dataSources:readTables').replyOnce(500, { errors: [{ message: 'unavailable' }] });
    app.apiMock.onPost('dataSources:readTables').reply(200, { data: [{ name: 'orders' }] });
    let form!: ReturnType<typeof Form.useForm>[0];
    function FormHarness() {
      const [formInstance] = Form.useForm();
      form = formInstance;
      return (
        <Form
          form={formInstance}
          initialValues={{
            key: 'external',
            options: {
              host: 'db-v2.test',
              port: 1433,
              database: 'sales',
              addAllCollections: false,
              selectedCollections: ['orders'],
            },
          }}
        >
          <MssqlConfigForm
            mode="edit"
            type={{ label: 'MSSQL' }}
            initialValues={{
              key: 'external',
              options: {
                host: 'db.test',
                port: 1433,
                database: 'sales',
                addAllCollections: false,
                selectedCollections: ['orders'],
              },
            }}
            loadCollections={vi.fn()}
          />
        </Form>
      );
    }

    render(
      <FlowEngineProvider engine={app.flowEngine}>
        <FormHarness />
      </FlowEngineProvider>,
    );

    await waitFor(() => expect(form.getFieldValue('collections')).toEqual(['orders']));
    fireEvent.focus(await screen.findByRole('combobox'));
    await waitFor(() => expect(messageError).toHaveBeenCalledOnce());
    await blurPicker();
    fireEvent.focus(screen.getByRole('combobox'));
    await waitFor(() => expect(app.apiMock.history.post).toHaveLength(2));
  });
});
