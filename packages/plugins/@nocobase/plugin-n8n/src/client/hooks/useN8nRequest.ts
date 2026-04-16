import { useAPIClient } from '@nocobase/client';
import { useCurrentInstance } from '../context/InstanceContext';
import { useState, useEffect, useCallback } from 'react';

export function useN8nRequest(resource: string, action: string, extraParams: any = {}) {
  const api = useAPIClient();
  const { instanceId } = useCurrentInstance();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const run = useCallback(
    async (overrideParams?: any) => {
      if (!instanceId) return;
      setLoading(true);
      setError(null);
      try {
        const res = await api.request({
          url: `${resource}:${action}`,
          params: { instanceId, ...extraParams, ...overrideParams },
        });
        setData(res?.data?.data ?? res?.data);
        return res?.data?.data ?? res?.data;
      } catch (err: any) {
        setError(err);
      } finally {
        setLoading(false);
      }
    },
    [api, instanceId, resource, action, JSON.stringify(extraParams)],
  );

  useEffect(() => {
    run();
  }, [run]);

  return { data, loading, error, refresh: run };
}
