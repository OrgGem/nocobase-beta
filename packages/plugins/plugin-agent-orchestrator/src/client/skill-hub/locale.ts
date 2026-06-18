import { useApp } from '@nocobase/client-v2';
import { useCallback } from 'react';
export const namespace = 'plugin-agent-orchestrator';

export function useT() {
  const app = useApp();
  return useCallback(
    (str: string, options?: any): string =>
      app.i18n.t(str, { ns: [namespace, 'client'], ...options }) as unknown as string,
    [app.i18n]
  );
}

export function tStr(key: string) {
  return `{{t(${JSON.stringify(key)}, { ns: ['${namespace}', 'client'], nsMode: 'fallback' })}}`;
}
