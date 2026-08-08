import type { NodeObservabilitySnapshot } from '../contracts';
import type { RedisSnapshotClient } from './redis-client-resolver';
export class RedisSnapshotAdapter {
  private readonly now: () => number;
  constructor(
    private readonly client: RedisSnapshotClient,
    private readonly options: { appName: string; ttlSeconds?: number; now?: () => number },
  ) {
    this.now = options.now ?? Date.now;
  }
  async publish(snapshot: NodeObservabilitySnapshot): Promise<void> {
    await this.client.set(this.key(snapshot.nodeId), JSON.stringify(snapshot), { EX: this.options.ttlSeconds ?? 30 });
  }
  async list(): Promise<NodeObservabilitySnapshot[]> {
    const result: NodeObservabilitySnapshot[] = [];
    const maxAge = (this.options.ttlSeconds ?? 30) * 1000;
    for await (const key of this.client.scanIterator({ MATCH: this.key('*'), COUNT: 100 })) {
      try {
        const value = await this.client.get(key);
        if (!value) continue;
        const snapshot = JSON.parse(value) as unknown;
        if (!isNodeSnapshot(snapshot) || this.now() - snapshot.timestamp > maxAge) continue;
        result.push(snapshot);
      } catch {
        continue;
      }
    }
    return result;
  }
  private key(nodeId: string): string {
    return `nocobase:${this.options.appName}:app-observability:nodes:${nodeId}`;
  }
}

function isNodeSnapshot(value: unknown): value is NodeObservabilitySnapshot {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1) return false;
  if (
    typeof value.appName !== 'string' ||
    !value.appName ||
    typeof value.nodeId !== 'string' ||
    !value.nodeId ||
    typeof value.workerMode !== 'string' ||
    !Number.isFinite(value.timestamp) ||
    !Number.isFinite(value.activeUsers) ||
    !isRecord(value.services)
  )
    return false;
  return Object.values(value.services).every(isServiceSnapshot);
}

function isServiceSnapshot(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.service === 'string' &&
    typeof value.operation === 'string' &&
    typeof value.streaming === 'boolean' &&
    isRecord(value.attributes) &&
    [
      'inflight',
      'maxInflight',
      'requestCount',
      'successCount',
      'failureCount',
      'cancelledCount',
      'rejectedCount',
    ].every((key) => Number.isFinite(value[key])) &&
    isHistogram(value.latency) &&
    isHistogram(value.firstByte)
  );
}

function isHistogram(value: unknown): boolean {
  return (
    isRecord(value) &&
    Number.isFinite(value.count) &&
    Number.isFinite(value.sum) &&
    Number.isFinite(value.max) &&
    Array.isArray(value.buckets) &&
    value.buckets.every(Number.isFinite)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
