// SPDX-License-Identifier: Apache-2.0

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
