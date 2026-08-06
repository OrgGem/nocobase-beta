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
        const snapshot = JSON.parse(value) as NodeObservabilitySnapshot;
        if (!snapshot.nodeId || !Number.isFinite(snapshot.timestamp) || this.now() - snapshot.timestamp > maxAge)
          continue;
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
