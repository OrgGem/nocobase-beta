import { useAPIClient } from '@nocobase/client';
import { useCurrentInstance } from '../context/InstanceContext';
import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Hook for calling UiPath proxy resource actions.
 * Automatically injects instanceId, folderId, folderKey from context.
 */
export function useUiPathRequest(resource: string, action: string, extraParams: any = {}) {
  const api = useAPIClient();
  const { instanceId, folderId, folderKey } = useCurrentInstance();
  const [data, setData] = useState<any>(null);
  const [meta, setMeta] = useState<any>(null);
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
          params: {
            instanceId,
            folderId,
            folderKey,
            ...extraParamsRef.current,
            ...overrideParams,
          },
        });
        const result = res?.data?.data ?? res?.data;
        setData(result);
        setMeta(res?.data);
        return result;
      } catch (err: any) {
        setError(err);
      } finally {
        setLoading(false);
      }
    },
    [api, instanceId, folderId, folderKey, resource, action],
  );

  // Re-fetch when deps change
  const paramsKey = JSON.stringify(extraParams);
  useEffect(() => {
    run();
  }, [run, paramsKey]);

  return { data, meta, loading, error, refresh: run };
}
