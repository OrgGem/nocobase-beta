/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { tExpr as createTranslationExpression } from '@nocobase/flow-engine';
import { name } from '../locale/namespace';
import { useApp } from '@nocobase/client-v2';
import { useCallback } from 'react';

export function useT() {
  const app = useApp();
  return useCallback(
    (key: string, options?: Record<string, unknown>) => String(app.i18n.t(key, { ns: [name, 'client'], ...options })),
    [app.i18n],
  );
}

export function tExpr(key: string) {
  return createTranslationExpression(key, { ns: [name, 'client'] });
}
