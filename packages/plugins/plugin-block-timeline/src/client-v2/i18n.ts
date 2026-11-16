// SPDX-License-Identifier: Apache-2.0

import { tExpr as _tExpr, useFlowEngine } from '@nocobase/flow-engine';

export function useT() {
  const engine = useFlowEngine();
  return (str: string, options?: Record<string, unknown>) =>
    engine.context.t(str, { ...options, ns: ['plugin-block-timeline', 'client'] });
}

export function tExpr(key: string) {
  return _tExpr(key, { ns: ['plugin-block-timeline', 'client'] });
}
