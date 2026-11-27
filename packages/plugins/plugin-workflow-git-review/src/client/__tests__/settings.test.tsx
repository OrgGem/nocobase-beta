// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import Settings from '../../client-v2/Settings';

const mocks = vi.hoisted(() => {
  const request = vi.fn();
  const t = (key: string) => key;
  return {
    request,
    t,
    app: {
      apiClient: { request },
      i18n: { t },
      getPublicPath: () => '/',
    },
  };
});

vi.mock('@nocobase/client-v2', () => ({
  useApp: () => mocks.app,
  getRouteRuntimeVersion: () => 'legacy',
  getV2EffectiveBasePath: () => '',
  stripModernClientPrefix: (path: string) => path,
}));

vi.mock('@nocobase/plugin-workflow/client-v2', () => ({
  getWorkflowCanvasPath: (id: string | number) => `/admin/settings/workflow/workflows/${id}`,
}));

vi.mock('../../client-v2/locale', () => ({
  useT: () => mocks.t,
}));

describe('Git Review Workflows Settings UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.request.mockImplementation(async ({ url }: { url: string }) => {
      if (url === 'workflowGitReview:status') {
        return {
          data: {
            data: {
              flows: [
                {
                  flowId: 1,
                  name: 'test',
                  repositoryId: 1,
                  repositoryName: 'test-pretext',
                  flowEnabled: true,
                  triggerMode: 'both',
                  postMode: 'manual',
                  aiEmployeeUsername: 'atlas',
                  model: 'gpt-6.1-sol',
                  workflowId: 399737784107008,
                  workflowKey: 'git-review-1',
                  enabled: true,
                  blockers: [],
                  template: 'full',
                  approverIds: [1],
                  canWrite: true,
                },
              ],
            },
          },
        };
      }
      if (url === 'gitManager:reviewCutoverStatus') {
        return {
          data: {
            data: { state: 'ready', legacyPending: 0, legacyRunning: 0, quarantined: [], legacyRunningReviews: [] },
          },
        };
      }
      return { data: { data: { enabled: true } } };
    });
  });

  afterEach(cleanup);

  it('renders flow summary metadata and validates approver IDs on blur and submit', async () => {
    render(<Settings />);

    expect(await screen.findByText('test-pretext (#1)')).toBeInTheDocument();
    expect(screen.getByText('Trigger: Manual & MR')).toBeInTheDocument();
    expect(screen.getByText('Publish: Manual approval')).toBeInTheDocument();
    expect(screen.getByText('@atlas')).toBeInTheDocument();
    expect(screen.getByText('gpt-6.1-sol')).toBeInTheDocument();
    expect(screen.getByText('git-review-1')).toBeInTheDocument();
    expect(screen.getByRole('article', { name: /test/i })).toBeInTheDocument();

    const approversInput = screen.getByLabelText('Approver user IDs, separated by commas');
    fireEvent.focus(approversInput);
    fireEvent.change(approversInput, { target: { value: 'abc' } });
    fireEvent.blur(approversInput);
    expect(approversInput).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Approver IDs must be numbers')).toHaveAttribute('role', 'alert');

    fireEvent.change(approversInput, { target: { value: '1, 2' } });
    expect(approversInput).not.toHaveAttribute('aria-invalid');

    fireEvent.click(screen.getByRole('button', { name: 'Create revision test' }));
    const confirmButton = await screen.findByRole('button', { name: 'Create revision' });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(mocks.request).toHaveBeenCalledWith({
        url: 'workflowGitReview:repair',
        method: 'post',
        data: { flowId: 1, template: 'full', approverIds: ['1', '2'] },
      });
    });
  });
});
