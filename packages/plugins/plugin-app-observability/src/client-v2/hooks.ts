import { useApp } from '@nocobase/client-v2';
import { useCallback, useEffect, useState } from 'react';

export function useVisiblePolling<T>(
  loader: (api: ReturnType<typeof useApp>['apiClient']) => Promise<T>,
  interval = 10_000,
) {
  const api = useApp().apiClient;
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    if (typeof document !== 'undefined' && document.hidden) return;
    try {
      setData(await loader(api));
      setError(undefined);
    } catch (loadError) {
      setError(loadError);
    } finally {
      setLoading(false);
    }
  }, [api, loader]);
  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, Math.max(5_000, interval));
    const handleVisibility = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [interval, refresh]);
  return { data, error, loading, refresh };
}
