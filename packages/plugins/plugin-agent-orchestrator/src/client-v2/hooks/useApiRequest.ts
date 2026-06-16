import { useApp } from '@nocobase/client-v2';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * client-v2 adapters for the two data-layer hooks the v1 admin tabs relied on
 * (`useAPIClient` and `useRequest` from `@nocobase/client`). client-v2 exposes
 * neither, so these reimplement just the slice the orchestrator UI uses on top
 * of `useApp().apiClient`, keeping the call sites unchanged.
 *
 * v1 contract preserved here:
 * - `useRequest` resolves `data` to the response BODY (`response.data`), so a
 *   list endpoint returning `{ data: rows, meta }` is read as `result.data.data`
 *   / `result.data.meta` — identical to the v1 tabs.
 */

export type ApiRequestService =
  | {
      url: string;
      method?: string;
      params?: Record<string, unknown>;
      data?: unknown;
    }
  | (() => Promise<unknown>);

export type ApiRequestOptions = {
  /** Do not fire on mount; caller triggers via `run`. */
  manual?: boolean;
  /** Re-run whenever any dependency changes (mirrors ahooks refreshDeps). */
  refreshDeps?: unknown[];
  onSuccess?: (data: unknown) => void;
  onError?: (error: unknown) => void;
};

export type ApiRequestResult<TData = unknown> = {
  data: TData | undefined;
  loading: boolean;
  error: unknown;
  refresh: () => void;
  run: (overrideParams?: Record<string, unknown>) => Promise<TData | undefined>;
};

/** Returns the v2 application's API client (replacement for v1 `useAPIClient`). */
export function useApiClient() {
  return useApp().apiClient;
}

/**
 * Minimal `useRequest` replacement. Supports object services
 * (`{ url, method, params }`) and function services, plus `manual`,
 * `refreshDeps`, and `onSuccess`/`onError` — the only options the tabs use.
 */
export function useRequest<TData = unknown>(
  service: ApiRequestService,
  options: ApiRequestOptions = {},
): ApiRequestResult<TData> {
  const api = useApiClient();
  const { manual = false, refreshDeps = [], onSuccess, onError } = options;

  const [data, setData] = useState<TData | undefined>(undefined);
  const [loading, setLoading] = useState<boolean>(!manual);
  const [error, setError] = useState<unknown>(undefined);

  // Keep the latest service/callbacks without forcing them into refreshDeps.
  const serviceRef = useRef(service);
  serviceRef.current = service;
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const run = useCallback(
    async (overrideParams?: Record<string, unknown>): Promise<TData | undefined> => {
      const current = serviceRef.current;
      setLoading(true);
      setError(undefined);
      try {
        let body: TData;
        if (typeof current === 'function') {
          body = (await current()) as TData;
        } else {
          const response = await api.request({
            url: current.url,
            method: current.method || 'get',
            params: { ...(current.params || {}), ...(overrideParams || {}) },
            data: current.data,
          });
          body = response?.data as TData;
        }
        setData(body);
        onSuccessRef.current?.(body);
        return body;
      } catch (err) {
        setError(err);
        onErrorRef.current?.(err);
        return undefined;
      } finally {
        setLoading(false);
      }
    },
    [api],
  );

  const refresh = useCallback(() => {
    run();
  }, [run]);

  useEffect(() => {
    if (manual) return;
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, refreshDeps);

  return { data, loading, error, refresh, run };
}
