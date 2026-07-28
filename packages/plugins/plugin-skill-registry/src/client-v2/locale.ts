import { tExpr as createTranslationExpression, useFlowEngine } from '@nocobase/flow-engine';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore JSON module declaration is supplied by the plugin build.
import pkg from './../../package.json';

export function useT() {
  const engine = useFlowEngine();
  return (key: string, options?: Record<string, unknown>) =>
    engine.context.t(key, { ...options, ns: [pkg.name, 'client'] });
}

export function tExpr(key: string) {
  return createTranslationExpression(key, { ns: [pkg.name, 'client'] });
}
