import { useApp } from '@nocobase/client';

export const namespace = 'plugin-git-manager';

export function useT() {
  const app = useApp();
  return (str: string, options?: any): string =>
    app.i18n.t(str, { ns: [namespace, 'client'], ...options }) as unknown as string;
}
