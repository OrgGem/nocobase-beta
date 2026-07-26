import { tExpr as createTranslationExpression } from '@nocobase/flow-engine';
import { name } from '../locale/namespace';

export function tExpr(key: string) {
  return createTranslationExpression(key, { ns: [name, 'client'] });
}
