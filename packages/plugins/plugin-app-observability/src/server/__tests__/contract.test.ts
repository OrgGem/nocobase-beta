import { describe, expect, it } from 'vitest';

import { getAppObservability, registerAppObservability } from '../contracts';
import { MetricsStore } from '../metrics/metrics-store';
import { createAppObservabilityContract } from '../contracts/app-observability';

describe('app observability contract', () => {
  it('registers and unregisters per application without throwing when absent', () => {
    const app = {};
    expect(getAppObservability(app)).toBeUndefined();
    const contract = createAppObservabilityContract(new MetricsStore({ appName: 'main', nodeId: 'node-1' }));
    const unregister = registerAppObservability(app, contract);
    expect(getAppObservability(app)).toBe(contract);
    unregister();
    expect(getAppObservability(app)).toBeUndefined();
  });

  it('finishes an observation only once', () => {
    const store = new MetricsStore({ appName: 'main', nodeId: 'node-1' });
    const handle = createAppObservabilityContract(store).start({ service: 'custom', operation: 'sync' });
    handle.finish({ status: 'succeeded' });
    handle.finish({ status: 'failed' });
    const service = Object.values(store.getSnapshot().services)[0];
    expect(service.requestCount).toBe(1);
    expect(service.successCount).toBe(1);
    expect(service.failureCount).toBe(0);
    expect(service.inflight).toBe(0);
  });
});
