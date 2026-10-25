/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { useApp } from '@nocobase/client-v2';
import { useCurrentInstance } from '../context/InstanceContext';
import { useState, useEffect, useCallback, useRef } from 'react';
import type { AxiosResponse } from 'axios';

type ResponseData = AxiosResponse['data'];

export function useN8nRequest(resource: string, action: string, extraParams: Record<string, unknown> = {}) {
  const api = useApp().apiClient;
  const { instanceId } = useCurrentInstance();
  const paramsKey = JSON.stringify(extraParams);
  const requestKey = JSON.stringify([instanceId, resource, action, paramsKey]);
  const [state, setState] = useState<{ key: string; data: ResponseData; loading: boolean; error: Error | null }>({
    key: '',
    data: null,
    loading: false,
    error: null,
  });
  const generation = useRef(0);
  const controller = useRef<AbortController>();
  const extraParamsRef = useRef(extraParams);
  extraParamsRef.current = extraParams;

  const run = useCallback(async () => {
    const current = ++generation.current;
    controller.current?.abort();
    if (!instanceId) {
      setState({ key: requestKey, data: null, loading: false, error: null });
      return;
    }
    const active = new AbortController();
    controller.current = active;
    setState({ key: requestKey, data: null, loading: true, error: null });
    try {
      const res = await api.request({
        url: `${resource}:${action}`,
        params: { instanceId, ...extraParamsRef.current },
        signal: active.signal,
      });
      const result = res?.data?.data ?? res?.data;
      if (current === generation.current && !active.signal.aborted) {
        setState({ key: requestKey, data: result, loading: false, error: null });
        return result;
      }
    } catch (err: unknown) {
      if (current === generation.current && !active.signal.aborted)
        setState({
          key: requestKey,
          data: null,
          loading: false,
          error: err instanceof Error ? err : new Error(String(err)),
        });
    }
  }, [api, instanceId, resource, action, requestKey]);

  const invalidateRequests = useCallback(() => {
    generation.current++;
    controller.current?.abort();
  }, []);

  // Re-fetch when the selected instance, action or parameters change.
  useEffect(() => {
    run();
    return invalidateRequests;
  }, [run, invalidateRequests]);

  return {
    data: state.key === requestKey ? state.data : null,
    loading: state.key === requestKey ? state.loading : !!instanceId,
    error: state.key === requestKey ? state.error : null,
    refresh: run,
  };
}
