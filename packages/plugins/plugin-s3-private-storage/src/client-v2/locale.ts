import { useApp } from '@nocobase/client-v2';
import { NAMESPACE } from '../constants';

export function useT() {
  const app = useApp();
  return (key: string) => app.i18n.t(key, { ns: [NAMESPACE, 'client'], nsMode: 'fallback' });
}
