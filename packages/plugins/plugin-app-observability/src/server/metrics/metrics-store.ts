import type { NodeObservabilitySnapshot, ObservationFinish, ObservationHandle, ObservationStart } from '../contracts';
import type { RuntimeSnapshot } from '../runtime/runtime-types';
import { ActiveUserWindow } from './active-users';
import { createServiceMetric, seriesKey, snapshotService, type MutableServiceMetric } from './service-registry';

export interface MetricsStoreOptions {
  appName: string;
  nodeId: string;
  workerMode?: string;
  maxSeries?: number;
  activeUserWindowMs?: number;
  now?: () => number;
}
export class MetricsStore {
  private readonly now: () => number;
  private readonly services = new Map<string, MutableServiceMetric>();
  private readonly activeUsers: ActiveUserWindow;
  private runtime: RuntimeSnapshot | null = null;
  private accepting = true;
  constructor(private readonly options: MetricsStoreOptions) {
    this.now = options.now ?? Date.now;
    this.activeUsers = new ActiveUserWindow(options.activeUserWindowMs ?? 300_000, this.now);
  }
  start(input: ObservationStart): ObservationHandle {
    if (!this.accepting) return NOOP_HANDLE;
    let metric = this.resolveMetric(input);
    const startedAt = this.now();
    let firstByteMarked = false;
    let finished = false;
    metric.requestCount += 1;
    metric.inflight += 1;
    metric.maxInflight = Math.max(metric.maxInflight, metric.inflight);
    return {
      markFirstByte: () => {
        if (!finished && !firstByteMarked) {
          firstByteMarked = true;
          metric.firstByteHistogram.observe(this.now() - startedAt);
        }
      },
      addInputTokens: (value) => {
        if (!finished) metric.inputTokens += positive(value);
      },
      addOutputTokens: (value) => {
        if (!finished) metric.outputTokens += positive(value);
      },
      finish: (result) => {
        if (finished) return;
        finished = true;
        if (result.operation && result.operation !== metric.operation)
          metric = this.reassign(metric, { ...input, operation: result.operation });
        this.finish(metric, startedAt, result);
      },
    };
  }
  observeActiveUser(identifier: string | number): void {
    this.activeUsers.observe(identifier);
  }
  setRuntimeSnapshot(snapshot: RuntimeSnapshot | null): void {
    this.runtime = snapshot;
  }
  setActiveUserWindowMs(windowMs: number): void {
    this.activeUsers.setWindowMs(windowMs);
  }
  stopAccepting(): void {
    this.accepting = false;
  }
  startAccepting(): void {
    this.accepting = true;
  }
  getSnapshot(): NodeObservabilitySnapshot {
    return {
      schemaVersion: 1,
      appName: this.options.appName,
      nodeId: this.options.nodeId,
      timestamp: this.now(),
      workerMode: this.options.workerMode ?? process.env.WORKER_MODE ?? 'web',
      activeUsers: this.activeUsers.count(),
      runtime: this.runtime ? { ...this.runtime } : null,
      services: Object.fromEntries([...this.services].map(([key, metric]) => [key, snapshotService(metric)])),
    };
  }
  /**
   * Captures one persistence interval and then carries active requests into the
   * next interval. This prevents an old concurrency spike from being written to
   * every subsequent bucket.
   */
  getBucketSnapshot(): NodeObservabilitySnapshot {
    const snapshot = this.getSnapshot();
    for (const metric of this.services.values()) metric.maxInflight = metric.inflight;
    return snapshot;
  }
  private resolveMetric(input: ObservationStart): MutableServiceMetric {
    const key = seriesKey(input);
    const existing = this.services.get(key);
    if (existing) return existing;

    const maxSeries = Math.max(1, this.options.maxSeries ?? 500);
    // Reserve the final bounded slot for overflow so cardinality never exceeds maxSeries.
    if (this.services.size < maxSeries - 1) {
      const metric = createServiceMetric(input);
      this.services.set(key, metric);
      return metric;
    }
    const overflow = this.services.get(OVERFLOW_KEY);
    if (overflow) return overflow;
    // Label the shared bucket generically; the first overflowing request must not
    // brand every later one with its own service/operation.
    const metric = createServiceMetric({ service: 'custom', operation: 'overflow' });
    this.services.set(OVERFLOW_KEY, metric);
    return metric;
  }
  // Moves an in-flight observation to another series once its real identity is known.
  private reassign(from: MutableServiceMetric, input: ObservationStart): MutableServiceMetric {
    const target = this.resolveMetric(input);
    if (target === from) return from;
    from.requestCount = Math.max(0, from.requestCount - 1);
    from.inflight = Math.max(0, from.inflight - 1);
    target.requestCount += 1;
    target.inflight += 1;
    target.maxInflight = Math.max(target.maxInflight, target.inflight);
    return target;
  }
  private finish(metric: MutableServiceMetric, startedAt: number, result: ObservationFinish): void {
    metric.inflight = Math.max(0, metric.inflight - 1);
    metric.latencyHistogram.observe(this.now() - startedAt);
    metric.bytesIn += positive(result.bytesIn);
    metric.bytesOut += positive(result.bytesOut);
    metric.inputTokens += positive(result.inputTokens);
    metric.outputTokens += positive(result.outputTokens);
    if (result.status === 'succeeded') metric.successCount += 1;
    if (result.status === 'failed') metric.failureCount += 1;
    if (result.status === 'cancelled') metric.cancelledCount += 1;
    if (result.status === 'rejected') metric.rejectedCount += 1;
  }
}
const OVERFLOW_KEY = seriesKey({ service: 'custom', operation: 'overflow' });
const NOOP_HANDLE: ObservationHandle = { markFirstByte() {}, addInputTokens() {}, addOutputTokens() {}, finish() {} };
function positive(value?: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : 0;
}
