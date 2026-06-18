import { useApp } from '@nocobase/client-v2';
import { useCallback } from 'react';
import { name } from '../locale/namespace';

export const namespace = name;

export function useT() {
  const app = useApp();
  return useCallback(
    (str: string, options?: Record<string, unknown>): string =>
      app.i18n.t(str, { ns: [namespace, 'client'], ...options }) as unknown as string,
    [app.i18n],
  );
}

export function tStr(key: string) {
  return `{{t(${JSON.stringify(key)}, { ns: ['${namespace}', 'client'], nsMode: 'fallback' })}}`;
}
