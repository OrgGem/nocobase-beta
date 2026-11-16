// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from 'react-i18next';

export const namespace = '@nocobase/plugin-custom-llm';

export function useT() {
  const { t } = useTranslation(namespace, { nsMode: 'fallback' });
  return t;
}
