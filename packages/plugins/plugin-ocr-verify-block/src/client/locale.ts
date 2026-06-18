import { useApp } from '@nocobase/client-v2';
import { useCallback } from 'react';
import { NAMESPACE } from '../shared/constants';

export const namespace = NAMESPACE;

export function useT() {
  const app = useApp();
  return useCallback(
    (key: string, options?: Record<string, unknown>): string =>
      app.i18n.t(key, { ns: [namespace, 'client'], nsMode: 'fallback', ...options }) as unknown as string,
    [app.i18n],
  );
}

export function tStr(key: string) {
  return `{{t(${JSON.stringify(key)}, { ns: ['${namespace}', 'client'], nsMode: 'fallback' })}}`;
}
