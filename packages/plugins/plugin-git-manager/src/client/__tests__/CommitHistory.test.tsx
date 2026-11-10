/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { CommitHistory } from '../components/CommitHistory';

const mocks = vi.hoisted(() => {
  const request = vi.fn();
  return {
    request,
    apiClient: { request },
    selectedRepo: { id: 7, status: 'connected' },
  };
});

vi.mock('@nocobase/client-v2', () => ({
  useApp: () => ({ apiClient: mocks.apiClient }),
}));
vi.mock('../context/GitManagerContext', () => ({
  useGitManager: () => ({ selectedRepo: mocks.selectedRepo }),
}));
vi.mock('../locale', () => ({ useT: () => (key: string) => key }));
vi.mock('../components/RunReviewButton', () => ({
  RunReviewButton: ({ target }: { target: { type: string; branch?: string } }) => (
    <button data-testid="run-review" data-branch={target.branch} data-target-type={target.type} />
  ),
}));

describe('CommitHistory branch review entry point', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.request.mockImplementation(async ({ url }: { url: string }) => {
      if (url === 'gitManager:branches') {
        return {
          data: {
            data: { current: 'main', all: ['main', 'feature'], detached: false },
          },
        };
      }
      return { data: { data: { all: [] } } };
    });
  });
  afterEach(cleanup);

  it('mounts branch review only for a confirmed current branch', async () => {
    render(<CommitHistory />);

    const reviewButton = await screen.findByTestId('run-review');
    expect(reviewButton).toHaveAttribute('data-target-type', 'branch');
    expect(reviewButton).toHaveAttribute('data-branch', 'main');
    expect(mocks.request).toHaveBeenCalledWith({ url: 'gitManager:branches', params: { repositoryId: 7 } });
  });

  it('does not treat a detached HEAD as a branch', async () => {
    mocks.request.mockImplementation(async ({ url }: { url: string }) => {
      if (url === 'gitManager:branches') {
        return {
          data: {
            data: { current: 'main', all: ['main'], detached: true },
          },
        };
      }
      return { data: { data: { all: [] } } };
    });
    render(<CommitHistory />);

    await waitFor(() => {
      expect(mocks.request).toHaveBeenCalledWith({ url: 'gitManager:branches', params: { repositoryId: 7 } });
    });
    expect(screen.queryByTestId('run-review')).not.toBeInTheDocument();
  });
});
