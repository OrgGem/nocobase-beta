import { tExpr as baseTExpr, useFlowEngine } from '@nocobase/flow-engine';
import { reactTranslationOptions, type ReactTranslationOptions } from '../shared/translation-options';
// @ts-ignore Generated plugin metadata has no declaration file.
import pkg from './../../package.json';

export function useT() {
  const engine = useFlowEngine();
  return (key: string, options?: ReactTranslationOptions) =>
    engine.context.t(key, { ...reactTranslationOptions(options), ns: [pkg.name, 'client'] });
}

export function tExpr(key: string) {
  return baseTExpr(key, { ns: [pkg.name, 'client'] });
}
