import type { NodeObservabilitySnapshot, ServiceSnapshot } from '../contracts';
import type { RuntimeSnapshot } from '../runtime/runtime-types';

export interface ObservabilityBucket {
  bucketStart: number;
  bucketSeconds: number;
  appName: string;
  nodeId: string;
  workerMode: string;
  service: string;
  operation: string;
  streaming: boolean;
  requestCount: number;
  successCount: number;
  failureCount: number;
  cancelledCount: number;
  rejectedCount: number;
  maxInflight: number;
  uniqueUserEstimate: number;
  latencyCount: number;
  latencySumMs: number;
  latencyMaxMs: number;
  latencyHistogram: number[];
  firstByteHistogram: number[];
  bytesIn: number;
  bytesOut: number;
  inputTokens: number;
  outputTokens: number;
  runtimeSnapshot: RuntimeSnapshot | null;
}
export interface BucketAggregatorOptions {
  appName: string;
  nodeId: string;
  workerMode: string;
  bucketSeconds: number;
}
export class BucketAggregator {
  private buckets = new Map<string, ObservabilityBucket>();
  private readonly previous = new Map<string, ServiceSnapshot>();
  constructor(private readonly options: BucketAggregatorOptions) {}
  seed(snapshot: Pick<NodeObservabilitySnapshot, 'services'>): void {
    for (const service of Object.values(snapshot.services)) {
      const series = `${service.service}|${service.operation}|${service.streaming ? 1 : 0}|${JSON.stringify(
        service.attributes,
      )}`;
      this.previous.set(series, service);
    }
  }
  record(
    snapshot: Pick<NodeObservabilitySnapshot, 'timestamp' | 'activeUsers' | 'services'> & {
      runtime?: RuntimeSnapshot | null;
    },
  ): void {
    const bucketStart =
      Math.floor(snapshot.timestamp / (this.options.bucketSeconds * 1000)) * this.options.bucketSeconds * 1000;
    for (const service of Object.values(snapshot.services)) {
      const series = `${service.service}|${service.operation}|${service.streaming ? 1 : 0}|${JSON.stringify(
        service.attributes,
      )}`;
      const delta = subtractService(service, this.previous.get(series));
      this.previous.set(series, service);
      if (delta.requestCount === 0 && delta.inflight === 0) continue;
      const key = `${bucketStart}|${series}`;
      const current = this.buckets.get(key);
      this.buckets.set(
        key,
        current
          ? mergeBucket(current, delta, snapshot.activeUsers, snapshot.runtime ?? null)
          : createBucket(this.options, bucketStart, delta, snapshot.activeUsers, snapshot.runtime ?? null),
      );
    }
  }
  snapshotAndReset(): ObservabilityBucket[] {
    const result = [...this.buckets.values()];
    this.buckets.clear();
    return result;
  }
  restore(buckets: ObservabilityBucket[]): void {
    for (const bucket of buckets) {
      const key = `${bucket.bucketStart}|${bucket.service}|${bucket.operation}|${bucket.streaming ? 1 : 0}`;
      if (!this.buckets.has(key)) this.buckets.set(key, bucket);
    }
  }
}
function createBucket(
  options: BucketAggregatorOptions,
  bucketStart: number,
  metric: ServiceSnapshot,
  users: number,
  runtime: RuntimeSnapshot | null,
): ObservabilityBucket {
  return {
    bucketStart,
    bucketSeconds: options.bucketSeconds,
    appName: options.appName,
    nodeId: options.nodeId,
    workerMode: options.workerMode,
    service: metric.service,
    operation: metric.operation,
    streaming: metric.streaming,
    requestCount: metric.requestCount,
    successCount: metric.successCount,
    failureCount: metric.failureCount,
    cancelledCount: metric.cancelledCount,
    rejectedCount: metric.rejectedCount,
    maxInflight: metric.maxInflight,
    uniqueUserEstimate: users,
    latencyCount: metric.latency.count,
    latencySumMs: metric.latency.sum,
    latencyMaxMs: metric.latency.max,
    latencyHistogram: [...metric.latency.buckets],
    firstByteHistogram: [...metric.firstByte.buckets],
    bytesIn: metric.bytesIn,
    bytesOut: metric.bytesOut,
    inputTokens: metric.inputTokens,
    outputTokens: metric.outputTokens,
    runtimeSnapshot: runtime,
  };
}
function mergeBucket(
  bucket: ObservabilityBucket,
  metric: ServiceSnapshot,
  users: number,
  runtime: RuntimeSnapshot | null,
): ObservabilityBucket {
  return {
    ...bucket,
    requestCount: bucket.requestCount + metric.requestCount,
    successCount: bucket.successCount + metric.successCount,
    failureCount: bucket.failureCount + metric.failureCount,
    cancelledCount: bucket.cancelledCount + metric.cancelledCount,
    rejectedCount: bucket.rejectedCount + metric.rejectedCount,
    maxInflight: Math.max(bucket.maxInflight, metric.maxInflight),
    uniqueUserEstimate: Math.max(bucket.uniqueUserEstimate, users),
    latencyCount: bucket.latencyCount + metric.latency.count,
    latencySumMs: bucket.latencySumMs + metric.latency.sum,
    latencyMaxMs: Math.max(bucket.latencyMaxMs, metric.latency.max),
    latencyHistogram: addArrays(bucket.latencyHistogram, metric.latency.buckets),
    firstByteHistogram: addArrays(bucket.firstByteHistogram, metric.firstByte.buckets),
    bytesIn: bucket.bytesIn + metric.bytesIn,
    bytesOut: bucket.bytesOut + metric.bytesOut,
    inputTokens: bucket.inputTokens + metric.inputTokens,
    outputTokens: bucket.outputTokens + metric.outputTokens,
    runtimeSnapshot: runtime ?? bucket.runtimeSnapshot,
  };
}
function addArrays(left: number[], right: number[]): number[] {
  return Array.from(
    { length: Math.max(left.length, right.length) },
    (_, index) => (left[index] ?? 0) + (right[index] ?? 0),
  );
}
function subtractService(current: ServiceSnapshot, previous?: ServiceSnapshot): ServiceSnapshot {
  if (!previous) return current;
  const subtractHistogram = (key: 'latency' | 'firstByte') => ({
    count: Math.max(0, current[key].count - previous[key].count),
    sum: Math.max(0, current[key].sum - previous[key].sum),
    max: current[key].max,
    buckets: current[key].buckets.map((value, index) => Math.max(0, value - (previous[key].buckets[index] ?? 0))),
  });
  return {
    ...current,
    requestCount: Math.max(0, current.requestCount - previous.requestCount),
    successCount: Math.max(0, current.successCount - previous.successCount),
    failureCount: Math.max(0, current.failureCount - previous.failureCount),
    cancelledCount: Math.max(0, current.cancelledCount - previous.cancelledCount),
    rejectedCount: Math.max(0, current.rejectedCount - previous.rejectedCount),
    bytesIn: Math.max(0, current.bytesIn - previous.bytesIn),
    bytesOut: Math.max(0, current.bytesOut - previous.bytesOut),
    inputTokens: Math.max(0, current.inputTokens - previous.inputTokens),
    outputTokens: Math.max(0, current.outputTokens - previous.outputTokens),
    latency: subtractHistogram('latency'),
    firstByte: subtractHistogram('firstByte'),
  };
}
