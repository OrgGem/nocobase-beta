import os from 'os';

export class RedisNodeRegistry {
  private timer: NodeJS.Timeout | null = null;
  private readonly ttlSecs = 30; // 30 seconds TTL
  private readonly intervalMs = 10000; // Heartbeat every 10 seconds
  private readonly keyPrefix = 'worker-monitor:nodes:';

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
    const redis = this.app.redisConnectionManager?.getConnection();
    if (!redis) return;

    // Unique identifier combining hostname and pid (in case multiple workers share a host)
    // Even in Docker, hostnames might be identical if not set, but NocoBase uses random container hashes.
    // We'll use hostname + process.env.APP_PORT to be safe for local dev too.
    const port = process.env.APP_PORT || 'unknown';
    const mode = process.env.WORKER_MODE || 'main';
    const appName = process.env.APP_NAME || this.app.name || 'main';
    const nodeId = `${appName}_${mode}_${os.hostname()}_${port}_${process.pid}`;
    const key = `${this.keyPrefix}${nodeId}`;

    const metadata = {
      id: nodeId,
      name: `${appName} (${os.hostname()})`,
      appVersion: process.env.NOCOBASE_VERSION || process.version,
      workerMode: mode,
      pid: process.pid,
      url: null,
      available: true,
      lastHeartbeatAt: Date.now(),
      status: 'online', // Implicitly online since it just reported
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
    const redis = this.app.redisConnectionManager?.getConnection();
    if (!redis) return [];

    try {
      const rawKeys = await redis.sendCommand(['KEYS', `${this.keyPrefix}*`]);
      if (!Array.isArray(rawKeys) || rawKeys.length === 0) return [];

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
