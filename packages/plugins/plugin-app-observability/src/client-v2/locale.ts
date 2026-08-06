import { tExpr as createTExpr, useFlowEngine } from '@nocobase/flow-engine';
import packageJson from '../../package.json';
export function useT() {
  const engine = useFlowEngine();
  return (key: string) => engine.context.t(key, { ns: [packageJson.name, 'client'] });
}
export function tExpr(key: string) {
  return createTExpr(key, { ns: [packageJson.name, 'client'] });
}
