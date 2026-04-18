import { useApp } from '@nocobase/client';
import pkg from './../../package.json';

export const NAMESPACE = pkg.name;

export function useT() {
  const app = useApp();
  return (key: string) => app.i18n.t(key, { ns: [NAMESPACE, 'client'], nsMode: 'fallback' });
}

export function tStr(key: string) {
  return `{{t(${JSON.stringify(key)}, { ns: ['${NAMESPACE}', 'client'], nsMode: 'fallback' })}}`;
}
