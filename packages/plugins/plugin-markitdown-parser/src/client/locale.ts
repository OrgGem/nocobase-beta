import { i18n } from '@nocobase/client';
import { useTranslation } from 'react-i18next';

export const NAMESPACE = 'plugin-markitdown-parser';

export function lang(key: string, options?: any) {
  return i18n.t(key, { ns: NAMESPACE, ...options });
}

export function useMarkItDownParserTranslation() {
  return useTranslation(NAMESPACE);
}
