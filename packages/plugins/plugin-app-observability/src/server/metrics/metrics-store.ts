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
    const key = this.resolveSeriesKey(input);
    const metric = this.services.get(key) ?? createServiceMetric(input);
    if (!this.services.has(key)) this.services.set(key, metric);
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
        if (!finished) {
          finished = true;
          this.finish(metric, startedAt, result);
        }
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
      appName: this.options.appName,
      nodeId: this.options.nodeId,
      timestamp: this.now(),
      workerMode: this.options.workerMode ?? process.env.WORKER_MODE ?? 'web',
      activeUsers: this.activeUsers.count(),
      runtime: this.runtime ? { ...this.runtime } : null,
      services: Object.fromEntries([...this.services].map(([key, metric]) => [key, snapshotService(metric)])),
    };
  }
  private resolveSeriesKey(input: ObservationStart): string {
    const key = seriesKey(input);
    if (this.services.has(key)) return key;

    const maxSeries = Math.max(1, this.options.maxSeries ?? 500);
    const overflowKey = 'custom|overflow|0|{}';
    if (this.services.has(overflowKey)) return overflowKey;

    // Reserve the final bounded slot for overflow so cardinality never exceeds maxSeries.
    return this.services.size < maxSeries - 1 ? key : overflowKey;
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
const NOOP_HANDLE: ObservationHandle = { markFirstByte() {}, addInputTokens() {}, addOutputTokens() {}, finish() {} };
function positive(value?: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : 0;
}
