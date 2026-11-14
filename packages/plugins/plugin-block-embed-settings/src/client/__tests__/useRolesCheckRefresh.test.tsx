// SPDX-License-Identifier: Apache-2.0

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRolesCheckRefresh } from '../../shared/useRolesCheckRefresh';

type Response = { config?: { url?: string }; data?: { data?: { role?: string } } };

describe('useRolesCheckRefresh', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refreshes after a roles:check response settles, including a role whose value did not change', async () => {
    vi.useFakeTimers();
    let onResponse: ((response: Response) => Response) | undefined;
    const responseInterceptor = {
      use: vi.fn((fulfilled: (response: Response) => Response) => {
        onResponse = fulfilled;
        return 4;
      }),
      eject: vi.fn(),
    };
    const api = { axios: { interceptors: { response: responseInterceptor } } } as never;
    const { result, unmount } = renderHook(() => useRolesCheckRefresh(api));

    expect(result.current).toEqual({ version: 0, valid: true });
    act(() => {
      onResponse?.({ config: { url: '/api/roles:check?include=permissions' }, data: { data: { role: 'admin' } } });
    });
    expect(result.current.version).toBe(0);

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(result.current).toEqual({ version: 1, valid: true });
    unmount();
    expect(responseInterceptor.eject).toHaveBeenCalledWith(4);
  });

  it('ignores unrelated responses and fails closed when roles:check fails', async () => {
    let onResponse: ((response: Response) => Response) | undefined;
    let onRejected: ((error: { config?: { url?: string } }) => Promise<never>) | undefined;
    const responseInterceptor = {
      use: vi.fn(
        (
          fulfilled: (response: Response) => Response,
          rejected: (error: { config?: { url?: string } }) => Promise<never>,
        ) => {
          onResponse = fulfilled;
          onRejected = rejected;
          return 7;
        },
      ),
      eject: vi.fn(),
    };
    const api = { axios: { interceptors: { response: responseInterceptor } } } as never;
    const { result } = renderHook(() => useRolesCheckRefresh(api));

    act(() => {
      onResponse?.({ config: { url: '/api/embedSettings:enabled' }, data: { data: { role: 'admin' } } });
    });
    expect(result.current.version).toBe(0);

    await act(async () => {
      await expect(onRejected?.({ config: { url: '/api/roles:check' } })).rejects.toBeDefined();
    });
    expect(result.current.valid).toBe(false);
  });

  it('drops stale role-check timers and ignores callbacks after cleanup', async () => {
    vi.useFakeTimers();
    let onResponse: ((response: Response) => Response) | undefined;
    const responseInterceptor = {
      use: vi.fn((fulfilled: (response: Response) => Response) => {
        onResponse = fulfilled;
        return 9;
      }),
      eject: vi.fn(),
    };
    const api = { axios: { interceptors: { response: responseInterceptor } } } as never;
    const { result, unmount } = renderHook(() => useRolesCheckRefresh(api));

    act(() => {
      onResponse?.({ config: { url: '/api/roles:check' }, data: { data: { role: 'admin' } } });
      onResponse?.({ config: { url: '/api/roles:check' }, data: { data: { role: '' } } });
    });
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(result.current.version).toBe(1);
    expect(result.current.valid).toBe(false);

    act(() => {
      onResponse?.({ config: { url: '/api/roles:check' }, data: { data: { role: 'admin' } } });
    });
    unmount();
    await vi.runOnlyPendingTimersAsync();
    expect(responseInterceptor.eject).toHaveBeenCalledWith(9);
  });
});
