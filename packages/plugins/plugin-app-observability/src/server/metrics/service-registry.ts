import type { ObservationAttribute, ObservationStart, ServiceSnapshot } from '../contracts';
import { BoundedHistogram, FIRST_BYTE_BOUNDARIES_MS, LATENCY_BOUNDARIES_MS } from './histogram';

const ATTRIBUTE_ALLOWLIST = new Set(['llmService', 'provider', 'model', 'mode', 'endpoint']);
export interface MutableServiceMetric extends Omit<ServiceSnapshot, 'latency' | 'firstByte'> {
  latencyHistogram: BoundedHistogram;
  firstByteHistogram: BoundedHistogram;
}
export function sanitizeDimension(value: string, fallback: string): string {
  return value.trim().slice(0, 160) || fallback;
}
export function sanitizeAttributes(
  attributes?: Record<string, ObservationAttribute>,
): Record<string, ObservationAttribute> {
  const result: Record<string, ObservationAttribute> = {};
  for (const [key, value] of Object.entries(attributes ?? {}))
    if (ATTRIBUTE_ALLOWLIST.has(key)) result[key] = typeof value === 'string' ? value.slice(0, 120) : value;
  return result;
}
export function seriesKey(input: ObservationStart): string {
  return [
    sanitizeDimension(input.service, 'custom'),
    sanitizeDimension(input.operation, 'unknown'),
    input.streaming ? '1' : '0',
    JSON.stringify(sanitizeAttributes(input.attributes)),
  ].join('|');
}
export function createServiceMetric(input: ObservationStart): MutableServiceMetric {
  return {
    service: sanitizeDimension(input.service, 'custom'),
    operation: sanitizeDimension(input.operation, 'unknown'),
    streaming: Boolean(input.streaming),
    attributes: sanitizeAttributes(input.attributes),
    inflight: 0,
    maxInflight: 0,
    requestCount: 0,
    successCount: 0,
    failureCount: 0,
    cancelledCount: 0,
    rejectedCount: 0,
    bytesIn: 0,
    bytesOut: 0,
    inputTokens: 0,
    outputTokens: 0,
    latencyHistogram: new BoundedHistogram(LATENCY_BOUNDARIES_MS),
    firstByteHistogram: new BoundedHistogram(FIRST_BYTE_BOUNDARIES_MS),
  };
}
export function snapshotService(metric: MutableServiceMetric): ServiceSnapshot {
  const { latencyHistogram, firstByteHistogram, ...snapshot } = metric;
  return {
    ...snapshot,
    attributes: { ...snapshot.attributes },
    latency: latencyHistogram.snapshot(),
    firstByte: firstByteHistogram.snapshot(),
  };
}
