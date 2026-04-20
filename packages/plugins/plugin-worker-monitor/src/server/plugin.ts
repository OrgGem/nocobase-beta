import { Plugin } from '@nocobase/server';
import * as os from 'os';
import { tasksActions } from './actions/tasks';
import { workflowActions } from './actions/workflow-executions';
import { redisActions } from './actions/redis-monitor';
import { aclCacheActions, createAclCacheMiddleware } from './actions/acl-cache';
import { clusterActions } from './actions/cluster-nodes';
import { eventQueueActions } from './actions/event-queue-monitor';
import { lockActions } from './actions/lock-monitor';
import { cacheMonitorActions } from './actions/cache-monitor';
import { RedisPubSubAdapter } from './adapters/redis-pubsub-adapter';
import { RedisNodeRegistry } from './adapters/redis-node-registry';
import { RedisLockAdapter } from './adapters/redis-lock-adapter';

export class PluginWorkerMonitorServer extends Plugin {
  private nodeRegistry: RedisNodeRegistry;
  async load() {
    this.nodeRegistry = new RedisNodeRegistry(this.app);

    (this.app as any).on('afterStart', () => {
      this.nodeRegistry?.start();
    });

    (this.app as any).on('beforeStop', () => {
      this.nodeRegistry?.stop();
    });

    // Workflow hook to trace executing node
    this.app.db.on('executions.afterSave', async (model: any) => {
      const mode = process.env.WORKER_MODE || 'main';
      const isWorker = mode === 'worker' || mode === 'task' || mode === '*';
      if (isWorker) {
        const id = model.get('id');
        const redis = (this.app as any).redisConnectionManager?.getConnection();
        if (id && redis) {
          const appName = process.env.APP_NAME || (this.app as any).name || 'main';
          const nodeName = appName === os.hostname() ? appName : `${appName} (${os.hostname()})`;
          redis.sendCommand(['SET', `worker-monitor:exec-node:${id}`, nodeName, 'EX', '86400']).catch(() => {});
        }
      }
    });

    // Register Redis PubSub adapter if URL is configured and no adapter already set
    this.registerPubSubAdapter();

    // Register missing Redis Lock adapter if running bare open-source core
    const lockMgr = this.app.lockManager as any;
    if (lockMgr && lockMgr.registry && !lockMgr.registry.get('redis') && !lockMgr.adapters.get('redis')) {
      lockMgr.registerAdapter('redis', {
        Adapter: RedisLockAdapter,
        options: { app: this.app }
      });
      this.app.logger.info('[WorkerMonitor] Polyfilled RedisLockAdapter as an active distributed lock provider');
    }

    // Listen to remote restart commands
    const pubSub = (this.app as any).pubSubManager;
    if (pubSub) {
      pubSub.subscribe('worker-monitor:restart', (msg: string) => {
        try {
          let target = msg;
          let mode = 'hard';
          
          if (msg.startsWith('{')) {
            const parsed = JSON.parse(msg);
            target = parsed.hostname;
            mode = parsed.mode || 'hard';
          }

          if (target === os.hostname() || target === '*') {
            this.app.logger.warn(`[WorkerMonitor] Received ${mode} restart command for node ${os.hostname()}...`);
            setTimeout(async () => {
              try {
                if (mode === 'soft') {
                  this.app.logger.warn(`[WorkerMonitor] Triggering NocoBase Soft Restart...`);
                  await this.app.restart();
                } else {
                  this.app.logger.warn(`[WorkerMonitor] Shutting down Node.js process for Hard Restart...`);
                  await this.app.stop();
                  process.exit(1);
                }
              } catch (e: any) {}
            }, 1000); // 1-second delay so HTTP API can gracefully respond first
          }
        } catch (err) {
          this.app.logger.error(`[WorkerMonitor] Parse error for restart message: ${msg}`);
        }
      });
    }

    // Task management (reads asyncTasks table)
    this.app.resourcer.define({
      name: 'workerMonitor',
      actions: tasksActions,
    });

    // Workflow execution management (reads executions + jobs tables)
    this.app.resourcer.define({
      name: 'workerMonitorWorkflow',
      actions: workflowActions,
    });

    // Redis live metrics
    this.app.resourcer.define({
      name: 'workerMonitorRedis',
      actions: redisActions,
    });

    // ACL cache management
    this.app.resourcer.define({
      name: 'workerMonitorAclCache',
      actions: aclCacheActions,
    });

    // Cluster nodes & health
    this.app.resourcer.define({
      name: 'workerMonitorCluster',
      actions: clusterActions,
    });

    // Event queue monitoring
    this.app.resourcer.define({
      name: 'workerMonitorQueue',
      actions: eventQueueActions,
    });

    // Distributed lock monitoring
    this.app.resourcer.define({
      name: 'workerMonitorLock',
      actions: lockActions,
    });

    // Cache manager monitoring
    this.app.resourcer.define({
      name: 'workerMonitorCacheMgr',
      actions: cacheMonitorActions,
    });

    // Install ACL cache middleware (caches acl.can() results in Redis)
    const aclCacheMiddleware = createAclCacheMiddleware(this.app);
    (this.app as any).resourcer.use(aclCacheMiddleware, {
      tag: 'aclCache',
      before: 'acl',
      after: 'setCurrentRole',
    });

    // Lightweight healthcheck endpoint avoiding workflow pre-action and resourcer spam
    this.app.use(async (ctx: any, next: any) => {
      if (ctx.path === '/api/workerMonitor:health' && (ctx.method === 'GET' || ctx.method === 'HEAD')) {
        ctx.body = {
          status: 'ok',
          version: process.env.NOCOBASE_VERSION || process.version,
          mode: process.env.WORKER_MODE || 'main',
        };
        return;
      }
      await next();
    });

    // Admin-only access
    this.app.acl.registerSnippet({
      name: `pm.${this.name}`,
      actions: [
        'workerMonitor:*',
        'workerMonitorWorkflow:*',
        'workerMonitorRedis:*',
        'workerMonitorAclCache:*',
        'workerMonitorCluster:*',
        'workerMonitorQueue:*',
        'workerMonitorLock:*',
        'workerMonitorCacheMgr:*',
      ],
    });
  }

  private registerPubSubAdapter() {
    const url = process.env.PUBSUB_ADAPTER_REDIS_URL;
    if (!url) {
      this.app.logger.info('[worker-monitor] PUBSUB_ADAPTER_REDIS_URL not set, skipping Redis PubSub adapter');
      return;
    }

    // Don't override if another plugin already set an adapter
    const existingAdapter = (this.app.pubSubManager as any).adapter;
    if (existingAdapter) {
      this.app.logger.info('[worker-monitor] PubSub adapter already registered, skipping');
      return;
    }

    const adapter = new RedisPubSubAdapter(url, this.app.logger);
    this.app.pubSubManager.setAdapter(adapter);
    this.app.logger.info('[worker-monitor] Redis PubSub adapter registered');
  }
}

export default PluginWorkerMonitorServer;
