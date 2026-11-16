// SPDX-License-Identifier: Apache-2.0

import { tExpr as _tExpr, useFlowEngine } from '@nocobase/flow-engine';
import { reactTranslationOptions, type ReactTranslationOptions } from '../shared/translation-options';
// @ts-ignore
import pkg from '../../package.json';

export function useT() {
  const engine = useFlowEngine();
  return (str: string, options?: ReactTranslationOptions) =>
    engine.context.t(str, { ...reactTranslationOptions(options), ns: [pkg.name, 'client'] });
}

export function tExpr(key: string) {
  return _tExpr(key, { ns: [pkg.name, 'client'] });
}
