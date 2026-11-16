// SPDX-License-Identifier: Apache-2.0

import { useApp } from '@nocobase/client-v2';
import { useCallback } from 'react';

export const namespace = 'plugin-workflow-git-review';
export const tExpr = (key: string) => `{{t("${key}", { ns: "${namespace}" })}}`;

export function useT() {
  const app = useApp();
  return useCallback((key: string) => app.i18n.t(key, { ns: [namespace, 'client'] }) as string, [app.i18n]);
}
