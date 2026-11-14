// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiClient = vi.hoisted(() => ({
  request: vi.fn(),
}));
const translate = vi.hoisted(() => (key: string) => key);
const permissionResponses = vi.hoisted(() => ({
  reader: { view: [11], update: [11], destroy: [], readOnlyActions: ['update'] },
  editor: { view: [], update: [], destroy: [], readOnlyActions: [] },
}));

type RequestOptions = {
  resource?: string;
  url?: string;
  params?: { roleName?: string };
  data?: { roleName?: string; values?: Record<string, unknown> };
};

vi.mock('@nocobase/client', () => ({
  useAPIClient: () => apiClient,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate }),
}));

import { ExternalStoragePermissions } from '../components/ExternalStoragePermissions';

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
  permissionResponses.reader = { view: [11], update: [11], destroy: [], readOnlyActions: ['update'] };
  permissionResponses.editor = { view: [], update: [], destroy: [], readOnlyActions: [] };
  apiClient.request.mockImplementation((options: RequestOptions) => {
    if (options.resource === 'externalStorageDirectories') {
      return Promise.resolve({
        data: { data: [{ id: 11, name: 'archive', rootPath: '/archive', storageType: 's3-private' }] },
      });
    }
    if (options.url === 'extStorage:updateRolePermissions') return Promise.resolve({ data: 'ok' });
    if (options.url === 'extStorage:rolePermissions') {
      return Promise.resolve({
        data: permissionResponses[options.params?.roleName === 'editor' ? 'editor' : 'reader'],
      });
    }
    return Promise.reject(new Error(`Unexpected request: ${options.url || options.resource}`));
  });
});

describe('ExternalStoragePermissions', () => {
  it('shows advanced scopes as read-only and saves only the changed action', async () => {
    render(<ExternalStoragePermissions activeRole={{ name: 'reader', title: 'Reader' }} />);

    expect(await screen.findByText('archive')).toBeTruthy();
    expect(screen.getByText(/Reader/)).toBeTruthy();
    await waitFor(() =>
      expect(apiClient.request).toHaveBeenCalledWith({
        url: 'extStorage:rolePermissions',
        method: 'get',
        params: { roleName: 'reader' },
      }),
    );

    const advancedPermission = screen.getByRole('checkbox', { name: 'Write (Upload & Mkdir): archive' });
    expect((advancedPermission as HTMLInputElement).disabled).toBe(true);

    const readPermission = screen.getByRole('checkbox', { name: 'Read (View & Download): archive' });
    expect((readPermission as HTMLInputElement).checked).toBe(true);
    fireEvent.click(readPermission);

    await waitFor(() =>
      expect(apiClient.request).toHaveBeenCalledWith({
        url: 'extStorage:updateRolePermissions',
        method: 'post',
        data: {
          roleName: 'reader',
          values: { view: [] },
        },
      }),
    );
  });

  it.each([
    ['missing', { view: [11], update: [], destroy: [] }],
    ['malformed', { view: [11], update: [], destroy: [], readOnlyActions: ['manage'] }],
  ])('disables all writes when server capability metadata is %s', async (_label, state) => {
    permissionResponses.reader = state as typeof permissionResponses.reader;
    render(<ExternalStoragePermissions activeRole={{ name: 'reader', title: 'Reader' }} />);

    expect(await screen.findByText(/cannot safely edit these permissions/)).toBeTruthy();
    const checkboxes = await screen.findAllByRole('checkbox');
    expect(checkboxes).toHaveLength(3);
    for (const checkbox of checkboxes) {
      expect((checkbox as HTMLInputElement).disabled).toBe(true);
      fireEvent.click(checkbox);
    }
    expect(apiClient.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ url: 'extStorage:updateRolePermissions' }),
    );
  });

  it('ignores a stale role response after switching roles', async () => {
    let resolveReader!: (response: unknown) => void;
    apiClient.request.mockImplementation((options: RequestOptions) => {
      if (options.resource === 'externalStorageDirectories') {
        return Promise.resolve({
          data: { data: [{ id: 11, name: 'archive', rootPath: '/archive', storageType: 's3-private' }] },
        });
      }
      if (options.url === 'extStorage:rolePermissions' && options.params?.roleName === 'reader') {
        return new Promise((resolve) => {
          resolveReader = resolve;
        });
      }
      if (options.url === 'extStorage:rolePermissions') return Promise.resolve({ data: permissionResponses.editor });
      return Promise.resolve({ data: 'ok' });
    });

    const view = render(<ExternalStoragePermissions activeRole={{ name: 'reader', title: 'Reader' }} />);
    await waitFor(() => expect(resolveReader).toBeTypeOf('function'));
    view.rerender(<ExternalStoragePermissions activeRole={{ name: 'editor', title: 'Editor' }} />);

    const readPermission = await screen.findByRole('checkbox', { name: 'Read (View & Download): archive' });
    expect((readPermission as HTMLInputElement).checked).toBe(false);

    await act(async () => {
      resolveReader({ data: permissionResponses.reader });
    });
    expect((readPermission as HTMLInputElement).checked).toBe(false);
  });

  it.each([
    ['a successful save', false, false],
    ['a failed save', true, true],
  ])('waits for %s before reloading canonical permissions', async (_label, shouldReject, expectedChecked) => {
    let resolvePost!: () => void;
    let rejectPost!: (error: Error) => void;
    let readerLoads = 0;
    let readerPermissions = { view: [11], update: [], destroy: [], readOnlyActions: [] as string[] };
    const pendingPost = new Promise<void>((resolve, reject) => {
      resolvePost = resolve;
      rejectPost = reject;
    });
    apiClient.request.mockImplementation((options: RequestOptions) => {
      if (options.resource === 'externalStorageDirectories') {
        return Promise.resolve({
          data: { data: [{ id: 11, name: 'archive', rootPath: '/archive', storageType: 's3-private' }] },
        });
      }
      if (options.url === 'extStorage:updateRolePermissions') return pendingPost.then(() => ({ data: 'ok' }));
      if (options.url === 'extStorage:rolePermissions' && options.params?.roleName === 'reader') {
        readerLoads += 1;
        return Promise.resolve({ data: readerPermissions });
      }
      if (options.url === 'extStorage:rolePermissions') return Promise.resolve({ data: permissionResponses.editor });
      return Promise.reject(new Error(`Unexpected request: ${options.url || options.resource}`));
    });

    const view = render(<ExternalStoragePermissions activeRole={{ name: 'reader', title: 'Reader' }} />);
    const readerCheckbox = await screen.findByRole('checkbox', { name: 'Read (View & Download): archive' });
    fireEvent.click(readerCheckbox);
    await waitFor(() =>
      expect(apiClient.request).toHaveBeenCalledWith({
        url: 'extStorage:updateRolePermissions',
        method: 'post',
        data: { roleName: 'reader', values: { view: [] } },
      }),
    );

    view.rerender(<ExternalStoragePermissions activeRole={{ name: 'editor', title: 'Editor' }} />);
    expect(await screen.findByText('archive')).toBeTruthy();
    view.rerender(<ExternalStoragePermissions activeRole={{ name: 'reader', title: 'Reader' }} />);
    expect(screen.getByText(/Reader/)).toBeTruthy();
    expect(view.container.querySelector('.ant-spin-spinning')).not.toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(apiClient.request).toHaveBeenCalledTimes(5);
    expect(readerLoads).toBe(1);

    await act(async () => {
      if (shouldReject) {
        rejectPost(new Error('Save failed'));
      } else {
        readerPermissions = { ...readerPermissions, view: [] };
        resolvePost();
      }
    });
    await waitFor(() => expect(readerLoads).toBe(2));
    const refreshedReaderCheckbox = await screen.findByRole('checkbox', { name: 'Read (View & Download): archive' });
    await waitFor(() => expect((refreshedReaderCheckbox as HTMLInputElement).disabled).toBe(false));
    expect((refreshedReaderCheckbox as HTMLInputElement).checked).toBe(expectedChecked);
  });
});
