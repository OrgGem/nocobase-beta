import { useAPIClient } from '@nocobase/client';
import { useCurrentInstance } from '../context/InstanceContext';
import { useState, useEffect, useCallback, useRef } from 'react';

export function useN8nRequest(resource: string, action: string, extraParams: any = {}) {
  const api = useAPIClient();
  const { instanceId } = useCurrentInstance();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const extraParamsRef = useRef(extraParams);
  extraParamsRef.current = extraParams;

  const run = useCallback(
    async (overrideParams?: any) => {
      if (!instanceId) return;
      setLoading(true);
      setError(null);
      try {
        const res = await api.request({
          url: `${resource}:${action}`,
          params: { instanceId, ...extraParamsRef.current, ...overrideParams },
        });
        const result = res?.data?.data ?? res?.data;
        setData(result);
        return result;
      } catch (err: any) {
        setError(err);
      } finally {
        setLoading(false);
      }
    },
    [api, instanceId, resource, action],
  );

  // Re-fetch when extraParams change (via stringified comparison)
  const paramsKey = JSON.stringify(extraParams);
  useEffect(() => {
    run();
  }, [run, paramsKey]);

  return { data, loading, error, refresh: run };
}
