// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { reviewApprovalTaskType } from '../Approvals';

const mocks = vi.hoisted(() => {
  const request = vi.fn();
  const t = (key: string) => key;
  return {
    request,
    apiClient: { request },
    app: { i18n: { t } },
    navigate: vi.fn(),
    setRecord: vi.fn(),
    setVisible: vi.fn(),
    refreshList: vi.fn(),
    reloadCounts: vi.fn(),
    listContext: { service: { refresh: vi.fn(), loading: false } },
    record: { id: 42, title: 'MR !7 review approval' } as Record<string, unknown>,
    openMode: 'modal' as 'modal' | 'drawer',
    success: vi.fn(),
    error: vi.fn(),
  };
});

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock('@ant-design/icons', () => ({
  ReloadOutlined: () => null,
}));

vi.mock('@nocobase/client', () => ({
  useAPIClient: () => mocks.apiClient,
  useApp: () => mocks.app,
  useCollectionRecordData: () => mocks.record,
  useActionContext: () => ({ visible: true, setVisible: mocks.setVisible, openMode: mocks.openMode }),
  useListBlockContext: () => mocks.listContext,
}));

vi.mock('@nocobase/plugin-workflow/client', () => ({
  usePopupRecordContext: () => ({ record: mocks.record, setRecord: mocks.setRecord }),
  useTasksCountsContext: () => ({ reload: mocks.reloadCounts }),
}));

vi.mock('antd', () => ({
  Alert: (props: { message?: React.ReactNode }) => React.createElement('div', { role: 'alert' }, props.message),
  Button: (props: {
    children?: React.ReactNode;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
    'aria-label'?: string;
  }) =>
    React.createElement(
      'button',
      { type: 'button', onClick: props.onClick, 'aria-label': props['aria-label'] },
      props.children,
    ),
  Card: (props: {
    title?: React.ReactNode;
    role?: string;
    tabIndex?: number;
    'aria-label'?: string;
    onClick?: React.MouseEventHandler<HTMLDivElement>;
    onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
  }) =>
    React.createElement(
      'div',
      {
        role: props.role,
        tabIndex: props.tabIndex,
        'aria-label': props['aria-label'],
        onClick: props.onClick,
        onKeyDown: props.onKeyDown,
      },
      props.title,
    ),
  Drawer: (props: { open?: boolean; title?: React.ReactNode; children?: React.ReactNode }) =>
    props.open ? React.createElement('div', { 'data-testid': 'approval-drawer' }, props.title, props.children) : null,
  Modal: (props: { open?: boolean; title?: React.ReactNode; children?: React.ReactNode }) =>
    props.open ? React.createElement('div', { 'data-testid': 'approval-modal' }, props.title, props.children) : null,
  Popconfirm: (props: { children: React.ReactElement; onConfirm?: () => void }) => {
    const child = props.children as React.ReactElement<{ onClick?: React.MouseEventHandler<HTMLElement> }>;
    return React.cloneElement(child, {
      onClick: (event: React.MouseEvent<HTMLElement>) => {
        child.props.onClick?.(event);
        props.onConfirm?.();
      },
    });
  },
  Space: (props: { children?: React.ReactNode }) => React.createElement('div', null, props.children),
  Spin: (props: { children?: React.ReactNode }) => React.createElement('div', null, props.children),
  Typography: {
    Text: (props: { children?: React.ReactNode }) => React.createElement('span', null, props.children),
  },
  message: { success: mocks.success, error: mocks.error },
}));

describe('v1 Git review approval task type', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listContext.service.refresh = mocks.refreshList;
    mocks.record = { id: 42, title: 'MR !7 review approval' };
    mocks.openMode = 'modal';
  });

  afterEach(cleanup);

  it('configures action params and popup record loader for v1 workflow tasks', async () => {
    expect(reviewApprovalTaskType.key).toBe('git-review-approval');
    expect(reviewApprovalTaskType.collection).toBe('workflowGitReview');
    expect(reviewApprovalTaskType.action).toBe('approvals');
    expect(reviewApprovalTaskType.alwaysShow).toBe(true);
    expect(reviewApprovalTaskType.useActionParams('pending')).toEqual({});
    expect(reviewApprovalTaskType.useActionParams('completed')).toEqual({ status: 'completed' });

    mocks.request.mockResolvedValueOnce({ data: { data: { id: 42 } } });
    await reviewApprovalTaskType.getPopupRecord?.(
      mocks.apiClient as unknown as Parameters<NonNullable<typeof reviewApprovalTaskType.getPopupRecord>>[0],
      { params: { filterByTk: '42' } },
    );
    expect(mocks.request).toHaveBeenCalledWith({
      url: 'workflowGitReview:approval',
      params: { filterByTk: '42' },
    });
  });

  it('opens the approval detail route when clicking or pressing Enter on an item card', () => {
    const Item = reviewApprovalTaskType.Item;
    render(<Item />);

    const card = screen.getByRole('button', { name: 'MR !7 review approval' });
    fireEvent.click(card);
    expect(mocks.setRecord).toHaveBeenCalledWith(mocks.record);
    expect(mocks.navigate).toHaveBeenCalledWith('./42');

    fireEvent.keyDown(card, { key: 'Enter' });
    expect(mocks.navigate).toHaveBeenCalledTimes(2);
  });

  it('loads approval detail, submits approval decision, and refreshes task list and counts', async () => {
    mocks.request.mockImplementation(async ({ url }: { url: string }) => {
      if (url === 'workflowGitReview:approval') {
        return {
          data: {
            data: {
              id: 42,
              title: 'MR !7 review approval',
              fingerprint: 'sha256-abc123',
              markdown: '## LGTM',
            },
          },
        };
      }
      return { data: { data: {} } };
    });

    const Detail = reviewApprovalTaskType.Detail;
    render(<Detail />);

    expect(await screen.findByText('sha256-abc123')).toBeInTheDocument();
    expect(screen.getByText('## LGTM')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(mocks.request).toHaveBeenCalledWith({
        url: 'workflowManualTasks:submit',
        method: 'post',
        params: { filterByTk: 42 },
        data: { result: { review: { fingerprint: 'sha256-abc123' }, _: 'approve' } },
      });
    });
    expect(mocks.setVisible).toHaveBeenCalledWith(false);
    expect(mocks.refreshList).toHaveBeenCalledTimes(1);
    expect(mocks.reloadCounts).toHaveBeenCalledTimes(1);
    expect(mocks.success).toHaveBeenCalledWith('Decision submitted');
  });

  it('renders mobile Actions without crashing and triggers refresh', () => {
    const Actions = reviewApprovalTaskType.Actions;
    expect(Actions).toBeDefined();
    if (!Actions) return;
    render(<Actions onlyIcon />);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(mocks.refreshList).toHaveBeenCalledTimes(1);
    expect(mocks.reloadCounts).toHaveBeenCalledTimes(1);
  });
});
