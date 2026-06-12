import { tExpr as flowTExpr, useFlowEngine } from '@nocobase/flow-engine';
// @ts-ignore
import pkg from '../../package.json';

export const NAMESPACE = pkg.name;

export function useT() {
  const engine = useFlowEngine();
  return (key: string) => engine.context.t(key, { ns: [NAMESPACE, 'client'], nsMode: 'fallback' });
}

export function tExpr(key: string) {
  return flowTExpr(key, { ns: [NAMESPACE, 'client'], nsMode: 'fallback' });
}
