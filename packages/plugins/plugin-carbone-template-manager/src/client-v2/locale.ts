import { useFlowEngine } from '@nocobase/flow-engine';
import { NAMESPACE } from '../shared/constants';

export { NAMESPACE };

/**
 * client-v2 translation helper. Returns `{ t }` so the ported components can
 * keep using `const { t } = useCarboneTranslation()` unchanged. Strings resolve
 * against the plugin's package-name namespace (same JSON files under
 * `src/locale/` that the v1 lane uses).
 */
export function useCarboneTranslation() {
  const engine = useFlowEngine();
  const t = (key: string, options?: Record<string, unknown>) =>
    engine.context.t(key, { ns: [NAMESPACE, 'client'], ...(options || {}) });
  return { t };
}
