import { useFlowEngine } from '@nocobase/flow-engine';
import packageJson from '../../package.json';

export function useT() {
  const engine = useFlowEngine();
  return (key: string, options?: Record<string, unknown>) =>
    engine.context.t(key, { ns: [packageJson.name, 'client'], ...options }) as string;
}
