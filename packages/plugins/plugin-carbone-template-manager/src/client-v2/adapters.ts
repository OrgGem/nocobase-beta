import { useMemo } from 'react';
import { useApp } from '@nocobase/client-v2';
import { useRequest as useAhooksRequest } from 'ahooks';

/**
 * client-v2 adapters that mirror the small slice of the v1 `@nocobase/client`
 * surface the ported settings components rely on, so their bodies stay
 * unchanged across the migration.
 *
 *   - `useAPIClient()` → the app's APIClient (same `resource()/request()` API).
 *   - `useRequest()`   → `ahooks` useRequest, which already backs the v1 hook,
 *                        keeping `{ data, loading, refresh }` + `{ refreshDeps,
 *                        ready }` semantics identical.
 */
export function useAPIClient() {
  const app = useApp();
  return useMemo(() => app.apiClient, [app]);
}

export function useRequest<T = any>(
  service: (...args: any[]) => Promise<T>,
  options?: { refreshDeps?: any[]; ready?: boolean; manual?: boolean },
) {
  return useAhooksRequest<T, any[]>(service, options as any);
}
