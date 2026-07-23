import { tExpr as _tExpr, useFlowEngine } from '@nocobase/flow-engine';
import { useCallback } from 'react';
// @ts-ignore package metadata is provided by the plugin build
import pkg from '../../package.json';

export function useT() {
  const engine = useFlowEngine();
  return useCallback((key: string) => engine.context.t(key, { ns: [pkg.name, 'client'] }), [engine]);
}

export function tExpr(key: string) {
  return _tExpr(key, { ns: [pkg.name, 'client'] });
}
