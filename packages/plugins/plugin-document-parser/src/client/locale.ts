// SPDX-License-Identifier: Apache-2.0

import { i18n } from '@nocobase/client';
import { useTranslation } from 'react-i18next';

export const NAMESPACE = 'plugin-document-parser';

export function lang(key: string, options?: any) {
  return i18n.t(key, { ns: NAMESPACE, ...options });
}

export function useDocParserTranslation() {
  return useTranslation(NAMESPACE);
}
