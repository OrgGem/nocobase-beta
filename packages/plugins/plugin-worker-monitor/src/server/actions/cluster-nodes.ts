import { Context } from '@nocobase/actions';
import { AppSupervisor } from '@nocobase/server';
import os from 'os';
import { RedisNodeRegistry } from '../adapters/redis-node-registry';
import { getRedis } from '../utils/redis';


export const clusterActions = {
  /**
   * GET /workerMonitorCluster:current
   * Always returns info about the APP node (not workers).
   * If this request is handled by a worker, we look up the APP node from Redis.
   */
  async current(ctx: Context, next: () => Promise<void>) {
    const currentMode = process.env.WORKER_MODE || 'main';
    const isApp = currentMode === 'main' || currentMode === '' || currentMode === 'app';

    if (isApp) {
      // This process IS the APP node — return local data directly
      const mem = process.memoryUsage();
      ctx.body = {
        node: {
          hostname: os.hostname(),
          pid: process.pid,
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch,
          uptime: process.uptime(),
          workerMode: currentMode,
          appPort: process.env.APP_PORT || '',
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
      };
    } else {
      // This process is a WORKER — find the APP node from Redis heartbeat data
      const registry = new RedisNodeRegistry(ctx.app);
      const nodes = await registry.getNodes();
      const appNode = nodes.find(
        (n: any) => n.workerMode === 'main' || n.workerMode === '' || n.workerMode === 'app',
      );

      if (appNode?.nodeDetails) {
        ctx.body = appNode.nodeDetails;
      } else {
        // Fallback: return local data with a flag so the UI knows
        const mem = process.memoryUsage();
        ctx.body = {
          node: {
            hostname: os.hostname(),
            pid: process.pid,
            nodeVersion: process.version,
            platform: process.platform,
            arch: process.arch,
            uptime: process.uptime(),
            workerMode: currentMode,
            appPort: process.env.APP_PORT || '',
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
          _fallback: true,
          _note: 'APP node not found in Redis; showing responding worker data',
        };
      }
    }

    await next();
  },

  /**
   * GET /workerMonitorCluster:list
   * Returns all known cluster environments/nodes (if discovery adapter supports it)
   */
  async list(ctx: Context, next: () => Promise<void>) {
    const supervisor = AppSupervisor.getInstance();
    const environments: any[] = [];

    const registry = new RedisNodeRegistry(ctx.app);
    const nodes = await registry.getNodes();
    
    if (nodes && nodes.length > 0) {
      for (const env of nodes) {
        environments.push({
          id: env.id || env.name,
          name: env.name,
          url: env.url,
          available: env.available,
          appVersion: env.appVersion,
          lastHeartbeatAt: env.lastHeartbeatAt ? new Date(env.lastHeartbeatAt).toISOString() : null,
          status: env.status || 'online',
          workerMode: env.workerMode,
          pid: env.pid
        });
      }
    }

    // If no discovery adapter or empty, at least return current node
    if (environments.length === 0) {
      environments.push({
        name: os.hostname(),
        url: null,
        available: true,
        appVersion: null,
        lastHeartbeatAt: new Date().toISOString(),
        status: 'online',
      });
    }

    ctx.body = { data: environments, meta: { count: environments.length } };
    await next();
  },

  /**
   * GET /workerMonitorCluster:health
   * Health check for all subsystems
   */
  async health(ctx: Context, next: () => Promise<void>) {
    const checks: Record<string, { status: string; latency?: number; detail?: string }> = {};

    // Redis check
    try {
      const redis = getRedis(ctx);
      if (redis) {
        const start = Date.now();
        await redis.ping();
        checks.redis = { status: 'ok', latency: Date.now() - start };
      } else {
        checks.redis = { status: 'not_configured' };
      }
    } catch (e: any) {
      checks.redis = { status: 'error', detail: e.message };
    }

    // Database check
    try {
      const start = Date.now();
      await ctx.db.sequelize.query('SELECT 1');
      checks.database = { status: 'ok', latency: Date.now() - start };
    } catch (e: any) {
      checks.database = { status: 'error', detail: e.message };
    }

    // PubSub check
    try {
      const connected = await ctx.app.pubSubManager?.isConnected();
      const pubSubAdapter = (ctx.app.pubSubManager as any)?.adapter;
      checks.pubsub = { 
        status: connected ? 'connected' : 'disconnected',
        detail: pubSubAdapter?.constructor?.name || 'no adapter',
      };
    } catch (e: any) {
      checks.pubsub = { status: 'error', detail: e.message };
    }

    // Event Queue check
    try {
      const connected = ctx.app.eventQueue?.isConnected();
      const adapterType = (ctx.app.eventQueue as any)?.adapter?.constructor?.name || 'unknown';
      checks.eventQueue = {
        status: connected ? 'connected' : 'disconnected',
        detail: adapterType,
      };
    } catch (e: any) {
      checks.eventQueue = { status: 'error', detail: e.message };
    }

    // Lock Manager check
    try {
      const lockOptions = (ctx.app.lockManager as any)?.options;
      const adapterType = lockOptions?.defaultAdapter || 'local';
      checks.lockManager = { status: 'ok', detail: `adapter: ${adapterType}` };
    } catch (e: any) {
      checks.lockManager = { status: 'error', detail: e.message };
    }

    // Cache check
    try {
      const defaultStore = ctx.app.cacheManager?.defaultStore || 'memory';
      checks.cache = { status: 'ok', detail: `store: ${defaultStore}` };
    } catch (e: any) {
      checks.cache = { status: 'error', detail: e.message };
    }

    const allOk = Object.values(checks).every(
      (c) => c.status === 'ok' || c.status === 'connected' || c.status === 'not_configured',
    );

    ctx.body = { healthy: allOk, checks };
    await next();
  },

  /**
   * POST /workerMonitorCluster:restart
   * Publishes a restart signal to target nodes orchestrating a soft NocoBase restart or a hard docker daemon rebirth
   */
  async restart(ctx: Context, next: () => Promise<void>) {
    const { hostname, mode = 'hard' } = ctx.action.params.values || ctx.action.params;
    if (!hostname) ctx.throw(400, 'Hostname required');
    
    // NocoBase initializes pubSubManager ONLY IF PUBSUB_ADAPTER_REDIS_URL is provided natively.
    if ((ctx.app as any).pubSubManager) {
      await (ctx.app as any).pubSubManager.publish('worker-monitor:restart', JSON.stringify({ hostname, mode }));
      ctx.body = { success: true, target: hostname, mode };
    } else {
      ctx.throw(500, 'PubSub manager is not initialized. HA requires PUBSUB_ADAPTER_REDIS_URL to be set.');
    }
    await next();
  },
};
