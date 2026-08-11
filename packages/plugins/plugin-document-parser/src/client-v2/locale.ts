import { useCallback } from 'react';
import { useFlowEngine } from '@nocobase/flow-engine';
// @ts-ignore
import pkg from './../../package.json';

export function useT() {
  const engine = useFlowEngine();
  return useCallback((key: string) => engine.context.t(key, { ns: [pkg.name, 'client'] }), [engine]);
}
