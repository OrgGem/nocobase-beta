import os from 'os';
import { randomUUID } from 'crypto';
import { scanKeys, getRedisClient, isClusterRedisConfigured } from '../utils/redis';
import { getLocalNodeId } from '../utils/node';

export class RedisNodeRegistry {
  private timer: NodeJS.Timeout | null = null;
  private readonly ttlSecs = 30; // 30 seconds TTL
  private readonly intervalMs = 10000; // Heartbeat every 10 seconds
  private readonly keyPrefix: string;
  private warnedMissingRedis = false;
  private lastHeartbeatAt: number | null = null;
  private lastHeartbeatError: string | null = null;
  private lastReadError: string | null = null;
  private generationId = randomUUID();

  constructor(private app: any) {
    const appName = process.env.APP_NAME || app?.name || 'main';
    this.keyPrefix = `nocobase:${appName}:cluster-manager:nodes:`;
  }

  public start() {
    if (this.timer) {
      clearInterval(this.timer);
    }

    // Changes on every application start, including a soft restart in the same
    // Node.js process. Rolling restart uses this value to distinguish the new
    // application generation from a stale heartbeat left in Redis.
    this.generationId = randomUUID();

    // Initial heartbeat
    this.heartbeat();

    // Loop
    this.timer = setInterval(() => {
      this.heartbeat();
    }, this.intervalMs);
  }

  public stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async heartbeat() {
    const redis = getRedisClient(this.app);
    if (!redis) {
      this.lastHeartbeatError = 'Redis is not configured for cluster node discovery';
      if (!this.warnedMissingRedis) {
        this.warnedMissingRedis = true;
        this.app.logger.warn(
          '[RedisNodeRegistry] Redis is not configured; Cluster Nodes can only show the local fallback node.',
        );
      }
      return;
    }

    // Unique identifier combining hostname, port, pid, mode, and appName to handle multiple workers on the same host
    const port = process.env.APP_PORT || 'unknown';
    const mode = process.env.WORKER_MODE || 'main';
    const appName = process.env.APP_NAME || this.app.name || 'main';
    const nodeId = getLocalNodeId(this.app);
    const key = `${this.keyPrefix}${nodeId}`;

    // Collect process-level metrics so any node can read another node's full info from Redis
    const mem = process.memoryUsage();

    const metadata = {
      id: nodeId,
      generationId: this.generationId,
      name: `${appName} (${os.hostname()})`,
      hostname: os.hostname(),
      appVersion: process.env.NOCOBASE_VERSION || process.version,
      workerMode: mode,
      appRole: process.env.APP_ROLE,
      isSandbox: process.env.SKILL_HUB_SANDBOX === 'true',
      pid: process.pid,
      url: process.env.APP_PUBLIC_URL || null,
      probeUrl: process.env.CLUSTER_MANAGER_NODE_URL || null,
      available: true,
      lastHeartbeatAt: Date.now(),
      status: 'online', // Implicitly online since it just reported
      workerId: this.app.pm.get('plugin-cluster-manager')?.workerIdAllocator?.getStatus?.() || null,
      // Full node details (replicated from the `current` action shape)
      // so that any node can serve the "current" endpoint for the APP node
      nodeDetails: {
        node: {
          hostname: os.hostname(),
          pid: process.pid,
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch,
          uptime: process.uptime(),
          workerMode: mode,
          appRole: process.env.APP_ROLE || '',
          isSandbox: process.env.SKILL_HUB_SANDBOX === 'true',
          appPort: port,
          clusterMode: process.env.CLUSTER_MODE || '',
        },
        memory: {
          rss: mem.rss,
          heapUsed: mem.heapUsed,
          heapTotal: mem.heapTotal,
          external: mem.external,
          arrayBuffers: mem.arrayBuffers || 0,
        },
        os: {
          totalMemory: os.totalmem(),
          freeMemory: os.freemem(),
          cpuCount: os.cpus().length,
          loadAvg: os.loadavg(),
        },
      },
    };

    try {
      await redis.sendCommand(['SET', key, JSON.stringify(metadata), 'EX', this.ttlSecs.toString()]);
      this.lastHeartbeatAt = Date.now();
      this.lastHeartbeatError = null;
    } catch (err: any) {
      this.lastHeartbeatError = err.message;
      this.app.logger.error(`[RedisNodeRegistry] Heartbeat failed: ${err.message}`);
    }
  }

  public async getNodes(): Promise<any[]> {
    const redis = getRedisClient(this.app);
    if (!redis) {
      this.lastReadError = 'Redis is not configured for cluster node discovery';
      return [];
    }

    try {
      const rawKeys = await scanKeys(redis, `${this.keyPrefix}*`);
      if (rawKeys.length === 0) {
        this.lastReadError = null;
        return [];
      }

      const values = await redis.sendCommand(['MGET', ...rawKeys]);

      const nodes: any[] = [];
      if (Array.isArray(values)) {
        for (const val of values) {
          if (val) {
            try {
              nodes.push(JSON.parse(val));
            } catch (e) {
              // bad JSON, ignore
            }
          }
        }
      }
      this.lastReadError = null;
      return nodes;
    } catch (err: any) {
      this.lastReadError = err.message;
      this.app.logger.error(`[RedisNodeRegistry] Error fetching nodes: ${err.message}`);
      return [];
    }
  }

  public getStatus() {
    const redis = getRedisClient(this.app);
    return {
      configured: isClusterRedisConfigured(this.app),
      connected: Boolean(redis),
      keyPrefix: this.keyPrefix,
      ttlSecs: this.ttlSecs,
      intervalMs: this.intervalMs,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastHeartbeatError: this.lastHeartbeatError,
      lastReadError: this.lastReadError,
    };
  }
}
