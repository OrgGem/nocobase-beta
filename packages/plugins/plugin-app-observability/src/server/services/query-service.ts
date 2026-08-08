import type { NodeObservabilitySnapshot, ServiceSnapshot } from '../contracts';
import type { AppObservabilityContract } from '../contracts';
import type { CapacityAssessment } from '../capacity/types';
import { FIRST_BYTE_BOUNDARIES_MS, histogramQuantile, LATENCY_BOUNDARIES_MS } from '../metrics/histogram';
import type { RedisSnapshotAdapter } from '../adapters/redis-snapshot-adapter';

interface HistoryRepository {
  find(
    options: Record<string, unknown>,
  ): Promise<Array<{ toJSON?(): Record<string, unknown> } & Record<string, unknown>>>;
}
export interface ClusterCapacityAssessment extends CapacityAssessment {
  assessedNodeId: string;
  nodeCount: number;
}
export class QueryService {
  constructor(
    private readonly contract: AppObservabilityContract,
    private readonly historyRepository: HistoryRepository,
    private readonly redisAdapter: () => RedisSnapshotAdapter | null,
    private readonly activeUserWindowSeconds: () => number = () => 300,
    private readonly assessCapacity?: (snapshot: NodeObservabilitySnapshot) => CapacityAssessment,
    private readonly clusterActiveUsers: () => Promise<number | null> = async () => null,
  ) {}
  async nodes(): Promise<NodeObservabilitySnapshot[]> {
    const local = this.contract.getNodeSnapshot();
    const remote =
      (await this.redisAdapter()
        ?.list()
        .catch(() => [])) ?? [];
    // The local node publishes itself to Redis, so its remote copy is up to one
    // publish interval stale. Insert it last so it overwrites that stale entry.
    return [...new Map([...remote, local].map((node) => [node.nodeId, node])).values()];
  }
  async overview(): Promise<Record<string, unknown>> {
    const nodes = await this.nodes();
    const services = nodes.flatMap((node) => Object.values(node.services));
    const clusterActiveUsers = await this.clusterActiveUsers().catch(() => null);
    const aggregationMode = this.redisAdapter() ? 'redis' : 'single-node';
    return {
      activeUsers: clusterActiveUsers ?? this.contract.getNodeSnapshot().activeUsers,
      activeUserScope:
        clusterActiveUsers !== null ? 'cluster-estimate' : aggregationMode === 'redis' ? 'node-local' : 'single-node',
      sessionWindowSeconds: this.activeUserWindowSeconds(),
      http: summarizeServices(services.filter((service) => service.service === 'http')),
      llm: groupServices(services.filter((service) => service.service.startsWith('llm.'))),
      aggregationMode,
      nodes: nodes.length,
    };
  }
  async services(): Promise<Record<string, unknown>[]> {
    return groupServices((await this.nodes()).flatMap((node) => Object.values(node.services)));
  }
  async capacity(): Promise<ClusterCapacityAssessment> {
    const nodes = await this.nodes();
    const assessments = nodes.map((node) => ({
      nodeId: node.nodeId,
      assessment: this.assessCapacity?.(node) ?? this.contract.getCapacityAssessment(),
    }));
    const selected = assessments.reduce((current, candidate) =>
      compareCapacity(candidate.assessment, current.assessment) > 0 ? candidate : current,
    );
    return { ...selected.assessment, assessedNodeId: selected.nodeId, nodeCount: nodes.length };
  }
  async history(params: {
    from?: string;
    to?: string;
    page?: number;
    pageSize?: number;
  }): Promise<Record<string, unknown>[]> {
    const now = Date.now();
    const to = clampDate(params.to, now, now);
    const from = clampDate(params.from, to - 6 * 3_600_000, to);
    const boundedFrom = Math.max(from, to - 7 * 86_400_000);
    const pageSize = Math.min(500, Math.max(1, params.pageSize ?? 100));
    const page = Math.max(1, params.page ?? 1);
    const models = await this.historyRepository.find({
      filter: { bucketStart: { $between: [new Date(boundedFrom), new Date(to)] } },
      sort: ['-bucketStart'],
      page,
      pageSize,
    });
    return models.map((model) => model.toJSON?.() ?? model);
  }
}

function compareCapacity(left: CapacityAssessment, right: CapacityAssessment): number {
  const stateRank = { healthy: 0, watch: 1, 'scale-soon': 2, critical: 3 } as const;
  const stateDifference = stateRank[left.state] - stateRank[right.state];
  if (stateDifference) return stateDifference;
  const utilization = (assessment: CapacityAssessment) =>
    assessment.signals.find((signal) => signal.key === assessment.constrainingSignal)?.utilization ?? -1;
  return utilization(left) - utilization(right);
}
function groupServices(services: ServiceSnapshot[]): Record<string, unknown>[] {
  const grouped = new Map<string, ServiceSnapshot[]>();
  for (const service of services) {
    const key = `${service.service}|${service.operation}|${service.streaming}`;
    grouped.set(key, [...(grouped.get(key) ?? []), service]);
  }
  return [...grouped.values()].map(summarizeServices);
}
function summarizeServices(services: ServiceSnapshot[]): Record<string, unknown> | null {
  if (!services.length) return null;
  const first = services[0];
  const requests = sum(services, 'requestCount');
  const failures = sum(services, 'failureCount') + sum(services, 'rejectedCount');
  return {
    service: first.service,
    operation: first.operation,
    streaming: first.streaming,
    inflight: sum(services, 'inflight'),
    maxInflight: Math.max(...services.map((item) => item.maxInflight)),
    requestCount: requests,
    errorRate: requests ? failures / requests : 0,
    p95LatencyMs: percentile(services, 'latency', LATENCY_BOUNDARIES_MS),
    ttftMs: percentile(services, 'firstByte', FIRST_BYTE_BOUNDARIES_MS),
    inputTokens: sum(services, 'inputTokens'),
    outputTokens: sum(services, 'outputTokens'),
    cancelledCount: sum(services, 'cancelledCount'),
    rejectedCount: sum(services, 'rejectedCount'),
  };
}
function percentile(
  services: ServiceSnapshot[],
  key: 'latency' | 'firstByte',
  boundaries: readonly number[],
): number | null {
  const merged = { count: 0, sum: 0, max: 0, buckets: new Array(boundaries.length + 1).fill(0) };
  for (const service of services) {
    const histogram = service[key];
    merged.count += histogram.count;
    merged.sum += histogram.sum;
    merged.max = Math.max(merged.max, histogram.max);
    histogram.buckets.forEach((value, index) => {
      merged.buckets[index] = (merged.buckets[index] ?? 0) + value;
    });
  }
  return histogramQuantile(merged, boundaries, 0.95);
}
function sum(services: ServiceSnapshot[], key: keyof ServiceSnapshot): number {
  return services.reduce(
    (total, service) => total + (typeof service[key] === 'number' ? (service[key] as number) : 0),
    0,
  );
}
function clampDate(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = value ? Date.parse(value) : fallback;
  return Number.isFinite(parsed) ? Math.min(parsed, maximum) : fallback;
}
