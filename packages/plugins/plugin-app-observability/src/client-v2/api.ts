import type { APIClient } from '@nocobase/sdk';

export interface ApiEnvelope<T> {
  data: T;
}
export interface ServiceMetric {
  service: string;
  operation?: string;
  streaming?: boolean;
  inflight?: number;
  requestCount?: number;
  errorRate?: number;
  p95LatencyMs?: number;
  ttftMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  disconnectCount?: number;
}
export interface RuntimeMetric {
  cpuPercent?: number | null;
  rssBytes?: number | null;
  heapUsedBytes?: number | null;
  eventLoopUtilization?: number | null;
  eventLoopDelayP99Ms?: number | null;
}
export interface NodeSnapshot {
  nodeId: string;
  workerMode?: string;
  timestamp?: number;
  runtime?: RuntimeMetric;
  services?: Record<string, ServiceMetric>;
}
export interface OverviewData {
  activeUsers?: number;
  activeUserScope?: 'cluster-estimate' | 'node-local' | 'single-node';
  sessionWindowSeconds?: number;
  http?: ServiceMetric;
  llm?: ServiceMetric[];
  aggregationMode?: 'redis' | 'single-node';
  nodes?: number;
}
export interface CapacityMessage {
  key: string;
  values?: Record<string, number | string>;
}
export interface CapacitySignal {
  key: string;
  utilization?: number | null;
  headroom?: number | null;
  reliable?: boolean;
  evidence?: CapacityMessage;
}
export interface CapacityData {
  state?: 'healthy' | 'watch' | 'scale-soon' | 'critical';
  confidence?: number;
  recommendation?: CapacityMessage;
  evidence?: CapacityMessage[];
  signals?: CapacitySignal[];
  assessedNodeId?: string;
  nodeCount?: number;
}
export interface SettingsData {
  enabled: boolean;
  sampleIntervalSeconds: number;
  bucketSeconds: number;
  retentionDays: number;
  activeUserWindowSeconds: number;
  redisSnapshotsEnabled: boolean;
  prometheusEnabled: boolean;
  capacityThresholdCpu: number;
  capacityThresholdMemory: number;
  capacityThresholdEventLoop: number;
  capacityThresholdDbWait: number;
}

const unwrap = <T>(response: { data?: ApiEnvelope<T> | T }): T => {
  const body = response.data;
  if (body && typeof body === 'object' && 'data' in body) return (body as ApiEnvelope<T>).data;
  return body as T;
};

export const observabilityApi = {
  overview: async (api: APIClient) => unwrap<OverviewData>(await api.resource('appObservability').overview()),
  nodes: async (api: APIClient) => unwrap<NodeSnapshot[]>(await api.resource('appObservability').nodes()),
  services: async (api: APIClient) => unwrap<ServiceMetric[]>(await api.resource('appObservability').services()),
  capacity: async (api: APIClient) => unwrap<CapacityData>(await api.resource('appObservability').capacity()),
  settings: async (api: APIClient) => unwrap<SettingsData>(await api.resource('appObservability').settings()),
  updateSettings: async (api: APIClient, values: SettingsData) =>
    unwrap<SettingsData>(await api.resource('appObservability').updateSettings({ values })),
};
