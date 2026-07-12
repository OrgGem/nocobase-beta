/**
 * MSSQL Connection Pool — manages multiple tedious connections for concurrent queries.
 *
 * Each query acquires a connection, executes, and releases it back.
 * MARS (Multiple Active Result Sets) is enabled on all connections so a single
 * connection can handle concurrent requests safely.
 */

import type { Logger } from '@nocobase/logger';
import type { MssqlConnectionOptions, DatabaseHandle } from '../types';
import tedious from 'tedious';

const DEFAULT_POOL_SIZE = 5;
const DEFAULT_IDLE_TIMEOUT_MS = 300_000; // 5 minutes

/** Connect function signature — typically driver.connect() */
type ConnectFn = (
  conn: MssqlConnectionOptions,
  logger?: Logger,
) => Promise<DatabaseHandle<tedious.Connection>>;

interface PooledHandle {
  dbhan: DatabaseHandle<tedious.Connection>;
  lastUsed: number;
}

export class ConnectionPool {
  private pool: PooledHandle[] = [];
  private available: PooledHandle[] = [];
  private waiting: Array<{
    resolve: (dbhan: DatabaseHandle<tedious.Connection>) => void;
    reject: (err: Error) => void;
  }> = [];
  private maxSize: number;
  private idleTimeoutMs: number;
  private connectionOptions: MssqlConnectionOptions;
  private connectFn: ConnectFn;
  private logger?: Logger;
  private closed = false;
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(
    options: MssqlConnectionOptions,
    connectFn: ConnectFn,
    maxSize = DEFAULT_POOL_SIZE,
    logger?: Logger,
  ) {
    this.connectionOptions = options;
    this.connectFn = connectFn;
    this.maxSize = maxSize;
    this.logger = logger;
    this.idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;

    // Periodic cleanup of idle connections (keep at least 1)
    this.cleanupTimer = setInterval(() => {
      this.cleanupIdle();
    }, 60_000).unref();
  }

  /**
   * Acquire a connection from the pool.
   * Returns an existing idle connection or creates a new one.
   * Waits if pool is exhausted.
   */
  async acquire(): Promise<DatabaseHandle<tedious.Connection>> {
    if (this.closed) {
      throw new Error('[MSSQL-V2] Connection pool is closed');
    }

    // Try an existing idle connection first
    while (this.available.length > 0) {
      const entry = this.available.pop()!;
      if (this.isHealthy(entry)) {
        entry.lastUsed = Date.now();
        return entry.dbhan;
      }
      // Dead connection — remove from pool
      this.removeFromPool(entry);
    }

    // Create new connection if pool not full
    if (this.pool.length < this.maxSize) {
      this.logger?.debug?.(`[MSSQL-V2] Creating new connection (${this.pool.length + 1}/${this.maxSize})`);
      const dbhan = await this.connectFn(this.connectionOptions, this.logger);
      const entry: PooledHandle = { dbhan, lastUsed: Date.now() };
      this.pool.push(entry);
      return dbhan;
    }

    // Pool exhausted — wait for a connection to be released
    this.logger?.warn?.('[MSSQL-V2] Pool exhausted, waiting for connection...');
    return new Promise<DatabaseHandle<tedious.Connection>>((resolve, reject) => {
      this.waiting.push({ resolve, reject });
    });
  }

  /**
   * Release a connection back to the pool.
   */
  release(dbhan: DatabaseHandle<tedious.Connection>): void {
    if (this.closed) {
      this.safeClose(dbhan);
      return;
    }

    const waiter = this.waiting.shift();
    if (waiter) {
      waiter.resolve(dbhan);
      return;
    }

    // No waiters — keep as available
    const entry = this.pool.find((e) => e.dbhan === dbhan);
    if (entry) {
      entry.lastUsed = Date.now();
      this.available.push(entry);
    }
  }

  /**
   * Mark a connection as broken and remove from pool.
   */
  markBroken(dbhan: DatabaseHandle<tedious.Connection>): void {
    this.removeFromPoolByHandle(dbhan);
    this.safeClose(dbhan);
  }

  /**
   * Close all connections in the pool.
   */
  async closeAll(): Promise<void> {
    this.closed = true;
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);

    // Reject all waiting requests
    for (const waiter of this.waiting) {
      waiter.reject(new Error('[MSSQL-V2] Connection pool is shutting down'));
    }
    this.waiting = [];

    // Close all connections
    const all = [...this.pool];
    this.pool = [];
    this.available = [];

    await Promise.allSettled(all.map((entry) => this.safeClose(entry.dbhan)));
  }

  /** Current pool size */
  get size(): number {
    return this.pool.length;
  }

  /** Available (idle) connections */
  get availableCount(): number {
    return this.available.length;
  }

  // ---- Private helpers ----

  private isHealthy(entry: PooledHandle): boolean {
    try {
      const conn = entry.dbhan.client;
      // Check if connection is in a usable state
      return conn.state?.name === 'LoggedIn';
    } catch {
      return false;
    }
  }

  private async safeClose(dbhan: DatabaseHandle<tedious.Connection>): Promise<void> {
    try {
      await dbhan.client.close();
    } catch {
      // Ignore close errors
    }
  }

  private removeFromPool(entry: PooledHandle): void {
    const idx = this.pool.indexOf(entry);
    if (idx >= 0) this.pool.splice(idx, 1);
    this.safeClose(entry.dbhan);
  }

  private removeFromPoolByHandle(dbhan: DatabaseHandle<tedious.Connection>): void {
    const idx = this.pool.findIndex((e) => e.dbhan === dbhan);
    if (idx >= 0) this.pool.splice(idx, 1);
    const availIdx = this.available.findIndex((e) => e.dbhan === dbhan);
    if (availIdx >= 0) this.available.splice(availIdx, 1);
  }

  private cleanupIdle(): void {
    if (this.available.length <= 1) return;

    const now = Date.now();
    // Close idle connections past timeout, keeping at least 1
    while (this.available.length > 1) {
      const entry = this.available[0];
      if (now - entry.lastUsed > this.idleTimeoutMs) {
        this.available.shift();
        this.removeFromPool(entry);
        this.logger?.debug?.('[MSSQL-V2] Closed idle connection');
      } else {
        break;
      }
    }
  }
}
