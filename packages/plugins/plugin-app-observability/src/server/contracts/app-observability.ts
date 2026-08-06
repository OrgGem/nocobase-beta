import { assessCapacityFromSnapshot } from '../capacity/capacity-engine';
import type { MetricsStore } from '../metrics/metrics-store';
import type { AppObservabilityContract, ObservationHandle, ObservationStart, ServiceDefinition } from './types';

const CONTRACT_SYMBOL = Symbol.for('nocobase.app-observability.contract');
type ContractHost = object & { [CONTRACT_SYMBOL]?: AppObservabilityContract };

export function getAppObservability(app: object): AppObservabilityContract | undefined {
  return (app as ContractHost)[CONTRACT_SYMBOL];
}
export function registerAppObservability(app: object, contract: AppObservabilityContract): () => void {
  const host = app as ContractHost;
  host[CONTRACT_SYMBOL] = contract;
  return () => {
    if (host[CONTRACT_SYMBOL] === contract) delete host[CONTRACT_SYMBOL];
  };
}
export function createAppObservabilityContract(
  store: MetricsStore,
  options: { getCapacityAssessment?: AppObservabilityContract['getCapacityAssessment'] } = {},
): AppObservabilityContract {
  const definitions = new Map<string, ServiceDefinition>();
  return {
    start: (input) => store.start(input),
    async observe<T>(input: ObservationStart, run: (handle: ObservationHandle) => Promise<T>): Promise<T> {
      const handle = store.start(input);
      try {
        const result = await run(handle);
        handle.finish({ status: 'succeeded' });
        return result;
      } catch (error) {
        handle.finish({ status: 'failed', errorCode: normalizeErrorCode(error) });
        throw error;
      }
    },
    getNodeSnapshot: () => store.getSnapshot(),
    getCapacityAssessment: options.getCapacityAssessment ?? (() => assessCapacityFromSnapshot(store.getSnapshot())),
    registerService(definition) {
      definitions.set(definition.service, definition);
      return () => definitions.delete(definition.service);
    },
  };
}
function normalizeErrorCode(error: unknown): string | undefined {
  const value = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return typeof value === 'string' ? value.slice(0, 64) : undefined;
}
