// SPDX-License-Identifier: Apache-2.0

import { tExpr as _tExpr, useFlowEngine } from '@nocobase/flow-engine';
import { useCallback } from 'react';
// @ts-ignore
import pkg from '../../package.json';

export function useT() {
  const engine = useFlowEngine();
  return useCallback((str: string) => engine.context.t(str, { ns: [pkg.name, 'client'] }), [engine]);
}

export function tExpr(key: string) {
  return _tExpr(key, { ns: [pkg.name, 'client'] });
}
