import { Context } from '@nocobase/actions';
import os from 'os';
import { promises as fsp } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { RedisNodeRegistry } from '../adapters/redis-node-registry';
import { getRedis } from '../utils/redis';
import { getLocalNodeId } from '../utils/node';
import { packagesFromConfig, type WorkerPackageMap } from '../../shared/packages';

const LOG_RESPONSE_KEY_PREFIX = 'cluster-manager:log-response:';
const LEGACY_MULTI_APP_PLUGINS = ['multi-app-manager', 'multi-app-share-collection'];

interface ClusterNodeRecord {
  id?: string;
  name?: string;
  hostname?: string;
  appVersion?: string;
  workerMode?: string;
  isSandbox?: boolean;
  status?: string;
  url?: string | null;
  available?: boolean;
  lastHeartbeatAt?: number;
  pid?: number;
  nodeDetails?: {
    node?: {
      nodeVersion?: string;
      platform?: string;
      arch?: string;
    };
  };
}

interface PackageStatus {
  initStatus?: string;
  initProgressPercent?: number;
  initProgressLog?: string;
  lastInitAt?: string | Date;
  lastInitLog?: string;
  packageWhitelist?:
    | string
    | {
        apt?: string[];
        npm?: string[];
        node?: string[];
        python?: string[];
      };
}

interface NormalizedPackages {
  apt: string[];
  npm: string[];
  python: string[];
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .filter((item) => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function normalizePackageMap(packages?: WorkerPackageMap): NormalizedPackages {
  return {
    apt: normalizeList(packages?.apt),
    npm: normalizeList(packages?.npm),
    python: normalizeList(packages?.python),
  };
}

function parsePackageWhitelist(status?: PackageStatus | null): NormalizedPackages {
  if (!status?.packageWhitelist) {
    return { apt: [], npm: [], python: [] };
  }

  let whitelistValue: unknown = status.packageWhitelist;
  if (typeof whitelistValue === 'string') {
    try {
      whitelistValue = JSON.parse(whitelistValue);
    } catch {
      return { apt: [], npm: [], python: [] };
    }
  }

  if (!whitelistValue || typeof whitelistValue !== 'object' || Array.isArray(whitelistValue)) {
    return { apt: [], npm: [], python: [] };
  }

  const whitelist = whitelistValue as {
    apt?: string[];
    npm?: string[];
    node?: string[];
    python?: string[];
  };

  return {
    apt: normalizeList(whitelist.apt),
    npm: normalizeList(whitelist.npm || whitelist.node),
    python: normalizeList(whitelist.python),
  };
}

function diffPackages(expected: NormalizedPackages, installed: NormalizedPackages): NormalizedPackages {
  return {
    apt: expected.apt.filter((pkg) => !installed.apt.includes(pkg)),
    npm: expected.npm.filter((pkg) => !installed.npm.includes(pkg)),
    python: expected.python.filter((pkg) => !installed.python.includes(pkg)),
  };
}

function hasMissingPackages(packages: NormalizedPackages): boolean {
  return packages.apt.length > 0 || packages.npm.length > 0 || packages.python.length > 0;
}

function getNodeRole(node: ClusterNodeRecord): 'app' | 'worker' | 'sandbox' {
  if (node.isSandbox) {
    return 'sandbox';
  }
  const workerMode = node.workerMode || 'main';
  return workerMode === 'worker' || workerMode === 'task' || workerMode === '*' ? 'worker' : 'app';
}

function getReferenceVersion(nodes: ClusterNodeRecord[]) {
  const appNode = nodes.find((node) => getNodeRole(node) === 'app' && node.appVersion);
  if (appNode?.appVersion) {
    return appNode.appVersion;
  }

  const counts = new Map<string, number>();
  for (const node of nodes) {
    if (!node.appVersion) continue;
    counts.set(node.appVersion, (counts.get(node.appVersion) || 0) + 1);
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

async function getClusterNodes(ctx: Context): Promise<ClusterNodeRecord[]> {
  const plugin = (ctx.app as any).pm?.get?.('plugin-cluster-manager') as any;
  const registry = plugin?.nodeRegistry ?? new RedisNodeRegistry(ctx.app);
  return registry.getNodes();
}

async function getExpectedPackages(ctx: Context): Promise<NormalizedPackages> {
  const repo = ctx.db.getRepository('workerPackagesConfigs');
  const config = await repo?.findOne?.();
  if (!config) {
    return normalizePackageMap(packagesFromConfig({}));
  }

  return normalizePackageMap(
    packagesFromConfig({
      aptPackages: config.get('aptPackages'),
      pythonPackages: config.get('pythonPackages'),
      npmPackages: config.get('npmPackages'),
    }),
  );
}

async function readPackageStatus(ctx: Context, node: ClusterNodeRecord): Promise<PackageStatus | null> {
  const redis = getRedis(ctx);
  if (!redis) return null;

  const keys = [
    node.id ? `cluster-manager:pkg-status:${node.id}` : null,
    node.hostname ? `orchestrator:pkg-status:${node.hostname}` : null,
    node.name ? `orchestrator:pkg-status:${node.name}` : null,
  ].filter(Boolean) as string[];

  for (const key of keys) {
    try {
      const raw = await redis.sendCommand(['GET', key]);
      if (raw && typeof raw === 'string') {
        return JSON.parse(raw);
      }
    } catch {
      // Try the next key.
    }
  }

  return null;
}

async function getApplicationPluginRows(ctx: Context) {
  const repo = ctx.db.getRepository('applicationPlugins');
  if (!repo) return [];
  const rows = await repo.find({ sort: ['name'] });
  return rows.map((row: any) => row.toJSON());
}

function getPayload(ctx: Context) {
  return (ctx.action.params.values || (ctx as any).request?.body?.values || (ctx as any).request?.body || {}) as any;
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
   * GET /clusterManagerCluster:current
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
      const plugin = (ctx.app as any).pm?.get?.('plugin-cluster-manager') as any;
      const registry = plugin?.nodeRegistry ?? new RedisNodeRegistry(ctx.app);
      const nodes = await registry.getNodes();
      const appNode = nodes.find((n: any) => n.workerMode === 'main' || n.workerMode === '' || n.workerMode === 'app');

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
   * GET /clusterManagerCluster:list
   * Returns all known cluster environments/nodes (if discovery adapter supports it)
   */
  async list(ctx: Context, next: () => Promise<void>) {
    const environments: any[] = [];

    const nodes = await getClusterNodes(ctx);

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
          pid: env.pid,
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
   * GET /clusterManagerCluster:drift
   * Reports version/runtime/package drift across active cluster nodes.
   */
  async drift(ctx: Context, next: () => Promise<void>) {
    const nodes = await getClusterNodes(ctx);
    const referenceVersion = getReferenceVersion(nodes);
    const expectedPackages = await getExpectedPackages(ctx);

    const versionDrifts = nodes
      .filter((node) => node.status !== 'offline')
      .filter((node) => referenceVersion && node.appVersion && node.appVersion !== referenceVersion)
      .map((node) => ({
        id: node.id,
        name: node.name,
        hostname: node.hostname,
        role: getNodeRole(node),
        expectedVersion: referenceVersion,
        actualVersion: node.appVersion,
      }));

    const runtimeReference = nodes.find((node) => getNodeRole(node) === 'app')?.nodeDetails?.node;
    const runtimeDrifts = runtimeReference
      ? nodes
          .filter((node) => node.status !== 'offline')
          .filter((node) => {
            const runtime = node.nodeDetails?.node;
            if (!runtime) return false;
            return (
              runtime.nodeVersion !== runtimeReference.nodeVersion ||
              runtime.platform !== runtimeReference.platform ||
              runtime.arch !== runtimeReference.arch
            );
          })
          .map((node) => ({
            id: node.id,
            name: node.name,
            hostname: node.hostname,
            role: getNodeRole(node),
            expected: {
              nodeVersion: runtimeReference.nodeVersion,
              platform: runtimeReference.platform,
              arch: runtimeReference.arch,
            },
            actual: {
              nodeVersion: node.nodeDetails?.node?.nodeVersion,
              platform: node.nodeDetails?.node?.platform,
              arch: node.nodeDetails?.node?.arch,
            },
          }))
      : [];

    const packageDrifts: Array<Record<string, unknown>> = [];
    for (const node of nodes.filter((item) => item.status !== 'offline' && getNodeRole(item) !== 'app')) {
      const status = await readPackageStatus(ctx, node);
      const installedPackages = parsePackageWhitelist(status);
      const missingPackages = diffPackages(expectedPackages, installedPackages);
      const hasPackageStatus = Boolean(status);
      const statusOk = status?.initStatus === 'succeeded';
      if (!hasPackageStatus || !statusOk || hasMissingPackages(missingPackages)) {
        packageDrifts.push({
          id: node.id,
          name: node.name,
          hostname: node.hostname,
          role: getNodeRole(node),
          status: status?.initStatus || 'unknown',
          lastInitAt: status?.lastInitAt || null,
          missingPackages,
          installedPackages,
          initProgressLog: status?.initProgressLog || '',
        });
      }
    }

    ctx.body = {
      healthy: versionDrifts.length === 0 && runtimeDrifts.length === 0 && packageDrifts.length === 0,
      referenceVersion,
      expectedPackages,
      versionDrifts,
      runtimeDrifts,
      packageDrifts,
      checkedAt: new Date().toISOString(),
      summary: {
        nodes: nodes.length,
        versionDrifts: versionDrifts.length,
        runtimeDrifts: runtimeDrifts.length,
        packageDrifts: packageDrifts.length,
      },
    };
    await next();
  },

  /**
   * GET /clusterManagerCluster:legacyDiagnostics
   * Detects deprecated legacy multi-app plugins and leftover application records.
   */
  async legacyDiagnostics(ctx: Context, next: () => Promise<void>) {
    const rows = await getApplicationPluginRows(ctx);
    const plugins = LEGACY_MULTI_APP_PLUGINS.map((name) => {
      const row = rows.find((item: any) => item.name === name || item.packageName === `@nocobase/plugin-${name}`);
      const loaded = Boolean(
        (ctx.app as any).pm?.get?.(name) || (ctx.app as any).pm?.get?.(`@nocobase/plugin-${name}`),
      );
      return {
        name,
        packageName: `@nocobase/plugin-${name}`,
        installed: Boolean(row),
        enabled: Boolean(row?.enabled),
        loaded,
        version: row?.version,
      };
    });

    let legacyApplicationCount = 0;
    if (ctx.db.hasCollection?.('applications')) {
      try {
        legacyApplicationCount = await ctx.db.getRepository('applications').count();
      } catch {
        legacyApplicationCount = 0;
      }
    }

    const findings = [];
    const manager = plugins.find((plugin) => plugin.name === 'multi-app-manager');
    const shareCollection = plugins.find((plugin) => plugin.name === 'multi-app-share-collection');
    const appSupervisor = rows.find(
      (item: any) => item.name === 'app-supervisor' || item.packageName === '@nocobase/plugin-app-supervisor',
    );

    if (manager?.enabled || manager?.loaded) {
      findings.push({
        level: 'warning',
        code: 'legacy_multi_app_manager_active',
        messageKey:
          'Deprecated multi-app manager is active. It runs apps in shared process memory and should not be used for production cluster isolation.',
        message:
          'Deprecated multi-app manager is active. It runs apps in shared process memory and should not be used for production cluster isolation.',
      });
    }

    if (shareCollection?.enabled || shareCollection?.loaded) {
      findings.push({
        level: 'warning',
        code: 'legacy_share_collection_active',
        messageKey:
          'Deprecated multi-app share collection is active. Avoid schema/table sharing for new cluster deployments.',
        message:
          'Deprecated multi-app share collection is active. Avoid schema/table sharing for new cluster deployments.',
      });
    }

    if (legacyApplicationCount > 0) {
      findings.push({
        level: 'warning',
        code: 'legacy_app_records_found',
        messageKey: '{count} legacy application record(s) were found in the applications collection.',
        messageArgs: { count: legacyApplicationCount },
        message: `${legacyApplicationCount} legacy application record(s) were found in the applications collection.`,
      });
    }

    if (!appSupervisor?.enabled) {
      findings.push({
        level: 'info',
        code: 'app_supervisor_not_enabled',
        messageKey:
          'App Supervisor is not enabled. Use it for new multi-application management instead of deprecated multi-app plugins.',
        message:
          'App Supervisor is not enabled. Use it for new multi-application management instead of deprecated multi-app plugins.',
      });
    }

    ctx.body = {
      healthy: findings.every((finding) => finding.level !== 'warning'),
      plugins,
      appSupervisor: appSupervisor
        ? {
            installed: true,
            enabled: Boolean(appSupervisor.enabled),
            version: appSupervisor.version,
          }
        : { installed: false, enabled: false },
      legacyApplicationCount,
      findings,
    };
    await next();
  },

  /**
   * GET /clusterManagerCluster:health
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
   * POST /clusterManagerCluster:restart
   * Publishes a restart signal to target nodes orchestrating a soft NocoBase restart or a hard docker daemon rebirth
   */
  async restart(ctx: Context, next: () => Promise<void>) {
    const { hostname, mode = 'hard' } = ctx.action.params.values || ctx.action.params;
    if (!hostname) ctx.throw(400, 'Hostname required');

    // NocoBase initializes pubSubManager ONLY IF PUBSUB_ADAPTER_REDIS_URL is provided natively.
    if ((ctx.app as any).pubSubManager) {
      await (ctx.app as any).pubSubManager.publish('cluster-manager:restart', JSON.stringify({ hostname, mode }));
      ctx.body = { success: true, target: hostname, mode };
    } else {
      ctx.throw(500, 'PubSub manager is not initialized. HA requires PUBSUB_ADAPTER_REDIS_URL to be set.');
    }
    await next();
  },

  /**
   * POST /clusterManagerCluster:rollingRestart
   * Restarts online nodes one-by-one, optionally filtered by role.
   */
  async rollingRestart(ctx: Context, next: () => Promise<void>) {
    const payload = getPayload(ctx);
    const mode = payload.mode === 'soft' ? 'soft' : 'hard';
    const role = payload.role || 'worker';
    const delayMs = Math.min(Math.max(Number(payload.delayMs) || 5000, 1000), 60000);
    const requestedNodeIds = Array.isArray(payload.nodeIds) ? payload.nodeIds.map(String) : [];

    const pubSub = (ctx.app as any).pubSubManager;
    if (!pubSub) {
      ctx.throw(500, 'PubSub manager is not initialized. HA requires PUBSUB_ADAPTER_REDIS_URL to be set.');
    }

    const nodes = (await getClusterNodes(ctx)).filter((node) => {
      if (node.status === 'offline') return false;
      if (requestedNodeIds.length > 0) return node.id && requestedNodeIds.includes(node.id);
      if (role === 'all') return true;
      return getNodeRole(node) === role;
    });

    if (nodes.length === 0) {
      ctx.throw(404, 'No online nodes match the rolling restart target.');
    }

    const myNodeId = getLocalNodeId(ctx.app);
    const sortedNodes = nodes.sort((a, b) => {
      if (a.id === myNodeId) return 1;
      if (b.id === myNodeId) return -1;
      return String(a.name || a.id).localeCompare(String(b.name || b.id));
    });

    const published = [];
    for (let index = 0; index < sortedNodes.length; index += 1) {
      const node = sortedNodes[index];
      await pubSub.publish(
        'cluster-manager:restart',
        JSON.stringify({
          targetNodeId: node.id,
          hostname: node.hostname,
          mode,
        }),
      );
      published.push({
        id: node.id,
        name: node.name,
        hostname: node.hostname,
        role: getNodeRole(node),
        mode,
        order: index + 1,
      });

      if (index < sortedNodes.length - 1) {
        await sleep(delayMs);
      }
    }

    ctx.body = {
      success: true,
      mode,
      role,
      delayMs,
      published,
    };
    await next();
  },

  /**
   * GET /clusterManagerCluster:logs?targetNodeId=xxx&lines=200
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
      (localResult as any)._note =
        `PubSub/Redis not available; showing logs from local node instead of ${targetNodeId}`;
      ctx.body = localResult;
      await next();
      return;
    }

    // Generate a unique request ID for the response channel
    const requestId = crypto.randomBytes(8).toString('hex');
    const responseKey = `${LOG_RESPONSE_KEY_PREFIX}${requestId}`;

    // Publish the log request — ONLY the target node is subscribed to this specific channel
    await pubSub.publish(
      `cluster-manager:log-request:${targetNodeId}`,
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
