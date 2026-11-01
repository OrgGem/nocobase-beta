import { useTranslation } from 'react-i18next';

export function useT() {
  return useTranslation(['plugin-ai-browser', 'client']).t;
}
