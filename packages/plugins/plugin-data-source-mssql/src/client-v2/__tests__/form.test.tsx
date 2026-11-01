/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

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
});
