import { tExpr as createTExpr, useFlowEngine } from '@nocobase/flow-engine';
import packageJson from '../../package.json';
export function useT() {
  const engine = useFlowEngine();
  return (key: string, values?: Record<string, number | string>) =>
    engine.context.t(key, { ...values, ns: [packageJson.name, 'client'] });
}
export function tExpr(key: string) {
  return createTExpr(key, { ns: [packageJson.name, 'client'] });
}
