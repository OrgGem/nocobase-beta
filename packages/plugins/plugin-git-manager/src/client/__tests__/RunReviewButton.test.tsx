/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RunReviewButton } from '../components/RunReviewButton';

const mocks = vi.hoisted(() => {
  const request = vi.fn();
  return { request, apiClient: { request }, getPlugin: vi.fn(), triggerTask: vi.fn() };
});
vi.mock('@nocobase/client-v2', () => ({
  useApp: () => ({ apiClient: mocks.apiClient, pm: { get: mocks.getPlugin } }),
}));
vi.mock('../locale', () => ({ useT: () => (key: string) => key }));
// Any accidental runtime import of the AI package must fail this suite.
vi.mock('@nocobase/plugin-ai', () => {
  throw new Error('Unexpected legacy AI import');
});
vi.mock('@nocobase/plugin-ai/client-v2', () => {
  throw new Error('Unexpected direct AI client import');
});

describe('RunReviewButton managed review queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.request.mockImplementation(async ({ url }: { url: string }) => {
      if (url === 'gitReviewFlows:list') {
        return { data: { data: [{ id: 1, name: 'Security', aiEmployeeUsername: 'reviewer', repositoryId: 7 }] } };
      }
      if (url === 'gitManager:triggerReview') return { data: { data: { reviewId: 123 } } };
      return { data: { data: [] } };
    });
  });
  afterEach(cleanup);

  it('exposes managed review actions without a direct AI chat action', async () => {
    render(<RunReviewButton target={{ type: 'branch', repositoryId: 7, branch: 'main' }} />);
    fireEvent.click(screen.getByRole('button', { name: /Code Review/ }));

    expect(await screen.findByRole('menuitem', { name: /Run automated review/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Ask AI Employee/ })).not.toBeInTheDocument();
    expect(mocks.getPlugin).not.toHaveBeenCalled();
    expect(mocks.triggerTask).not.toHaveBeenCalled();
  });

  it('queues a review and reports the returned review id without direct AI invocation', async () => {
    const onTriggered = vi.fn();
    render(
      <RunReviewButton
        target={{ type: 'mr', repositoryId: 7, mrIid: 42, title: 'Fix permissions' }}
        onTriggered={onTriggered}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Code Review/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Run automated review/ }));
    await screen.findByText('Security — @reviewer');
    fireEvent.click(await screen.findByRole('button', { name: 'Start Review' }));

    await waitFor(() => {
      expect(mocks.request).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'gitManager:triggerReview',
          method: 'post',
          data: expect.objectContaining({
            repositoryId: 7,
            targetType: 'mr',
            flowId: 1,
            mrIid: 42,
          }),
        }),
      );
      expect(onTriggered).toHaveBeenCalledWith(123);
    });
    expect(mocks.getPlugin).not.toHaveBeenCalled();
    expect(mocks.triggerTask).not.toHaveBeenCalled();
  });
});
