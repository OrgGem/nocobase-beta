import { useApp } from '@nocobase/client-v2';

export const namespace = '@nocobase/plugin-n8n';

export function useT() {
  const app = useApp();
  return (str: string, options?: any): string => app.i18n.t(str, { ns: [namespace, 'client'], ...options }) as unknown as string;
}

export function tStr(key: string) {
  return `{{t(${JSON.stringify(key)}, { ns: ['${namespace}', 'client'], nsMode: 'fallback' })}}`;
}
