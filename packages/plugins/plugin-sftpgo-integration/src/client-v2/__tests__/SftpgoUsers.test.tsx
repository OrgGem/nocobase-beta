// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as ClientV2 from '@nocobase/client-v2';
import { AxiosHeaders } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SftpgoUsers } from '../components/SftpgoUsers';

vi.mock('../locale', () => {
  const translate = (value: string, options?: Record<string, unknown>) =>
    value.replace(/\{\{\s*([^\s}]+)\s*\}\}/g, (match, key: string) =>
      options?.[key] === undefined ? match : String(options[key]),
    );
  return { useT: () => translate };
});

function deferred<T>() {
  let resolveDeferred!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolveDeferred = resolve;
  });
  return { promise, resolve: resolveDeferred };
}

function apiResponse(data: unknown) {
  return {
    data: { data },
    status: 200,
    statusText: 'OK',
    headers: {},
    config: { headers: new AxiosHeaders() },
  };
}

function userRows(start: number, end: number) {
  return Array.from({ length: end - start + 1 }, (_, index) => ({ username: `user-${start + index}`, status: 1 }));
}

beforeEach(() => {
  vi.spyOn(window, 'matchMedia').mockImplementation((media) => ({
    matches: false,
    media,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SftpgoUsers', () => {
  it('preserves nested path permissions when editing root permissions', async () => {
    const app = ClientV2.createMockClient();
    vi.spyOn(ClientV2, 'useApp').mockReturnValue(app);
    const request = vi.spyOn(app.apiClient, 'request').mockImplementation(async (config) => {
      const url = 'url' in config ? config.url : undefined;
      if (url === 'sftpgoConnections:list') {
        return apiResponse([{ id: 1, name: 'Primary' }]);
      }
      if (url === 'sftpgoUsers:list') {
        return apiResponse([
          {
            username: 'alice',
            status: 1,
            email: 'alice@example.com',
            permissions: { '/': ['list'], '/private': ['list', 'download'] },
          },
        ]);
      }
      return apiResponse({});
    });

    render(<SftpgoUsers />);
    await screen.findByText('alice');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.mouseDown(screen.getByLabelText('Permissions (root path)'));
    fireEvent.click(await screen.findByText('Download'));
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }));

    await waitFor(() => {
      const update = request.mock.calls.find(([config]) => 'url' in config && config.url === 'sftpgoUsers:update');
      expect(update).toBeDefined();
      if (!update) throw new Error('User update request was not sent');
      expect(update[0]).toMatchObject({
        params: { connectionId: 1, filterByTk: 'alice' },
        data: { permissions: { '/': ['list', 'download'], '/private': ['list', 'download'] } },
      });
    });
  });

  it('omits permissions from an email-only update', async () => {
    const app = ClientV2.createMockClient();
    vi.spyOn(ClientV2, 'useApp').mockReturnValue(app);
    const request = vi.spyOn(app.apiClient, 'request').mockImplementation(async (config) => {
      const url = 'url' in config ? config.url : undefined;
      if (url === 'sftpgoConnections:list') return apiResponse([{ id: 1, name: 'Primary' }]);
      if (url === 'sftpgoUsers:list') {
        return apiResponse([
          {
            username: 'alice',
            status: 1,
            email: 'alice@example.com',
            permissions: { '/': ['list'], '/private': ['list', 'download'] },
          },
        ]);
      }
      return apiResponse({});
    });

    render(<SftpgoUsers />);
    await screen.findByText('alice');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }));

    await waitFor(() => {
      const update = request.mock.calls.find(([config]) => 'url' in config && config.url === 'sftpgoUsers:update');
      expect(update).toBeDefined();
      if (!update) throw new Error('User update request was not sent');
      const payload = 'data' in update[0] ? (update[0].data as Record<string, unknown>) : {};
      expect(payload).not.toHaveProperty('permissions');
    });
  });

  it('requests 50-row pages and exposes data past the first 100 users', async () => {
    const app = ClientV2.createMockClient();
    vi.spyOn(ClientV2, 'useApp').mockReturnValue(app);
    const request = vi.spyOn(app.apiClient, 'request').mockImplementation(async (config) => {
      const url = 'url' in config ? config.url : undefined;
      const params = 'params' in config && config.params ? (config.params as Record<string, unknown>) : {};
      if (url === 'sftpgoConnections:list') return apiResponse([{ id: 1, name: 'Server A' }]);
      if (url === 'sftpgoUsers:list') {
        const offset = Number(params.offset ?? 0);
        if (offset === 0) return apiResponse(userRows(1, 51));
        if (offset === 50) return apiResponse(userRows(51, 101));
        return apiResponse(userRows(101, 101));
      }
      return apiResponse({});
    });

    render(<SftpgoUsers />);
    await screen.findByText('user-1');
    expect(screen.queryByText('user-51')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('user-51');
    expect(screen.queryByText('user-101')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('user-101');

    const listCalls = request.mock.calls.filter(([config]) => 'url' in config && config.url === 'sftpgoUsers:list');
    expect(
      listCalls.map(([config]) => {
        const params = 'params' in config ? (config.params as Record<string, unknown>) : {};
        return { limit: params.limit, offset: params.offset };
      }),
    ).toEqual([
      { limit: 51, offset: 0 },
      { limit: 51, offset: 50 },
      { limit: 51, offset: 100 },
    ]);
  });

  it('resets pagination and ignores a stale page response after changing connections', async () => {
    const app = ClientV2.createMockClient();
    vi.spyOn(ClientV2, 'useApp').mockReturnValue(app);
    const stalePage = deferred<ReturnType<typeof apiResponse>>();
    const request = vi.spyOn(app.apiClient, 'request').mockImplementation(async (config) => {
      const url = 'url' in config ? config.url : undefined;
      const params = 'params' in config && config.params ? (config.params as Record<string, unknown>) : {};
      if (url === 'sftpgoConnections:list') {
        return apiResponse([
          { id: 1, name: 'Server A' },
          { id: 2, name: 'Server B' },
        ]);
      }
      if (url === 'sftpgoUsers:list') {
        if (params.connectionId === 1 && params.offset === 50) return stalePage.promise;
        if (params.connectionId === 1) return apiResponse(userRows(1, 51));
        return apiResponse([{ username: 'bob', status: 1 }]);
      }
      return apiResponse({});
    });

    render(<SftpgoUsers />);
    await screen.findByText('user-1');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(
        request.mock.calls.some(
          ([config]) =>
            'url' in config &&
            config.url === 'sftpgoUsers:list' &&
            'params' in config &&
            (config.params as Record<string, unknown>).offset === 50,
        ),
      ).toBe(true);
    });
    fireEvent.mouseDown(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByText('Server B'));
    await waitFor(() => {
      expect(
        request.mock.calls.some(
          ([config]) =>
            'url' in config &&
            config.url === 'sftpgoUsers:list' &&
            'params' in config &&
            (config.params as Record<string, unknown>).connectionId === 2 &&
            (config.params as Record<string, unknown>).offset === 0,
        ),
      ).toBe(true);
    });

    await screen.findByText('bob');
    expect(screen.getByText('Page 1')).toBeTruthy();
    stalePage.resolve(apiResponse([{ username: 'stale-user', status: 1 }]));
    await waitFor(() => expect(screen.queryByText('stale-user')).toBeNull());
    expect(screen.getByText('bob')).toBeTruthy();
  });

  it('moves back to the previous page when deleting the last row on a page', async () => {
    const app = ClientV2.createMockClient();
    vi.spyOn(ClientV2, 'useApp').mockReturnValue(app);
    let pageOneDeleted = false;
    const request = vi.spyOn(app.apiClient, 'request').mockImplementation(async (config) => {
      const url = 'url' in config ? config.url : undefined;
      const params = 'params' in config && config.params ? (config.params as Record<string, unknown>) : {};
      if (url === 'sftpgoConnections:list') return apiResponse([{ id: 1, name: 'Server A' }]);
      if (url === 'sftpgoUsers:list') {
        if (Number(params.offset ?? 0) === 50) {
          return apiResponse(pageOneDeleted ? [] : [{ username: 'last-user', status: 1 }]);
        }
        return apiResponse(userRows(1, 51));
      }
      if (url === 'sftpgoUsers:destroy') {
        pageOneDeleted = true;
        return apiResponse(true);
      }
      return apiResponse({});
    });

    render(<SftpgoUsers />);
    await screen.findByText('user-1');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('last-user');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await screen.findByText('Delete this user?');
    fireEvent.click(screen.getByRole('button', { name: /OK/i }));
    await screen.findByText('user-1');

    await waitFor(() => {
      expect(screen.getByText('Page 1')).toBeTruthy();
      const listCalls = request.mock.calls.filter(([config]) => 'url' in config && config.url === 'sftpgoUsers:list');
      expect(
        listCalls.some(([config]) => {
          const params = 'params' in config ? (config.params as Record<string, unknown>) : {};
          return params.offset === 0;
        }),
      ).toBe(true);
    });
  });
});
