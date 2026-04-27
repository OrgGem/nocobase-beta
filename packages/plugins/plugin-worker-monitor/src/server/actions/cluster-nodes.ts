import { Context } from '@nocobase/actions';
import { AppSupervisor } from '@nocobase/server';
import os from 'os';
import { promises as fsp } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { RedisNodeRegistry } from '../adapters/redis-node-registry';
import { getRedis } from '../utils/redis';
import { getLocalNodeId } from '../utils/node';

const LOG_RESPONSE_KEY_PREFIX = 'worker-monitor:log-response:';
const LOG_RESPONSE_TTL = 30; // seconds

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read the last N lines from the local system log file.
 * Extracted so it can be called from both the HTTP action and the PubSub subscriber.
 */
export async function readLocalLogs(app: any, maxLines: number) {
  const logBasePath = process.env.LOGGER_BASE_PATH || path.resolve(process.cwd(), 'storage', 'logs');
  const appName = process.env.APP_NAME || app.name || 'main';
  const logDir = path.resolve(logBasePath, appName);

  let logFiles: string[] = [];
  try {
    const files = await fsp.readdir(logDir);
    logFiles = files
      .filter((f) => f.startsWith('system') && f.endsWith('.log') && !f.includes('error'))
      .sort()
      .reverse();
  } catch {
    // logDir doesn't exist or not readable
  }

  const nodeInfo = {
    hostname: os.hostname(),
    pid: process.pid,
    workerMode: process.env.WORKER_MODE || 'main',
  };

  if (logFiles.length === 0) {
    return { node: nodeInfo, lines: [] as string[], file: null };
  }

  const logFilePath = path.resolve(logDir, logFiles[0]);
  const result: string[] = [];
  try {
    const stat = await fsp.stat(logFilePath);
    const bufferSize = Math.min(stat.size, maxLines * 2048);
    const buffer = Buffer.alloc(bufferSize);
    const fh = await fsp.open(logFilePath, 'r');
    await fh.read(buffer, 0, bufferSize, Math.max(0, stat.size - bufferSize));
    await fh.close();

    const content = buffer.toString('utf8');
    const allLines = content.split('\n').filter((l) => l.trim());
    result.push(...allLines.slice(-maxLines));
  } catch {
    // File read error
  }

  return { node: nodeInfo, lines: result, file: logFiles[0] };
}


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
          hostname: env.hostname || os.hostname(),
          url: env.url,
          available: env.available,
          appVersion: env.appVersion,
          lastHeartbeatAt: env.lastHeartbeatAt ? new Date(env.lastHeartbeatAt).toISOString() : null,
          status: env.status || 'online',
          workerMode: env.workerMode,
          isSandbox: env.isSandbox,
          pid: env.pid
        });
      }
    }

    // If no discovery adapter or empty, at least return current node
    if (environments.length === 0) {
      environments.push({
        name: os.hostname(),
        hostname: os.hostname(),
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

  /**
   * GET /workerMonitorCluster:logs?targetNodeId=xxx&lines=200
   *
   * HA-aware log viewer. Reads logs from a specific node in the cluster.
   *
   * Flow:
   *  1. If targetNodeId matches current node (or is empty) → read local FS directly
   *  2. Otherwise → publish a log request via PubSub → target node reads its local FS
   *     and writes the result to a Redis key → this handler polls Redis until the
   *     response arrives (max 10s) → returns it to the client
   */
  async logs(ctx: Context, next: () => Promise<void>) {
    const { lines = 200, targetNodeId } = ctx.action.params;
    const maxLines = Math.min(Number(lines) || 200, 1000);
    const myNodeId = getLocalNodeId(ctx.app);

    // ── Case 1: Local read (no target specified, or target is this node) ──
    if (!targetNodeId || targetNodeId === myNodeId) {
      ctx.body = await readLocalLogs(ctx.app, maxLines);
      await next();
      return;
    }

    // ── Case 2: Remote read via PubSub → Redis response pattern ──
    const redis = getRedis(ctx);
    const pubSub = (ctx.app as any).pubSubManager;

    if (!redis || !pubSub) {
      // No HA infrastructure — fall back to local logs with a warning
      const localResult = await readLocalLogs(ctx.app, maxLines);
      (localResult as any)._fallback = true;
      (localResult as any)._note = `PubSub/Redis not available; showing logs from local node instead of ${targetNodeId}`;
      ctx.body = localResult;
      await next();
      return;
    }

    // Generate a unique request ID for the response channel
    const requestId = crypto.randomBytes(8).toString('hex');
    const responseKey = `${LOG_RESPONSE_KEY_PREFIX}${requestId}`;

    // Publish the log request — ONLY the target node is subscribed to this specific channel
    await pubSub.publish(
      `worker-monitor:log-request:${targetNodeId}`,
      JSON.stringify({ requestId, targetNodeId, lines: maxLines }),
    );

    // Poll Redis for the response (200ms interval, max 10s = 50 iterations)
    let responseData: any = null;
    for (let i = 0; i < 50; i++) {
      await sleep(200);
      try {
        const raw = await redis.sendCommand(['GET', responseKey]);
        if (raw) {
          responseData = JSON.parse(raw);
          // Clean up the response key immediately
          redis.sendCommand(['DEL', responseKey]).catch(() => {});
          break;
        }
      } catch {
        // Parse error or Redis error — continue polling
      }
    }

    if (responseData) {
      ctx.body = responseData;
    } else {
      // Timeout — target node may be unreachable
      ctx.body = {
        node: { hostname: 'unknown', pid: null, workerMode: 'unknown', id: targetNodeId },
        lines: [],
        file: null,
        _error: `Timeout waiting for logs from ${targetNodeId}. Node may be offline or PubSub is not connected.`,
      };
    }

    await next();
  },
};
