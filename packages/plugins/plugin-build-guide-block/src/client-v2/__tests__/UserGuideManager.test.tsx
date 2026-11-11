/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import { App } from 'antd';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { UserGuideManager } from '../UserGuideManager';

const mocks = vi.hoisted(() => {
  const runApi = { getStatus: vi.fn(), cancel: vi.fn(), retry: vi.fn() };
  const spaceApi = { list: vi.fn(), build: vi.fn(), create: vi.fn(), update: vi.fn(), destroy: vi.fn() };
  const aiApi = { listLLMServices: vi.fn(), listModels: vi.fn() };
  const apiClient = {
    resource: vi.fn((name: string) =>
      name === 'aiBuildGuideSpaces' ? spaceApi : name === 'aiBuildGuideRuns' ? runApi : aiApi,
    ),
  };
  const t = (key: string, values?: Record<string, string | number>) =>
    values ? key.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values[name])) : key;
  return { runApi, spaceApi, aiApi, apiClient, t };
});

vi.mock('@nocobase/client-v2', () => ({
  useApp: () => ({ apiClient: mocks.apiClient, getHref: (path: string) => `/modern${path}` }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.t }) }));

describe('Build Guide modern manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.spaceApi.list.mockResolvedValue({
      data: { data: [{ id: 5, title: 'Guide', engine: 'workflow', latestRunId: 'run-5', status: 'building' }] },
    });
    mocks.runApi.getStatus.mockResolvedValue({
      data: {
        data: {
          id: 'run-5',
          spaceId: 5,
          engine: 'workflow',
          status: 'running',
          stage: 'writing_chapter',
          expectedCount: 2,
          completedCount: 1,
          canCancel: true,
          canRetry: false,
          executionId: 17,
          steps: [],
        },
      },
    });
    mocks.aiApi.listLLMServices.mockResolvedValue({ data: { data: [] } });
    mocks.aiApi.listModels.mockResolvedValue({ data: { data: [] } });
  });

  afterEach(cleanup);

  it('renders run progress and uses the modern execution route only when provided', async () => {
    render(
      <App>
        <UserGuideManager />
      </App>,
    );

    expect(await screen.findByText('1 of 2 chapters')).toBeInTheDocument();
    expect(mocks.runApi.getStatus).toHaveBeenCalledWith({ filterByTk: 'run-5' });
    expect(screen.getByRole('link', { name: 'Open execution' })).toHaveAttribute(
      'href',
      '/modern/admin/workflow/executions/17',
    );
    expect(screen.getByRole('button', { name: 'Cancel build' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();

    await waitFor(() => expect(mocks.spaceApi.list).toHaveBeenCalled());
  });
});
