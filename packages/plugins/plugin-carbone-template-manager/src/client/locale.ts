import { i18n } from '@nocobase/client';
import { useTranslation } from 'react-i18next';
import { NAMESPACE } from '../shared/constants';

export { NAMESPACE };

export function lang(key: string, options?: any) {
  return i18n.t(key, { ns: NAMESPACE, ...options });
}

export function useCarboneTranslation() {
  return useTranslation(NAMESPACE);
}
