import { useTranslation } from 'react-i18next';
import { namespace } from '../constants';

export function useT() {
  return useTranslation([namespace, 'client'], { nsMode: 'fallback' }).t;
}
