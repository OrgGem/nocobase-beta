import { createHmac } from 'crypto';
import type { RedisSnapshotClient } from './redis-client-resolver';

export class RedisActiveUserAdapter {
  private readonly now: () => number;
  constructor(
    private readonly client: RedisSnapshotClient,
    private readonly options: { appName: string; secret: string; bucketSeconds?: number; now?: () => number },
  ) {
    this.now = options.now ?? Date.now;
  }
  get supported(): boolean {
    return Boolean(this.client.pfAdd && this.client.pfCount && this.client.expire);
  }
  async observe(identifier: string | number, windowSeconds: number): Promise<void> {
    if (!this.supported) return;
    const key = this.key(this.bucketStart());
    const hash = createHmac('sha256', this.options.secret).update(String(identifier)).digest('base64url');
    await this.client.pfAdd?.(key, [hash]);
    await this.client.expire?.(key, Math.max(windowSeconds + this.bucketSeconds(), this.bucketSeconds() * 2));
  }
  async count(windowSeconds: number): Promise<number | null> {
    if (!this.supported) return null;
    // Include the partially overlapping oldest bucket so a user observed just
    // inside the window is not excluded at a bucket boundary.
    const count = Math.ceil(windowSeconds / this.bucketSeconds()) + 1;
    const latest = this.bucketStart();
    const keys = Array.from({ length: count }, (_, index) => this.key(latest - index * this.bucketSeconds() * 1000));
    return this.client.pfCount?.(keys) ?? null;
  }
  private bucketSeconds(): number {
    return this.options.bucketSeconds ?? 60;
  }
  private bucketStart(): number {
    const interval = this.bucketSeconds() * 1000;
    return Math.floor(this.now() / interval) * interval;
  }
  private key(bucketStart: number): string {
    return `nocobase:${this.options.appName}:app-observability:active-users:${bucketStart}`;
  }
}
