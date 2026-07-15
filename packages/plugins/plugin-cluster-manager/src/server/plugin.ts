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
import { RedisLockAdapter } from './adapters/redis-lock-adapter';
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

export class PluginClusterManagerServer extends Plugin {
  public nodeRegistry: RedisNodeRegistry;
  public orchestrator: IOrchestratorAdapter | null = null;
  public leaderElection: LeaderElection | null = null;
  public workerIdAllocator: RedisWorkerIdAllocator | null = null;

  async afterAdd() {
    // NocoBase asks workerIdAllocator for the Snowflake worker ID immediately
    // after the application-level beforeLoad event. Registering here guarantees
    // the Redis adapter exists before that allocation happens on every node.
    const workerRedisUrl = process.env.WORKER_ID_REDIS_URL || process.env.REDIS_URL;
    const allocatorState = this.app.workerIdAllocator as unknown as { adapter?: unknown };
    if (allocatorState.adapter) {
      this.app.logger.info('[ClusterManager] Worker ID allocator already registered; keeping the existing adapter.');
    } else if (workerRedisUrl) {
      this.workerIdAllocator = new RedisWorkerIdAllocator(workerRedisUrl, this.app.name, this.app.logger);
      this.app.workerIdAllocator.setAdapter(this.workerIdAllocator);
    } else {
      this.app.logger.warn(
        '[ClusterManager] WORKER_ID_REDIS_URL/REDIS_URL is missing; HA worker ID allocation is unavailable.',
      );
    }
  }

  async beforeLoad() {
    await this.db.import({ directory: path.resolve(__dirname, 'collections') });
  }

  async load() {
    // Fix NocoBase core strategy resource permission check crash:
    // Attachments collection has "createdBy: true" options but lacks explicit 'createdById' metadata field registration.
    // When non-root roles upload attachments, core ACL merges 'own' filters (createdById) and calls checkFilterParams,
    // which throws a NoPermissionError because getField('createdById') returns undefined.
    // Registering 'createdById' explicitly as a metadata field on the attachments collection prevents this check from crashing.
    this.db.extendCollection({
      name: 'attachments',
      fields: [
        {
          type: 'bigInt',
          name: 'createdById',
        },
      ],
    });

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

    // Register Redis PubSub adapter if URL is configured and no adapter already set
    this.registerPubSubAdapter();
    await this.registerEventQueueAdapter();

    // Register missing Redis Lock adapter if running bare open-source core
    const lockMgr = this.app.lockManager as any;
    if (lockMgr && lockMgr.registry && !lockMgr.registry.get('redis') && !lockMgr.adapters.get('redis')) {
      lockMgr.registerAdapter('redis', {
        Adapter: RedisLockAdapter,
        options: {
          app: this.app,
          url: process.env.LOCK_ADAPTER_REDIS_URL || process.env.REDIS_URL,
        },
      });
      this.app.logger.info('[ClusterManager] Polyfilled RedisLockAdapter as an active distributed lock provider');
    }

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
    this.app.acl.allow('clusterManagerHealth', ['liveness', 'readiness'], 'public');

    // Package manager (installs apt/npm/python packages across nodes)
    this.app.resourcer.define({
      name: 'workerPackages',
      actions: packageManagerActions,
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
        'workerPackages:*',
        'clusterManagerPlugins:*',
        'workerQueueMappings:*',
      ],
    });

    // ── Container Orchestrator ──
    await this.initOrchestrator();
  }

  private registerPubSubAdapter() {
    const url = process.env.PUBSUB_ADAPTER_REDIS_URL;
    if (!url) {
      this.app.logger.info('[cluster-manager] PUBSUB_ADAPTER_REDIS_URL not set, skipping Redis PubSub adapter');
      return;
    }

    // Don't override if another plugin already set an adapter
    const existingAdapter = (this.app.pubSubManager as any).adapter;
    if (existingAdapter) {
      this.app.logger.info('[cluster-manager] PubSub adapter already registered, skipping');
      return;
    }

    const adapter = new RedisPubSubAdapter(url, this.app.logger);
    this.app.pubSubManager.setAdapter(adapter);
    this.app.logger.info('[cluster-manager] Redis PubSub adapter registered');
  }

  private async registerEventQueueAdapter() {
    const enabled = process.env.QUEUE_ADAPTER === 'redis' || Boolean(process.env.QUEUE_ADAPTER_REDIS_URL);
    if (!enabled) {
      return;
    }

    const url = process.env.QUEUE_ADAPTER_REDIS_URL || process.env.REDIS_URL;
    if (!url) {
      this.app.logger.warn('[cluster-manager] QUEUE_ADAPTER=redis but QUEUE_ADAPTER_REDIS_URL/REDIS_URL is not set');
      return;
    }

    const eventQueue = this.app.eventQueue as any;
    const existingAdapter = eventQueue?.adapter;
    const existingName = existingAdapter?.constructor?.name;
    if (existingAdapter && existingName !== 'MemoryEventQueueAdapter') {
      this.app.logger.info(`[cluster-manager] EventQueue adapter already registered (${existingName}), skipping`);
      return;
    }

    const adapter = new RedisEventQueueAdapter({ app: this.app, url });
    const wasConnected = Boolean(eventQueue?.isConnected?.());
    if (wasConnected) {
      await eventQueue.close();
    }
    eventQueue.setAdapter(adapter);
    if (wasConnected) {
      await eventQueue.connect();
    }
    this.app.logger.info('[cluster-manager] Redis EventQueue adapter registered');
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
