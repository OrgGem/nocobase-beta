/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ReviewHistory } from '../components/ReviewHistory';

const mocks = vi.hoisted(() => {
  const request = vi.fn();
  return {
    request,
    apiClient: { request },
    success: vi.fn(),
    warning: vi.fn(),
  };
});

vi.mock('@nocobase/client-v2', () => ({
  useApp: () => ({ apiClient: mocks.apiClient }),
  getModernClientPrefix: () => 'v',
  getRouteRuntimeVersion: () => 'legacy',
  getV2EffectiveBasePath: () => '/v/',
  stripModernClientPrefix: (path: string) => path.replace(/\/v\/?$/, '/'),
}));
vi.mock('../context/GitManagerContext', () => ({
  useGitManager: () => ({ repos: [{ id: 7, name: 'review-repo', repoUrl: 'https://gitlab.test/group/project' }] }),
}));
vi.mock('../locale', () => ({ useT: () => (key: string) => key }));
vi.mock('../components/MarkdownView', () => ({
  MarkdownView: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('antd')>();
  const ReactModule = await import('react');
  return {
    ...actual,
    Drawer: (props: { open: boolean; title: React.ReactNode; extra?: React.ReactNode; children: React.ReactNode }) =>
      props.open
        ? ReactModule.default.createElement(
            'div',
            { 'data-testid': 'review-drawer' },
            props.title,
            props.extra,
            props.children,
          )
        : null,
    Table: (props: {
      dataSource?: Array<{ id: number; mrIid: number }>;
      onRow?: (record: { id: number; mrIid: number }) => { onClick?: React.MouseEventHandler<HTMLElement> };
    }) =>
      ReactModule.default.createElement(
        'div',
        null,
        ...(props.dataSource || []).map((record) => {
          const rowClick = props.onRow?.(record).onClick;
          return ReactModule.default.createElement(
            'button',
            { key: String(record.id), type: 'button', onClick: rowClick },
            `Open review ${record.mrIid}`,
          );
        }),
      ),
    Popconfirm: (props: { children: React.ReactElement; onConfirm?: () => void }) => {
      const child = props.children as React.ReactElement<{ onClick?: React.MouseEventHandler<HTMLElement> }>;
      return ReactModule.default.cloneElement(child, {
        onClick: (event) => {
          child.props.onClick?.(event);
          props.onConfirm?.();
        },
      });
    },
    message: { ...actual.message, success: mocks.success, warning: mocks.warning },
  };
});

describe('ReviewHistory legacy approval outcome', () => {
  const review = {
    id: 301,
    repositoryId: 7,
    targetType: 'mr',
    mrIid: 42,
    status: 'completed',
    postStatus: 'pending_approval',
    reviewMarkdown: '## Existing review',
    createdAt: '2026-11-10T00:00:00.000Z',
    triggeredBy: 'manual',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    configure({ asyncUtilTimeout: 1500 });
    mocks.request.mockImplementation(async ({ url }: { url: string }) => {
      if (url === 'gitCodeReviews:list' || url === 'gitCodeReviews:get') {
        return { data: { data: url.endsWith(':list') ? [review] : review } };
      }
      if (url === 'gitManager:reviewApprovePost') return { data: { data: { status: 'observed' } } };
      return { data: { data: [] } };
    });
  });

  afterEach(cleanup);

  it('reports an observed matching note without claiming the review was posted', async () => {
    render(<ReviewHistory />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open review 42' }));
    const drawer = await screen.findByTestId('review-drawer');
    const approveLabel = within(drawer).getByText('Approve & Post', { exact: true });
    fireEvent.click(approveLabel);

    await waitFor(() => {
      expect(mocks.warning).toHaveBeenCalledWith('A matching comment was found, but its attempt cannot be confirmed');
    });
    expect(mocks.success).not.toHaveBeenCalledWith('Review posted to merge request');
    expect(mocks.request).toHaveBeenCalledWith({
      url: 'gitManager:reviewApprovePost',
      method: 'post',
      data: { reviewId: 301, editedMarkdown: '## Existing review', baseConfirmation: 'LEGACY_BASE_UNVERIFIED' },
    });
  });
});
