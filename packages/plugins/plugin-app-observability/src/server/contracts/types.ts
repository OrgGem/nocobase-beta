import type { CapacityAssessment } from '../capacity/types';
import type { RuntimeSnapshot } from '../runtime/runtime-types';

export type ObservabilityServiceKind =
  | 'http'
  | 'llm.chat'
  | 'llm.agent'
  | 'llm.completion'
  | 'llm.embedding'
  | 'workflow'
  | 'worker'
  | 'custom';
export type ObservationStatus = 'succeeded' | 'failed' | 'cancelled' | 'rejected';
export type ObservationAttribute = string | number | boolean | null;
export interface ObservationStart {
  service: ObservabilityServiceKind | string;
  operation: string;
  nodeId?: string;
  streaming?: boolean;
  attributes?: Record<string, ObservationAttribute>;
}
export interface ObservationFinish {
  status: ObservationStatus;
  errorCode?: string;
  inputTokens?: number;
  outputTokens?: number;
  bytesIn?: number;
  bytesOut?: number;
  /** Late-resolved operation name, for callers that only learn it downstream. */
  operation?: string;
}
export interface ObservationHandle {
  markFirstByte(): void;
  addInputTokens(value: number): void;
  addOutputTokens(value: number): void;
  finish(result: ObservationFinish): void;
}
export interface HistogramSnapshot {
  count: number;
  sum: number;
  max: number;
  buckets: number[];
}
export interface ServiceSnapshot {
  service: string;
  operation: string;
  streaming: boolean;
  attributes: Record<string, ObservationAttribute>;
  inflight: number;
  maxInflight: number;
  requestCount: number;
  successCount: number;
  failureCount: number;
  cancelledCount: number;
  rejectedCount: number;
  bytesIn: number;
  bytesOut: number;
  inputTokens: number;
  outputTokens: number;
  latency: HistogramSnapshot;
  firstByte: HistogramSnapshot;
}
export interface NodeObservabilitySnapshot {
  schemaVersion: 1;
  appName: string;
  nodeId: string;
  timestamp: number;
  workerMode: string;
  activeUsers: number;
  runtime: RuntimeSnapshot | null;
  services: Record<string, ServiceSnapshot>;
}
export interface ServiceDefinition {
  service: string;
  title?: string;
  operations?: string[];
}
export interface AppObservabilityContract {
  start(input: ObservationStart): ObservationHandle;
  observe<T>(input: ObservationStart, run: (handle: ObservationHandle) => Promise<T>): Promise<T>;
  getNodeSnapshot(): NodeObservabilitySnapshot;
  getCapacityAssessment(): CapacityAssessment;
  registerService(definition: ServiceDefinition): () => void;
}
