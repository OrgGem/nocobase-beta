import { useApp } from '@nocobase/client';

export const NAMESPACE = 'plugin-block-embed-settings';

export function useT() {
  const app = useApp();
  return (key: string) => app.i18n.t(key, { ns: [NAMESPACE, 'client'], nsMode: 'fallback' });
}

export function tStr(key: string) {
  return `{{t(${JSON.stringify(key)}, { ns: ['${NAMESPACE}', 'client'], nsMode: 'fallback' })}}`;
}
