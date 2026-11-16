// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from 'react-i18next';

export function useT() {
  return useTranslation(['plugin-next-app-client', 'client']).t;
}
