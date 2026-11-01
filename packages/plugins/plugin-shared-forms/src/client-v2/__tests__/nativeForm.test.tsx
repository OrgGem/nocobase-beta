/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import '@testing-library/jest-dom/vitest';
import * as client from '@nocobase/client-v2';
import { FlowEngineProvider } from '@nocobase/flow-engine';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App, theme } from 'antd';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeForm } from '../NativeForm';
import { formModelOptions } from '../models';
import type { SharedFormConfig } from '../../shared/v2Config';

vi.mock('../locale', () => ({ useT: () => (key: string) => key }));
afterEach(cleanup);
describe('native Shared Forms rendering and submit', () => {
  it('renders a real Antd field and submits through the inherited V2 form flow without posting a normal create', async () => {
    const app = client.createMockClient();
    await new client.PluginFlowEngine({}, app).load();
    app.flowEngine.context.defineProperty('themeToken', { value: theme.getDesignToken() });
    const toast = { success: vi.fn(), error: vi.fn() };
    app.flowEngine.context.defineProperty('message', { value: toast });
    const success = vi.fn();
    const config = {
      version: 2,
      model: formModelOptions('main', 'orders'),
      successMessage: 'Done',
    } as SharedFormConfig;
    config.model.subModels.grid = {
      use: 'FormGridModel',
      subModels: {
        items: [
          {
            use: 'FormItemModel',
            stepParams: {
              fieldSettings: { init: { dataSourceKey: 'main', collectionName: 'orders', fieldPath: 'title' } },
            },
            subModels: { field: { use: 'InputFieldModel' } },
          },
        ],
      },
    };
    app.apiMock.onPost('orders:sharedSubmit').reply(200, { data: { id: 1 } });
    const metadata = {
      key: 'main',
      collections: [
        { name: 'orders', fields: [{ name: 'title', title: 'Title', type: 'string', interface: 'input' }] },
      ],
    };
    render(
      <FlowEngineProvider engine={app.flowEngine}>
        <MemoryRouter>
          <App>
            <NativeForm formKey="form-a" config={config} metadata={metadata} onSubmitted={success} />
          </App>
        </MemoryRouter>
      </FlowEngineProvider>,
    );
    const input = await screen.findByRole('textbox');
    fireEvent.change(input, { target: { value: 'A response' } });
    fireEvent.click(await screen.findByRole('button', { name: /Submit/ }));
    await waitFor(() =>
      expect(app.apiMock.history.post.filter((request) => request.url === 'orders:sharedSubmit')).toHaveLength(1),
    );
    const submitted = app.apiMock.history.post.find((request) => request.url === 'orders:sharedSubmit');
    expect(JSON.parse(submitted.data)).toEqual({ title: 'A response' });
    expect(app.apiMock.history.post.some((request) => request.url === 'orders:create')).toBe(false);
    await waitFor(() => expect(success).toHaveBeenCalled());
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalled();
  });
});
