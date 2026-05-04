import os from 'os';
import { scanKeys, getRedisClient } from '../utils/redis';
import { getLocalNodeId } from '../utils/node';

export class RedisNodeRegistry {
  private timer: NodeJS.Timeout | null = null;
  private readonly ttlSecs = 30; // 30 seconds TTL
  private readonly intervalMs = 10000; // Heartbeat every 10 seconds
  private readonly keyPrefix = 'cluster-manager:nodes:';

  constructor(private app: any) {}

  public start() {
    if (this.timer) {
      clearInterval(this.timer);
    }
    
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
    if (!redis) return;

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
      name: `${appName} (${os.hostname()})`,
      hostname: os.hostname(),
      appVersion: process.env.NOCOBASE_VERSION || process.version,
      workerMode: mode,
      isSandbox: process.env.SKILL_HUB_SANDBOX === 'true',
      pid: process.pid,
      url: process.env.APP_PUBLIC_URL || null,
      available: true,
      lastHeartbeatAt: Date.now(),
      status: 'online', // Implicitly online since it just reported
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
      await redis.sendCommand([
        'SET',
        key,
        JSON.stringify(metadata),
        'EX',
        this.ttlSecs.toString(),
      ]);
    } catch (err: any) {
      this.app.logger.error(`[RedisNodeRegistry] Heartbeat failed: ${err.message}`);
    }
  }

  public async getNodes(): Promise<any[]> {
    const redis = getRedisClient(this.app);
    if (!redis) return [];

    try {
      const rawKeys = await scanKeys(redis, `${this.keyPrefix}*`);
      if (rawKeys.length === 0) return [];

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
      return nodes;
    } catch (err: any) {
      this.app.logger.error(`[RedisNodeRegistry] Error fetching nodes: ${err.message}`);
      return [];
    }
  }
}
