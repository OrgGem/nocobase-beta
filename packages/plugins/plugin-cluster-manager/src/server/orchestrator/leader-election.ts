/**
 * Leader Election using native Redis commands
 *
 * Ensures only ONE app instance runs orchestrator write operations (scale, start, stop).
 * Other instances remain read-only followers.
 *
 * Flow:
 *   1. After app starts, tryBecomeLeader() attempts to acquire the Redis lock using SET NX PX.
 *   2. If acquired → this node is leader; a renewal timer extends the lock periodically using a Lua script.
 *   3. If not acquired → this node is follower; it retries periodically.
 *   4. On app stop → release the lock gracefully using a Lua script.
 *   5. On crash → lock auto-expires after TTL.
 */

import os from 'os';

const LEADER_TTL = 30000; // 30s lock TTL
const RENEW_INTERVAL = 10000; // Renew every 10s (well within 30s TTL)
const RETRY_INTERVAL = 15000; // Follower retries every 15s

export class LeaderElection {
  private renewTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private _isLeader = false;
  private _leaderId: string;
  private standaloneMode: boolean;
  private enabled: boolean;
  private _disabledReason = '';
  private redis: any;
  private readonly leaderKey: string;

  constructor(
    private app: any,
    options?: { standaloneMode?: boolean; enabled?: boolean; disabledReason?: string },
  ) {
    this._leaderId = `${os.hostname()}:${process.pid}`;
    this.standaloneMode = options?.standaloneMode ?? process.env.ORCHESTRATOR_STANDALONE_MODE === 'true';
    this.enabled = options?.enabled ?? true;
    this._disabledReason = options?.disabledReason || '';
    const appName = process.env.APP_NAME || app?.name || 'main';
    this.leaderKey = `nocobase:${appName}:cluster-manager:orchestrator:leader`;
  }

  get isLeader(): boolean {
    return this._isLeader;
  }

  get leaderId(): string {
    return this._leaderId;
  }

  get disabledReason(): string {
    return this._disabledReason;
  }

  /**
   * Initialize Redis client. Must be called after Redis is connected.
   */
  async init(): Promise<boolean> {
    if (!this.enabled) {
      this._isLeader = false;
      this._disabledReason ||= 'Orchestrator leader election is disabled on this node.';
      return false;
    }

    const redis = this.app.redisConnectionManager?.getConnection();
    if (!redis) {
      if (this.standaloneMode) {
        this.app.logger.warn(
          '[LeaderElection] Redis not available — running in explicit standalone mode (always leader)',
        );
        this._isLeader = true;
        this._disabledReason = '';
        return true;
      }
      this._isLeader = false;
      this._disabledReason =
        'Redis is unavailable; orchestrator write operations are disabled until leader election can run.';
      this.app.logger.warn(`[LeaderElection] ${this._disabledReason}`);
      return false;
    }

    this.redis = redis;
    return true;
  }

  /**
   * Attempt to become the orchestrator leader.
   * If successful, starts a renewal loop.
   * If not, starts a retry loop.
   */
  async tryBecomeLeader(): Promise<boolean> {
    if (!this.enabled) {
      this._isLeader = false;
      return false;
    }

    if (!this.redis) {
      if (this.standaloneMode) {
        this._isLeader = true;
        this._disabledReason = '';
        return true;
      }
      this._isLeader = false;
      if (!this._disabledReason) {
        this._disabledReason = 'Leader election is unavailable; orchestrator write operations are disabled.';
      }
      return false;
    }

    try {
      // Use native sendCommand to avoid node-redis v3/v4 eval API differences
      const res = await this.redis.sendCommand(['SET', this.leaderKey, this._leaderId, 'NX', 'PX', String(LEADER_TTL)]);
      if (res === 'OK') {
        this._isLeader = true;
        this._disabledReason = '';
        this.app.logger.info(`[LeaderElection] ✅ This node (${this._leaderId}) is now the LEADER`);

        this.startRenewal();
        return true;
      }
    } catch (err: any) {
      this.app.logger.error(`[LeaderElection] Error acquiring lock: ${err.message}`);
    }

    this._isLeader = false;
    this.app.logger.info(`[LeaderElection] Another node is leader — this node is FOLLOWER`);
    this.startRetry();
    return false;
  }

  /**
   * Fresh leadership check against Redis (fencing).
   *
   * The in-memory isLeader flag can be stale for up to one renewal interval if
   * this node was paused (long GC pause, container freeze, network stall) past
   * the lock TTL and another node took over. Orchestrator write operations
   * must call this before mutating anything so a resumed stale leader cannot
   * write alongside the new leader.
   */
  async verifyLeadership(): Promise<boolean> {
    if (!this.enabled || !this._isLeader) {
      return false;
    }
    if (!this.redis) {
      return this.standaloneMode;
    }
    try {
      const current = await this.redis.sendCommand(['GET', this.leaderKey]);
      if (current === this._leaderId) {
        return true;
      }
    } catch {
      // Redis unreachable — refuse writes rather than risk split-brain.
      return false;
    }
    // The lock expired or another node owns it now: step down immediately.
    this.app.logger.warn('[LeaderElection] Leadership verification failed — stepping down');
    this._isLeader = false;
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.renewTimer = null;
    this.startRetry();
    return false;
  }

  /**
   * Gracefully release leadership.
   */
  async release(): Promise<void> {
    if (this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = null;
    }
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }

    if (this._isLeader && this.redis) {
      try {
        const script = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
        await this.redis.sendCommand(['EVAL', script, '1', this.leaderKey, this._leaderId]);
        this.app.logger.info(`[LeaderElection] Lock released`);
      } catch {
        // Lock may have expired already
      }
    }
    this._isLeader = false;
  }

  // ─── Private ───

  private startRenewal() {
    if (this.renewTimer) clearInterval(this.renewTimer);

    this.renewTimer = setInterval(async () => {
      let definitelyLost = false;
      try {
        const script = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`;
        const res = await this.redis.sendCommand([
          'EVAL',
          script,
          '1',
          this.leaderKey,
          this._leaderId,
          String(LEADER_TTL),
        ]);
        if (res !== 1) {
          definitelyLost = true;
          throw new Error('Lock no longer held by this node');
        }
        return;
      } catch (err: any) {
        if (!definitelyLost) {
          // Transport error, not a confirmed loss. The lock may still be ours
          // (e.g. a brief network blip). Verify before stepping down: stepping
          // down on every transient failure means we cannot re-acquire our own
          // unexpired lock via SET NX, leaving the cluster leaderless until
          // the TTL lapses.
          try {
            const current = await this.redis.sendCommand(['GET', this.leaderKey]);
            if (current === this._leaderId) {
              this.app.logger.warn(
                `[LeaderElection] Renewal failed but the lock is still held — keeping leadership: ${err.message}`,
              );
              return;
            }
          } catch {
            // Verification inconclusive — fall through and step down.
          }
        }
        this._isLeader = false;
        this.app.logger.warn(`[LeaderElection] ⚠️ Lost leadership — lock renewal failed: ${err.message}`);
        if (this.renewTimer) clearInterval(this.renewTimer);
        this.renewTimer = null;
        // Start retry to re-acquire
        this.startRetry();
      }
    }, RENEW_INTERVAL);
  }

  private startRetry() {
    if (this.retryTimer) clearInterval(this.retryTimer);

    this.retryTimer = setInterval(async () => {
      if (this._isLeader) {
        // Already leader, stop retrying
        if (this.retryTimer) clearInterval(this.retryTimer);
        return;
      }
      try {
        const res = await this.redis.sendCommand([
          'SET',
          this.leaderKey,
          this._leaderId,
          'NX',
          'PX',
          String(LEADER_TTL),
        ]);
        if (res === 'OK') {
          this._isLeader = true;
          this.app.logger.info(`[LeaderElection] ✅ Acquired leadership (failover)`);
          if (this.retryTimer) clearInterval(this.retryTimer);
          this.retryTimer = null;
          this.startRenewal();
        }
      } catch {
        // Continue retrying
      }
    }, RETRY_INTERVAL);
  }
}
