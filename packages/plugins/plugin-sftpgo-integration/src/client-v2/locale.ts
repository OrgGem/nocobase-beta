import { useFlowEngine } from '@nocobase/flow-engine';

export const NAMESPACE = 'plugin-sftpgo-integration';

export function useT() {
  const engine = useFlowEngine();
  return (str: string, options?: Record<string, unknown>) =>
    engine.context.t(str, { ...options, ns: [NAMESPACE, 'client'] });
}
