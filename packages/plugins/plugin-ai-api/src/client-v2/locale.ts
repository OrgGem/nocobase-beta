/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

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
