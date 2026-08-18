import { randomUUID } from 'crypto';
import os from 'os';
import { createClient } from 'redis';

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_RENEW_INTERVAL_MS = 20_000;
const WORKER_ID_COUNT = 32;

const RENEW_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end';
const RELEASE_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

// Structural logger so both SystemLogger (app.logger) and plain Logger instances
// from @nocobase/logger are accepted.
export interface WorkerIdAllocatorLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export type RedisWorkerIdAllocatorStatus = {
  workerId: number | null;
  healthy: boolean;
  lastRenewedAt: number | null;
  lastError: string | null;
  owner: string;
};

export class RedisWorkerIdAllocator {
  private readonly redis: ReturnType<typeof createClient>;
  private readonly owner = `${os.hostname()}:${process.pid}:${randomUUID()}`;
  private readonly keyPrefix: string;
  private renewTimer: NodeJS.Timeout | null = null;
  private workerId: number | null = null;
  private healthy = false;
  private lastRenewedAt: number | null = null;
  private lastError: string | null = null;

  constructor(
    redisUrl: string,
    appName: string,
    private readonly logger: WorkerIdAllocatorLogger,
    private readonly leaseMs = DEFAULT_LEASE_MS,
    private readonly renewIntervalMs = DEFAULT_RENEW_INTERVAL_MS,
  ) {
    this.redis = createClient({ url: redisUrl });
    this.redis.on('error', (error) => {
      this.lastError = error.message;
      this.logger.error(`[ClusterManager] Worker ID Redis error: ${error.message}`);
    });
    this.keyPrefix = `nocobase:${appName}:cluster-manager:worker-id:`;
  }

  async getWorkerId(): Promise<number> {
    if (!this.redis.isOpen) await this.redis.connect();

    if (this.workerId !== null && this.healthy) {
      return this.workerId;
    }

    for (let candidate = 0; candidate < WORKER_ID_COUNT; candidate += 1) {
      const result = await this.redis.sendCommand([
        'SET',
        this.getKey(candidate),
        this.owner,
        'NX',
        'PX',
        String(this.leaseMs),
      ]);
      if (String(result) === 'OK') {
        this.workerId = candidate;
        this.healthy = true;
        this.lastRenewedAt = Date.now();
        this.lastError = null;
        this.startRenewal();
        this.logger.info(`[ClusterManager] Acquired Redis worker ID ${candidate}`);
        return candidate;
      }
    }

    this.healthy = false;
    this.lastError = 'All 32 NocoBase worker IDs are currently leased';
    throw new Error(this.lastError);
  }

  async release(): Promise<void> {
    this.stopRenewal();
    const workerId = this.workerId;
    this.workerId = null;
    this.healthy = false;
    if (workerId === null) {
      if (this.redis.isOpen) await this.redis.quit().catch(() => this.redis.destroy());
      return;
    }

    try {
      await this.redis.sendCommand(['EVAL', RELEASE_SCRIPT, '1', this.getKey(workerId), this.owner]);
    } catch (error: unknown) {
      this.logger.warn(`[ClusterManager] Failed to release worker ID ${workerId}: ${this.getErrorMessage(error)}`);
    } finally {
      if (this.redis.isOpen) await this.redis.quit().catch(() => this.redis.destroy());
    }
  }

  getStatus(): RedisWorkerIdAllocatorStatus {
    return {
      workerId: this.workerId,
      healthy: this.healthy,
      lastRenewedAt: this.lastRenewedAt,
      lastError: this.lastError,
      owner: this.owner,
    };
  }

  private getKey(workerId: number): string {
    return `${this.keyPrefix}${workerId}`;
  }

  private startRenewal(): void {
    this.stopRenewal();
    this.renewTimer = setInterval(() => {
      this.renew().catch((error: unknown) => {
        this.healthy = false;
        this.lastError = this.getErrorMessage(error);
        this.logger.error(`[ClusterManager] Worker ID lease renewal failed: ${this.lastError}`);
      });
    }, this.renewIntervalMs);
    this.renewTimer.unref?.();
  }

  private stopRenewal(): void {
    if (this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = null;
    }
  }

  private async renew(): Promise<void> {
    if (this.workerId === null) return;
    const result = await this.redis.sendCommand([
      'EVAL',
      RENEW_SCRIPT,
      '1',
      this.getKey(this.workerId),
      this.owner,
      String(this.leaseMs),
    ]);
    if (Number(result) !== 1) {
      this.healthy = false;
      this.stopRenewal();
      throw new Error(`Worker ID ${this.workerId} lease is no longer owned by this process`);
    }
    this.healthy = true;
    this.lastRenewedAt = Date.now();
    this.lastError = null;
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
