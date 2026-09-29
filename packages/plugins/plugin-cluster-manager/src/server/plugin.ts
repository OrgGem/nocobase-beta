import { Plugin } from '@nocobase/server';
import * as os from 'os';
import path from 'path';
import { tasksActions } from './actions/tasks';
import { workflowActions } from './actions/workflow-executions';
import { redisActions } from './actions/redis-monitor';
import { aclCacheActions, createAclCacheMiddleware } from './actions/acl-cache';
import { clusterActions, readLocalLogs } from './actions/cluster-nodes';
import { getRedisClient } from './utils/redis';
import { getLocalNodeId, getLocalRole, isWorkerMode } from './utils/node';
import { eventQueueActions } from './actions/event-queue-monitor';
import { lockActions } from './actions/lock-monitor';
import { cacheMonitorActions } from './actions/cache-monitor';
import { RedisPubSubAdapter } from './adapters/redis-pubsub-adapter';
import { RedisEventQueueAdapter } from './adapters/redis-event-queue-adapter';
import { RedisNodeRegistry } from './adapters/redis-node-registry';
import { RedisLockAdapter } from '@nocobase/server';
import { orchestratorActions } from './actions/orchestrator';
import { pluginOperationsActions } from './actions/plugin-operations';
import { queueMappingsActions } from './actions/queue-mappings';
import type { IOrchestratorAdapter } from './orchestrator/types';
import { DockerAdapter } from './orchestrator/docker-adapter';
import { K8sAdapter } from './orchestrator/k8s-adapter';
import { LeaderElection } from './orchestrator/leader-election';
import { packageManagerActions } from './actions/package-manager';
import { PackageManager } from './orchestrator/PackageManager';
import { createListMetaCacheMiddleware } from './middlewares/listMetaCacheMiddleware';
import { registerCacheHooks } from './hooks/cacheInvalidationHooks';
import { collectLocalDoctorSnapshot, doctorActions } from './actions/doctor';
import { RedisWorkerIdAllocator } from './adapters/redis-worker-id-allocator';
import { healthActions } from './actions/health';
import { createIdempotencyMiddleware } from './middlewares/idempotencyMiddleware';
import { workerTemplateVariableActions } from './actions/worker-template-variables';
import { WORKER_TEMPLATE_DEFAULTS } from './orchestrator/worker-template';
import {
  ensureRedisEventQueueAdapter,
  ensureRedisLockAdapter,
  ensureRedisPubSubAdapter,
  ensureRedisWorkerIdAllocator,
  isRedisEventQueueEnabled,
  resolveHaRedisUrls,
  summarizeHaIntegration,
  type HaIntegrationResult,
} from './ha/core-ha-integration';
import { ensureAttachmentsCreatedByField } from './ha/core-compat';

export class PluginClusterManagerServer extends Plugin {
  public nodeRegistry: RedisNodeRegistry;
  public orchestrator: IOrchestratorAdapter | null = null;
  public leaderElection: LeaderElection | null = null;
  public workerIdAllocator: RedisWorkerIdAllocator | null = null;
  public haIntegration: HaIntegrationResult[] = [];

  async install() {
    const variables = this.db.getRepository('workerTemplateVariables');
    for (const value of WORKER_TEMPLATE_DEFAULTS) {
      const existing = await variables.findOne({ filter: { key: value.key, scope: 'global', stackId: null } });
      if (!existing) {
        await variables.create({ values: value });
      }
    }
  }

  async afterAdd() {
    // Core allocates the Snowflake worker ID inside Application.load(), which runs after every
    // plugin's afterAdd(). Registering here is the earliest safe point and guarantees the Redis
    // lease adapter exists before that allocation happens on every node.
    this.haIntegration.push(
      ensureRedisWorkerIdAllocator({
        allocator: this.app.workerIdAllocator as never,
        url: resolveHaRedisUrls().workerId,
        logger: this.app.logger,
        createAdapter: (url) => {
          this.workerIdAllocator = new RedisWorkerIdAllocator(url, this.app.name, this.app.logger);
          return this.workerIdAllocator;
        },
      }),
    );
  }

  async beforeLoad() {
    await this.db.import({ directory: path.resolve(__dirname, 'collections') });
  }

  async load() {
    // Upstream compatibility shims (see ./ha/core-compat.ts). Kept out of the
    // feature wiring so they stay easy to audit and remove once core fixes them.
    ensureAttachmentsCreatedByField(this.db as never);

    this.nodeRegistry = new RedisNodeRegistry(this.app);

    (this.app as any).on('afterStart', () => {
      this.nodeRegistry?.start();

      // Automatically install packages on boot for worker / sandbox nodes
      const isWorker =
        isWorkerMode(process.env.WORKER_MODE) ||
        process.env.APP_ROLE === 'worker' ||
        process.env.APP_ROLE === 'sandbox' ||
        process.env.SKILL_HUB_SANDBOX === 'true';
      if (isWorker) {
        setTimeout(async () => {
          try {
            const repo = this.app.db.getRepository('workerPackagesConfigs');
            if (!repo) return;
            let config = await repo.findOne();
            if (!config) {
              // Create a mock config so PackageManager runs and populates Redis status
              config = { get: () => undefined };
            }
            if (config) {
              this.app.logger.info('[ClusterManager] Auto-installing configured packages on worker boot...');

              const { packagesFromConfig } = require('../shared/packages');

              const configured = packagesFromConfig({
                aptPackages: config.get('aptPackages'),
                pythonPackages: config.get('pythonPackages'),
                npmPackages: config.get('npmPackages'),
              });

              let custom = { python: [], node: [], npm: [] };
              try {
                const customRaw = config.get('customPackages');
                if (customRaw) custom = typeof customRaw === 'string' ? JSON.parse(customRaw) : customRaw;
              } catch (err) {
                // ignore
              }

              const unique = (arr: any[]) => Array.from(new Set(arr.filter(Boolean)));

              const packages = {
                apt: unique([...(configured.apt || [])]),
                npm: unique([...(configured.npm || []), ...(custom.node || []), ...(custom.npm || [])]),
                python: unique([...(configured.python || []), ...(custom.python || [])]),
              };

              const pm = new PackageManager(this.app);
              await pm.executeInstall({
                targetRole: 'all', // executeInstall will filter internally based on current role
                packages,
                registryConfig: {
                  aptMirrorUrl: config.get('aptMirrorUrl'),
                  npmRegistryUrl: config.get('npmRegistryUrl'),
                  pypiIndexUrl: config.get('pypiIndexUrl'),
                },
              });
            }
          } catch (err: any) {
            this.app.logger.error(`[ClusterManager] Failed to auto-install packages on boot: ${err.message}`);
          }
        }, 5000); // Wait 5 seconds after boot to ensure system stability before heavy installs
      }
    });

    (this.app as any).on('beforeStop', () => {
      this.nodeRegistry?.stop();
    });

    // Workflow hook to trace executing node
    this.app.db.on('executions.afterSave', async (model: any) => {
      if (isWorkerMode(process.env.WORKER_MODE)) {
        const id = model.get('id');
        const redis = getRedisClient(this.app);
        if (id && redis) {
          const appName = process.env.APP_NAME || (this.app as any).name || 'main';
          const nodeName = appName === os.hostname() ? appName : `${appName} (${os.hostname()})`;
          redis.sendCommand(['SET', `cluster-manager:exec-node:${id}`, nodeName, 'EX', '86400']).catch(() => {});
        }
      }
    });

    // Bind core's HA building blocks to Redis. Core owns these objects; the cluster manager only
    // fills in an adapter when the deployment asks for one and nothing is registered yet.
    await this.ensureCoreHaAdapters();

    // Listen to remote restart commands and log requests
    const pubSub = (this.app as any).pubSubManager;
    if (pubSub) {
      const myNodeId = getLocalNodeId(this.app);

      // ── Log request handler: ONLY the targeted node receives this via dynamic channel ──
      pubSub.subscribe(`cluster-manager:log-request:${myNodeId}`, async (msg: string) => {
        try {
          const { requestId, targetNodeId, lines } = JSON.parse(msg);

          const redis = getRedisClient(this.app);
          if (!redis || !requestId) return;

          const logData = await readLocalLogs(this.app, lines || 200);
          const responseKey = `cluster-manager:log-response:${requestId}`;
          await redis.sendCommand(['SET', responseKey, JSON.stringify(logData), 'EX', '30']);
          this.app.logger.debug(`[ClusterManager] Served log request ${requestId} for ${targetNodeId}`);
        } catch (err: any) {
          this.app.logger.error(`[ClusterManager] Error handling log request: ${err.message}`);
        }
      });

      pubSub.subscribe(`cluster-manager:doctor-collect:${myNodeId}`, async (msg: string) => {
        const redis = getRedisClient(this.app);
        let requestId = '';
        try {
          const parsed = typeof msg === 'string' ? JSON.parse(msg) : msg;
          requestId = parsed.requestId;
          if (!redis || !requestId) return;

          const snapshot = await collectLocalDoctorSnapshot(this.app, {
            runId: parsed.runId,
            sinceMs: parsed.sinceMs,
            untilMs: parsed.untilMs,
            maxLines: parsed.maxLines,
          });
          await redis.sendCommand([
            'SET',
            `cluster-manager:doctor-response:${requestId}`,
            JSON.stringify(snapshot),
            'EX',
            '90',
          ]);
          this.app.logger.debug(`[ClusterManager] Served doctor snapshot request ${requestId}`);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          this.app.logger.error(`[ClusterManager] Error handling doctor snapshot request: ${message}`);
          if (redis && requestId) {
            const fallback = {
              nodeId: getLocalNodeId(this.app),
              collectedAt: new Date().toISOString(),
              error: message,
            };
            await redis
              .sendCommand([
                'SET',
                `cluster-manager:doctor-response:${requestId}`,
                JSON.stringify(fallback),
                'EX',
                '90',
              ])
              .catch(() => {});
          }
        }
      });
      // Package installation handler. PubSub delivers this to every node, and PackageManager
      // filters by the requested target role before executing anything locally.
      pubSub.subscribe('cluster-manager.install-packages', async (payload: any) => {
        try {
          const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
          const packageManager = new PackageManager(this.app);
          await packageManager.executeInstall(parsed);
        } catch (err: any) {
          this.app.logger.error(`[ClusterManager] Error handling package install request: ${err.message}`);
        }
      });

      pubSub.subscribe('cluster-manager:restart', (msg: string) => {
        try {
          let target = msg;
          let mode = 'hard';
          let targetNodeId = '';

          if (msg.startsWith('{')) {
            const parsed = JSON.parse(msg);
            target = parsed.hostname || parsed.target || '';
            targetNodeId = parsed.targetNodeId || '';
            mode = parsed.mode || 'hard';
          }

          const myNodeId = getLocalNodeId(this.app);
          const shouldRestart = targetNodeId ? targetNodeId === myNodeId : target === os.hostname() || target === '*';
          if (shouldRestart) {
            this.app.logger.warn(`[ClusterManager] Received ${mode} restart command for node ${os.hostname()}...`);
            setTimeout(async () => {
              try {
                if (mode === 'soft') {
                  this.app.logger.warn(`[ClusterManager] Triggering NocoBase Soft Restart...`);
                  await this.app.restart();
                } else {
                  this.app.logger.warn(`[ClusterManager] Shutting down Node.js process for Hard Restart...`);
                  await this.app.stop();
                  process.exit(1);
                }
              } catch (e: any) {
                // ignore
              }
            }, 1000); // 1-second delay so HTTP API can gracefully respond first
          }
        } catch (err) {
          this.app.logger.error(`[ClusterManager] Parse error for restart message: ${msg}`);
        }
      });
    }

    // Task management (reads asyncTasks table)
    this.app.resourcer.define({
      name: 'clusterManager',
      actions: {
        ...tasksActions,
        health: healthActions.liveness,
      },
    });
    this.app.acl.allow('clusterManager', 'health', 'public');

    // Workflow execution management (reads executions + jobs tables)
    this.app.resourcer.define({
      name: 'clusterManagerWorkflow',
      actions: workflowActions,
    });

    // Redis live metrics
    this.app.resourcer.define({
      name: 'clusterManagerRedis',
      actions: redisActions,
    });

    // ACL cache management
    this.app.resourcer.define({
      name: 'clusterManagerAclCache',
      actions: aclCacheActions,
    });

    // Cluster nodes & health
    this.app.resourcer.define({
      name: 'clusterManagerCluster',
      actions: clusterActions,
    });

    // Time-boxed diagnostic sessions and report download
    this.app.resourcer.define({
      name: 'clusterManagerDoctor',
      actions: doctorActions,
    });

    // Event queue monitoring
    this.app.resourcer.define({
      name: 'clusterManagerQueue',
      actions: eventQueueActions,
    });

    // Distributed lock monitoring
    this.app.resourcer.define({
      name: 'clusterManagerLock',
      actions: lockActions,
    });

    // Cache manager monitoring
    this.app.resourcer.define({
      name: 'clusterManagerCacheMgr',
      actions: cacheMonitorActions,
    });

    this.app.resourcer.define({
      name: 'clusterManagerHealth',
      actions: healthActions,
    });
    // Both probes must be reachable without auth: load balancers and the
    // docker healthcheck call readiness/liveness without a session token.
    this.app.acl.allow('clusterManagerHealth', 'liveness', 'public');
    this.app.acl.allow('clusterManagerHealth', 'readiness', 'public');

    // Package manager (installs apt/npm/python packages across nodes)
    this.app.resourcer.define({
      name: 'workerPackages',
      actions: packageManagerActions,
    });

    this.app.resourcer.define({
      name: 'workerTemplate',
      actions: workerTemplateVariableActions,
    });

    // Plugin operations (force disable/remove application plugin records)
    this.app.resourcer.define({
      name: 'clusterManagerPlugins',
      actions: pluginOperationsActions,
    });

    // Queue Mappings (queue-to-worker-stack assignments)
    this.app.resourcer.define({
      name: 'workerQueueMappings',
      actions: queueMappingsActions,
    });

    // Install ACL cache middleware inside the ACL chain so cached permissions are not overwritten.
    const aclCacheMiddleware = createAclCacheMiddleware(this.app);
    (this.app as any).acl.use(aclCacheMiddleware, {
      tag: 'aclCache',
      before: 'core',
      after: 'allow-manager',
    });

    // Install collections:listMeta resource cache middleware after setCurrentRole
    const listMetaCacheMiddleware = createListMetaCacheMiddleware(this.app);
    this.app.resourcer.use(listMetaCacheMiddleware, {
      tag: 'listMetaCache',
      after: 'setCurrentRole',
    });

    // Register DB hooks for invalidating cache versions
    registerCacheHooks(this.app);

    this.app.resourcer.use(createIdempotencyMiddleware(this.app), {
      tag: 'clusterManagerIdempotency',
    });

    // Admin-only access
    this.app.acl.registerSnippet({
      name: `pm.${this.name}`,
      actions: [
        'clusterManager:*',
        'clusterManagerWorkflow:*',
        'clusterManagerRedis:*',
        'clusterManagerAclCache:*',
        'clusterManagerCluster:*',
        'clusterManagerDoctor:*',
        'clusterManagerQueue:*',
        'clusterManagerLock:*',
        'clusterManagerCacheMgr:*',
        'workerOrchestrator:*',
        'orchestratorStacks:*',
        'workerTemplate:*',
        'workerPackages:*',
        'clusterManagerPlugins:*',
        'workerQueueMappings:*',
      ],
    });

    // ── Container Orchestrator ──
    await this.initOrchestrator();
  }

  /**
   * Bind core's HA infrastructure to Redis.
   *
   * Each helper is additive: when core or another plugin already registered an
   * adapter, it is preserved and the cluster manager only records the outcome.
   */
  private async ensureCoreHaAdapters() {
    const urls = resolveHaRedisUrls();
    const app = this.app as any;

    const pubSubResult = ensureRedisPubSubAdapter({
      pubSubManager: app.pubSubManager,
      url: urls.pubSub,
      logger: app.logger,
      createAdapter: (url) => new RedisPubSubAdapter(url, app.logger),
    });

    const eventQueueResult = await ensureRedisEventQueueAdapter({
      eventQueue: app.eventQueue,
      enabled: isRedisEventQueueEnabled(),
      url: urls.eventQueue,
      logger: app.logger,
      createAdapter: (url) => new RedisEventQueueAdapter({ app, url }),
    });

    const lockResult = ensureRedisLockAdapter({
      lockManager: app.lockManager,
      url: urls.lock,
      logger: app.logger,
      adapterConfig: {
        Adapter: RedisLockAdapter,
        options: { app },
      },
    });

    this.haIntegration.push(pubSubResult, eventQueueResult, lockResult);
    for (const result of this.haIntegration) {
      if (result.outcome === 'installed' || result.outcome === 'already-registered') {
        app.logger.info(result.message);
      }
    }
    app.logger.info(`[ClusterManager] Core HA adapters: ${summarizeHaIntegration(this.haIntegration)}`);
  }

  /**
   * Initialize the Container Orchestrator subsystem.
   * Config is loaded from DB (orchestratorSettings collection) first,
   * then falls back to ORCHESTRATOR_ADAPTER env var.
   * This allows manual configuration via the NocoBase admin UI.
   */
  private async initOrchestrator() {
    // Always register actions + collections so the UI can configure settings
    // even before an adapter is connected
    this.app.resourcer.define({
      name: 'workerOrchestrator',
      actions: {
        ...orchestratorActions,
        // Settings CRUD: read/write orchestrator config from DB
        async getSettings(ctx: any, next: () => Promise<void>) {
          try {
            const repo = ctx.db.getRepository('orchestratorSettings');
            let settings = await repo.findOne();
            if (!settings) {
              settings = await repo.create({
                values: { adapterType: process.env.ORCHESTRATOR_ADAPTER || 'none' },
              });
            }
            ctx.body = settings.toJSON();
          } catch {
            // Table may not exist during migration window
            ctx.body = { adapterType: 'none', _note: 'Settings table not yet ready.' };
          }
          await next();
        },
        async saveSettings(ctx: any, next: () => Promise<void>) {
          const values = ctx.action.params.values || {};
          const repo = ctx.db.getRepository('orchestratorSettings');
          let settings = await repo.findOne();
          if (settings) {
            await repo.update({ filterByTk: settings.get('id'), values });
          } else {
            settings = await repo.create({ values });
          }
          // Reinitialize adapter with new settings
          const plugin = ctx.app.pm.get('plugin-cluster-manager') as PluginClusterManagerServer;
          await plugin.connectAdapter(values);
          ctx.body = { success: true, message: 'Settings saved. Adapter reinitialized.' };
          await next();
        },
      },
    });

    // Load settings from DB and try to connect
    try {
      const repo = this.app.db.getRepository('orchestratorSettings');
      const settings = await repo.findOne();
      if (settings) {
        await this.connectAdapter(settings.toJSON());
      } else {
        // Fall back to env var for initial setup
        const envAdapter = process.env.ORCHESTRATOR_ADAPTER;
        if (envAdapter && envAdapter !== 'none') {
          await this.connectAdapter({
            adapterType: envAdapter,
            dockerSocketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock',
            k8sNamespace: 'nocobase',
          });
        } else {
          this.app.logger.info('[Orchestrator] No adapter configured — configurable via Cluster Manager UI');
        }
      }
    } catch (err: any) {
      this.app.logger.warn(`[Orchestrator] Could not load settings: ${err.message}`);
    }

    // Leader election runs on app nodes only. Worker-only pods still load the
    // plugin for monitoring/package installation, but they must not become the
    // Kubernetes orchestrator leader.
    const nonAppNode = this.isNonAppNode();
    this.leaderElection = new LeaderElection(this.app, {
      enabled: !nonAppNode,
      disabledReason: nonAppNode ? 'Non-app nodes do not run orchestrator write operations.' : '',
    });
    await this.leaderElection.init();

    (this.app as any).on('afterStart', async () => {
      if (this.leaderElection) {
        await this.leaderElection.tryBecomeLeader();
      }
    });

    (this.app as any).on('beforeStop', async () => {
      if (this.leaderElection) {
        await this.leaderElection.release();
      }
    });
  }

  /**
   * Connect (or reconnect) the orchestrator adapter based on settings.
   * Can be called at startup or when user saves new settings via UI.
   */
  public async connectAdapter(settings: any): Promise<boolean> {
    const adapterType = settings?.adapterType || 'none';

    if (adapterType === 'none') {
      this.orchestrator = null;
      this.app.logger.info('[Orchestrator] Adapter disabled');
      return false;
    }

    try {
      if (adapterType === 'docker') {
        const opts: any = {};
        if (settings.dockerHost) {
          // TCP connection (remote Docker or Docker Desktop on Windows)
          const url = new URL(settings.dockerHost);
          opts.host = url.hostname;
          opts.port = parseInt(url.port, 10) || 2376;
        } else {
          opts.socketPath = settings.dockerSocketPath || '/var/run/docker.sock';
        }
        opts.workerLabelSelector = settings.workerLabelSelector || 'role=worker';
        this.orchestrator = new DockerAdapter(opts);
        this.app.logger.info('[Orchestrator] Docker adapter initialized');
      } else if (adapterType === 'kubernetes') {
        this.orchestrator = new K8sAdapter({
          kubeconfig: settings.k8sKubeconfig || undefined,
          namespace: settings.k8sNamespace || 'nocobase',
          workerLabelSelector: settings.workerLabelSelector || 'role=worker',
        });
        this.app.logger.info('[Orchestrator] Kubernetes adapter initialized');
      } else {
        this.app.logger.warn(`[Orchestrator] Unknown adapter type: ${adapterType}`);
        this.orchestrator = null;
        return false;
      }

      // Test connectivity
      const connected = await this.orchestrator.ping();
      if (!connected) {
        this.app.logger.error(`[Orchestrator] Failed to connect to ${adapterType} runtime`);
        this.orchestrator = null;
        return false;
      }

      this.app.logger.info(`[Orchestrator] ✅ Connected to ${adapterType} runtime`);
      return true;
    } catch (err: any) {
      this.app.logger.error(`[Orchestrator] Adapter init failed: ${err.message}`);
      this.orchestrator = null;
      return false;
    }
  }

  private isNonAppNode(): boolean {
    return getLocalRole() !== 'app';
  }
}

export default PluginClusterManagerServer;
