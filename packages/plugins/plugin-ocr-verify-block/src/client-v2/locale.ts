import { useTranslation } from 'react-i18next';
import { NAMESPACE } from '../shared/constants';

export function useT() {
  return useTranslation([NAMESPACE, 'client']).t;
}
