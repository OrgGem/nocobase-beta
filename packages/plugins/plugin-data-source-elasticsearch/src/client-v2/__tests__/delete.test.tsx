/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import { createMockClient } from '@nocobase/client-v2';
import { FlowEngineProvider } from '@nocobase/flow-engine';
import NativeManager from '@nocobase/plugin-data-source-manager/client-v2';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import Plugin from '../plugin';
import { ElasticsearchDeleteCollection } from '../ElasticsearchDeleteCollection';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('registers deletion and confirms a scoped request before refreshing collections', async () => {
  const app = createMockClient();
  const message = { error: vi.fn() };
  app.flowEngine.context.defineProperty('message', { value: message });
  const manager = new NativeManager({}, app);
  vi.spyOn(app.pm, 'get').mockReturnValue(manager);
  await new Plugin({}, app).load();
  expect(manager.getType('elasticsearch').allowCollectionDeletion).toBe(true);
  expect(manager.getType('elasticsearch').DeleteCollection).toBe(ElasticsearchDeleteCollection);
  app.apiMock.onPost('dataSources/external/collections:destroy').reply(200, { data: {} });
  const submitted = vi.fn();
  render(
    <FlowEngineProvider engine={app.flowEngine}>
      <ElasticsearchDeleteCollection dataSourceKey="external" record={{ name: 'orders' }} onSubmitted={submitted} />
    </FlowEngineProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  expect(app.apiMock.history.post).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: /OK/i }));
  await waitFor(() => expect(submitted).toHaveBeenCalledOnce());
  expect(app.apiMock.history.post[0].params).toEqual({ filterByTk: ['orders'], cascade: false });
  expect(message.error).not.toHaveBeenCalled();
});

it('supports selected collections and retains the dialog on a failed delete', async () => {
  const app = createMockClient();
  const message = { error: vi.fn() };
  app.flowEngine.context.defineProperty('message', { value: message });
  app.apiMock.onPost('dataSources/external/collections:destroy').reply(403, {});
  const submitted = vi.fn();
  render(
    <FlowEngineProvider engine={app.flowEngine}>
      <ElasticsearchDeleteCollection
        dataSourceKey="external"
        selectedRowKeys={['orders', 'items']}
        isBulk
        onSubmitted={submitted}
      />
    </FlowEngineProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  fireEvent.click(screen.getByRole('button', { name: /OK/i }));
  await waitFor(() => expect(message.error).toHaveBeenCalled());
  expect(app.apiMock.history.post[0].params.filterByTk).toEqual(['orders', 'items']);
  expect(submitted).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog')).toBeTruthy();
});
