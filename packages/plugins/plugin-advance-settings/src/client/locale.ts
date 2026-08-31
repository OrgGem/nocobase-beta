import { useTranslation } from 'react-i18next';

export const NAMESPACE = 'plugin-advance-settings';

export function useT() {
  const { t } = useTranslation(NAMESPACE, { nsMode: 'fallback' });
  return t;
}
