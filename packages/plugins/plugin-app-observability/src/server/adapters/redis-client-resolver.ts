export interface RedisSnapshotClient {
  set(key: string, value: string, options: { EX: number }): Promise<unknown>;
  get(key: string): Promise<string | null>;
  scanIterator(options: { MATCH: string; COUNT: number }): AsyncIterable<string>;
  pfAdd?(key: string, elements: string[]): Promise<number>;
  pfCount?(keys: string[]): Promise<number>;
  expire?(key: string, seconds: number): Promise<number>;
}
interface RedisConnectionManagerLike {
  getConnection(key?: string): RedisSnapshotClient | null;
}
export function resolveRedisSnapshotClient(app: object): RedisSnapshotClient | null {
  const manager = (app as { redisConnectionManager?: RedisConnectionManagerLike }).redisConnectionManager;
  return manager?.getConnection('app-observability') ?? manager?.getConnection() ?? null;
}
