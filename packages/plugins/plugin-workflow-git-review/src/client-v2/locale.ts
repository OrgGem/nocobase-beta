/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { useApp } from '@nocobase/client-v2';
import { useCallback } from 'react';

export const namespace = 'plugin-workflow-git-review';
export const tExpr = (key: string) => `{{t("${key}", { ns: "${namespace}" })}}`;

export function useT() {
  const app = useApp();
  return useCallback((key: string) => app.i18n.t(key, { ns: [namespace, 'client'] }) as string, [app.i18n]);
}
