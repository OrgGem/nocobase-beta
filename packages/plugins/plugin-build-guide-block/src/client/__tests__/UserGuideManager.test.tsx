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
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UserGuideManager } from '../UserGuideManager';

const mocks = vi.hoisted(() => {
  const spaceApi = {
    list: vi.fn(),
    build: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    destroy: vi.fn(),
  };
  const runApi = { getStatus: vi.fn(), cancel: vi.fn(), retry: vi.fn() };
  const aiApi = { listLLMServices: vi.fn(), listModels: vi.fn() };
  const t = (key: string, values?: Record<string, string | number>) =>
    values ? key.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values[name])) : key;
  const apiClient = {
    resource: vi.fn((name: string) => {
      if (name === 'aiBuildGuideSpaces') return spaceApi;
      if (name === 'aiBuildGuideRuns') return runApi;
      return aiApi;
    }),
  };
  return { apiClient, spaceApi, runApi, aiApi, t };
});

vi.mock('@nocobase/client-v2', () => ({
  useApp: () => ({ apiClient: mocks.apiClient, getHref: (path: string) => `/app${path}` }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.t }),
}));

function renderManager() {
  return render(
    <App>
      <UserGuideManager />
    </App>,
  );
}

describe('Build Guide manager workflow runs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.spaceApi.list.mockResolvedValue({
      data: {
        data: [
          {
            id: 7,
            title: 'User guide',
            engine: 'workflow',
            status: 'completed',
            latestRunId: 21,
            published: true,
            publishedRunId: 19,
            pageCount: 3,
          },
        ],
      },
    });
    mocks.runApi.getStatus.mockResolvedValue({
      data: {
        data: {
          id: 21,
          spaceId: 7,
          engine: 'workflow',
          status: 'failed',
          stage: 'writing_chapter',
          expectedCount: 3,
          completedCount: 1,
          canCancel: false,
          canRetry: true,
          errorCode: 'PROVIDER_FAILED',
          executionId: 88,
          steps: [{ stepKey: 'chapter:second', status: 'failed', attempt: 2, errorCode: 'PROVIDER_FAILED' }],
        },
      },
    });
    mocks.runApi.retry.mockResolvedValue({ data: { data: { status: 'queued', runId: 22 } } });
    mocks.runApi.cancel.mockResolvedValue({ data: { data: { status: 'cancelled' } } });
    mocks.aiApi.listLLMServices.mockResolvedValue({ data: { data: [] } });
    mocks.aiApi.listModels.mockResolvedValue({ data: { data: [] } });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('loads the safe run status envelope, shows progress and exposes only permitted actions and execution links', async () => {
    renderManager();

    expect(await screen.findByText('1 of 3 chapters')).toBeInTheDocument();
    expect(mocks.runApi.getStatus).toHaveBeenCalledWith({ filterByTk: 21 });
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel build' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open execution' })).toHaveAttribute(
      'href',
      '/app/admin/settings/workflow/executions/88',
    );
    expect(screen.getByText('Published · 19')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(mocks.runApi.retry).toHaveBeenCalledWith({ filterByTk: 21 }));
  });

  it('polls queued/running runs and omits the execution link when the API withholds it', async () => {
    vi.useFakeTimers();
    mocks.spaceApi.list.mockResolvedValue({
      data: {
        data: [{ id: 7, title: 'User guide', engine: 'workflow', activeRunId: 21, latestRunId: 21 }],
      },
    });
    mocks.runApi.getStatus.mockResolvedValue({
      data: {
        data: {
          id: 21,
          spaceId: 7,
          engine: 'workflow',
          status: 'running',
          stage: 'planning',
          expectedCount: 3,
          completedCount: 0,
          canCancel: true,
          canRetry: false,
          steps: [{ stepKey: 'plan', status: 'running', attempt: 1 }],
        },
      },
    });

    renderManager();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.runApi.getStatus).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('link', { name: 'Open execution' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel build' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(mocks.runApi.getStatus).toHaveBeenCalledTimes(2);
  });

  it('keeps legacy completed guides published and hides workflow actions for legacy runs', async () => {
    mocks.spaceApi.list.mockResolvedValue({
      data: {
        data: [
          {
            id: 7,
            title: 'Legacy guide',
            engine: 'legacy',
            status: 'completed',
            latestRunId: 21,
            published: false,
            publishedRunId: 19,
          },
        ],
      },
    });
    mocks.runApi.getStatus.mockResolvedValue({
      data: {
        data: {
          id: 21,
          spaceId: 7,
          engine: 'legacy',
          status: 'failed',
          stage: 'failed',
          expectedCount: 3,
          completedCount: 1,
          canCancel: true,
          canRetry: true,
          steps: [],
        },
      },
    });

    renderManager();

    expect(await screen.findByText('Published · 19')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel build' })).not.toBeInTheDocument();
  });
});
