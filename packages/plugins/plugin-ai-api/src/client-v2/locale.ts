// SPDX-License-Identifier: Apache-2.0

import { useCallback } from 'react';
import { tExpr as _tExpr } from '@nocobase/flow-engine';
import { useApp } from '@nocobase/client-v2';
// @ts-ignore
import pkg from './../../package.json';

export function useT() {
  const app = useApp();
  // Stable identity so callers can safely list `t` in hook dependency arrays.
  return useCallback((str: string) => app.i18n.t(str, { ns: [pkg.name, 'client'] }), [app]);
}

export function tExpr(key: string) {
  return _tExpr(key, { ns: [pkg.name, 'client'] });
}
