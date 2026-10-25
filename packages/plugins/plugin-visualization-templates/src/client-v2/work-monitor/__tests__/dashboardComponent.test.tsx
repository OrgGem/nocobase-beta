/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from 'antd';
import { VisualizationTemplatesManager } from '../VisualizationTemplatesManager';

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
const fields = [
  { name: 'title', type: 'string', interface: 'input' },
  { name: 'status', type: 'string', interface: 'select' },
];
vi.mock('@nocobase/client-v2', () => ({ useApp: () => ({ apiClient: { request: mocks.request } }) }));
vi.mock('@nocobase/flow-engine', () => ({
  useFlowContext: () => ({
    t: (value: string) => value,
    acl: { can: () => true },
    dataSourceManager: {
      getDataSources: () => [],
      getCollection: () => ({ getFields: () => fields, getFilterByTK: (record: Record<string, unknown>) => record.id }),
    },
  }),
}));
vi.mock('../../locale', () => ({ namespace: 'plugin-visualization-templates', useT: () => (value: string) => value }));

function tasks(collection: string, source = 'source-a') {
  return (
    <App>
      <VisualizationTemplatesManager
        dataSourceName={source}
        collectionName={collection}
        embedded
        visibleTabKeys={['tasks']}
      />
    </App>
  );
}
beforeEach(() => {
  localStorage.clear();
  mocks.request.mockReset();
});
afterEach(cleanup);

describe('V2 dashboard component request lifecycle', () => {
  it('keeps the selected collection data when an earlier datasource request resolves late', async () => {
    let finishFirst: (value: unknown) => void;
    mocks.request
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({
        data: { data: [{ id: '9007199254740993', title: 'Current dataset row', status: 'open' }] },
      });
    const view = render(tasks('first'));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
    view.rerender(tasks('second', 'source-b'));
    await waitFor(() => expect(screen.getAllByText('Current dataset row').length).toBeGreaterThan(0));
    expect(mocks.request.mock.calls[1][0]).toMatchObject({
      url: 'second:list',
      headers: { 'X-Data-Source': 'source-b' },
    });
    await act(async () => finishFirst({ data: { data: [{ id: 'old', title: 'Stale dataset row' }] } }));
    expect(screen.queryAllByText('Stale dataset row')).toHaveLength(0);
    expect(screen.getAllByText('Current dataset row').length).toBeGreaterThan(0);
  });

  it('clears another collection records when the new collection request is denied', async () => {
    mocks.request
      .mockResolvedValueOnce({ data: { data: [{ id: 1, title: 'Previous dataset row' }] } })
      .mockRejectedValueOnce(new Error('Access denied'));
    const view = render(tasks('first'));
    await waitFor(() => expect(screen.getAllByText('Previous dataset row').length).toBeGreaterThan(0));
    view.rerender(tasks('restricted'));
    await waitFor(() => expect(screen.getByText('Access denied')).toBeTruthy());
    expect(screen.queryAllByText('Previous dataset row')).toHaveLength(0);
  });
});
