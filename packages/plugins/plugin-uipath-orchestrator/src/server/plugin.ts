/**
 * UiPath Orchestrator Plugin — Server
 *
 * Architecture follows plugin-n8n pattern:
 * - Collections for persistent data (instances, folders cache, alert rules, webhook events, audit logs)
 * - Resource actions as proxy to UiPath Orchestrator API
 * - Background polling for dashboard metrics (with distributed cache lock)
 * - Webhook receiver for realtime events
 * - AI tools integration (optional)
 * - ACL snippet for permission control
 * - Secret masking middleware
 */

import { Plugin } from '@nocobase/server';
import { resolve } from 'path';
import { UiPathApiClient } from './services/UiPathApiClient';
import type { UiPathInstanceConfig, FolderContext, DashboardSnapshot } from './services/types';

import { createInstanceActions } from './actions/instances';
import { createFolderActions } from './actions/folders';
import { createJobActions } from './actions/jobs';
import { createRobotLogActions } from './actions/robotLogs';
import { createQueueActions } from './actions/queues';
import { createProcessActions } from './actions/processes';
import { createAssetActions } from './actions/assets';
import { createStatsActions } from './actions/stats';
import {
  createUsersActions,
  createRobotActions,
  createMachineActions,
  createSessionActions,
} from './actions/usersRobots';
import { createCustomApiActions } from './actions/customApi';
import { createWebhookActions } from './actions/webhooks';
import { createUiPathTools } from './tools/uipath-tools';
import { UiPathWebhookVerifier } from './services/UiPathWebhookVerifier';

// ─── Cache for dashboard snapshots ─────────────────────────────────
const MAX_SNAPSHOT_HISTORY = 60; // ~30 min at 30s interval

export class PluginUiPathOrchestratorServer extends Plugin {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private clientCache = new Map<number, UiPathApiClient>();

  // ─── API Client Factory ────────────────────────────────────────────

  async getApiClient(instanceId?: number | string): Promise<UiPathApiClient> {
    const repo = this.db.getRepository('uipathInstances');
    let instance: any;

    if (instanceId) {
      instance = await repo.findOne({ filter: { id: Number(instanceId) } });
    }
    if (!instance) {
      instance = await repo.findOne({ filter: { isDefault: true, enabled: true } });
    }
    if (!instance) {
      instance = await repo.findOne({ filter: { enabled: true } });
    }
    if (!instance) {
      throw new Error('No UiPath instance configured. Please add an instance first.');
    }

    const id = Number(instance.get('id'));

    // Check client cache
    const cachedClient = this.clientCache.get(id);
    if (cachedClient) {
      return cachedClient;
    }

    const config: UiPathInstanceConfig = {
      id,
      name: instance.get('name') as string,
      deploymentType: (instance.get('deploymentType') as 'cloud' | 'onPrem') || 'cloud',
      baseUrl: instance.get('baseUrl') as string,
      accountLogicalName: instance.get('accountLogicalName') as string,
      tenantLogicalName: instance.get('tenantLogicalName') as string,
      tenantName: instance.get('tenantName') as string,
      apiBaseUrl: instance.get('apiBaseUrl') as string,
      tokenUrl: instance.get('tokenUrl') as string,
      clientId: instance.get('clientId') as string,
      clientSecret: instance.get('clientSecret') as string,
      scopes: (instance.get('scopes') as string) || 'OR.Default',
      defaultFolderId: instance.get('defaultFolderId') as number,
      defaultFolderKey: instance.get('defaultFolderKey') as string,
      defaultFolderPath: instance.get('defaultFolderPath') as string,
      ignoreSsl: instance.get('ignoreSsl') as boolean,
    };

    const client = new UiPathApiClient(config);
    this.clientCache.set(id, client);
    return client;
  }

  /** Invalidate client cache for an instance (e.g., after credential update). */
  invalidateClientCache(instanceId: number) {
    this.clientCache.delete(instanceId);
  }

  async getDefaultInstanceId(): Promise<number | null> {
    const repo = this.db.getRepository('uipathInstances');
    const inst = await repo.findOne({ filter: { isDefault: true, enabled: true } });
    return inst ? Number(inst.get('id')) : null;
  }

  // ─── Audit Logging ─────────────────────────────────────────────────

  async auditLog(
    ctx: any,
    entry: {
      action: string;
      resourceType: string;
      resourceId: string;
      instanceId: number;
      folder?: FolderContext;
      details?: any;
      status?: string;
      errorMessage?: string;
    },
  ) {
    try {
      const user = ctx.state?.currentUser;
      await this.db.getRepository('uipathAuditLogs').create({
        values: {
          instanceId: entry.instanceId,
          userId: user?.id,
          userName: user?.nickname || user?.username || 'system',
          action: entry.action,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId,
          folderId: entry.folder?.folderId,
          folderName: entry.folder?.folderPath,
          details: entry.details,
          status: entry.status || 'success',
          errorMessage: entry.errorMessage,
        },
      });
    } catch (err) {
      this.app.logger.debug(`[plugin-uipath] Audit log error: ${err}`);
    }
  }

  // ─── Webhook Event Handler ─────────────────────────────────────────

  onWebhookEvent(instanceId: number, eventType: string, _payload: any) {
    // Invalidate relevant cache on webhook event
    const cacheKey = `uipath-dashboard:${instanceId}`;
    this.app.cache.del(cacheKey).catch(() => {});
    this.app.logger.info(`[plugin-uipath] Webhook event: ${eventType} for instance ${instanceId}`);
  }

  // ─── Plugin Lifecycle ──────────────────────────────────────────────

  async load() {
    // Import collections
    await this.db.import({
      directory: resolve(__dirname, 'collections'),
    });

    // Register resource actions
    this.app.resourceManager.define({ name: 'uipathInstanceActions', actions: createInstanceActions(this) });
    this.app.resourceManager.define({ name: 'uipathFolders', actions: createFolderActions(this) });
    this.app.resourceManager.define({ name: 'uipathJobs', actions: createJobActions(this) });
    this.app.resourceManager.define({ name: 'uipathRobotLogs', actions: createRobotLogActions(this) });
    this.app.resourceManager.define({ name: 'uipathQueues', actions: createQueueActions(this) });
    this.app.resourceManager.define({ name: 'uipathProcesses', actions: createProcessActions(this) });
    this.app.resourceManager.define({ name: 'uipathAssets', actions: createAssetActions(this) });
    this.app.resourceManager.define({ name: 'uipathStats', actions: createStatsActions(this) });
    this.app.resourceManager.define({ name: 'uipathUsers', actions: createUsersActions(this) });
    this.app.resourceManager.define({ name: 'uipathRobots', actions: createRobotActions(this) });
    this.app.resourceManager.define({ name: 'uipathMachines', actions: createMachineActions(this) });
    this.app.resourceManager.define({ name: 'uipathSessions', actions: createSessionActions(this) });
    this.app.resourceManager.define({ name: 'uipathCustomApi', actions: createCustomApiActions(this) });
    this.app.resourceManager.define({ name: 'uipathWebhooks', actions: createWebhookActions(this) });
    this.registerWebhookRawBodyMiddleware();

    // ACL
    this.app.acl.registerSnippet({
      name: `pm.${this.name}`,
      actions: [
        'uipathInstances:*',
        'uipathFoldersCache:*',
        'uipathAlertRules:*',
        'uipathWebhookEvents:list',
        'uipathAuditLogs:list',
        'uipathInstanceActions:*',
        'uipathFolders:*',
        'uipathJobs:*',
        'uipathRobotLogs:*',
        'uipathQueues:*',
        'uipathProcesses:*',
        'uipathAssets:*',
        'uipathStats:*',
        'uipathUsers:*',
        'uipathRobots:*',
        'uipathMachines:*',
        'uipathSessions:*',
        'uipathCustomApi:*',
        'uipathWebhooks:*',
      ],
    });
    this.app.acl.allow('uipathWebhooks', 'receive', 'public');

    // Strip secrets from instance responses. clientId is intentionally left visible
    // because it is required to edit an instance without replacing credentials.
    this.app.resourceManager.use(async (ctx, next) => {
      await next();
      if (ctx.action?.resourceName === 'uipathInstances' && ctx.body) {
        const sensitiveFields = ['clientSecret', 'webhookSecret', 'esPassword'];
        const strip = (item: any) => {
          if (item && typeof item === 'object') {
            for (const field of sensitiveFields) {
              if (item[field]) item[field] = '********';
              if (item.dataValues?.[field]) item.dataValues[field] = '********';
            }
          }
        };
        if (Array.isArray(ctx.body)) {
          ctx.body.forEach(strip);
        } else if (ctx.body?.data && Array.isArray(ctx.body.data)) {
          ctx.body.data.forEach(strip);
        } else if (ctx.body?.rows && Array.isArray(ctx.body.rows)) {
          ctx.body.rows.forEach(strip);
        } else {
          strip(ctx.body);
        }
      }
    });

    // Invalidate client cache when instance is updated
    this.db.on('uipathInstances.afterUpdate', async (model: any) => {
      this.invalidateClientCache(Number(model.get('id')));
    });

    // Register AI tools (graceful)
    this.registerAITools();

    // Start polling after app started
    this.app.on('afterStart', () => {
      this.startPollingCron();
    });

    this.app.on('beforeStop', () => {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
    });
  }

  // ─── AI Tools ──────────────────────────────────────────────────────

  private registerAITools() {
    try {
      const aiManager = (this.app as any).aiManager;
      if (!aiManager?.toolsManager) {
        this.app.logger.info('[plugin-uipath] plugin-ai not available, skipping AI tool registration.');
        return;
      }
      const tools = createUiPathTools((instanceId) => this.getApiClient(instanceId));
      aiManager.toolsManager.registerTools(tools);
      this.app.logger.info('[plugin-uipath] AI tools registered successfully.');
    } catch (error) {
      this.app.logger.warn('[plugin-uipath] Failed to register AI tools:', error);
    }
  }

  // ─── Background Polling ────────────────────────────────────────────

  private registerWebhookRawBodyMiddleware() {
    this.app.use(
      async (ctx: any, next: any) => {
        if (ctx.method !== 'POST' || !ctx.path.includes('uipathWebhooks:receive')) {
          return next();
        }

        try {
          const instanceId = ctx.query?.instanceId || ctx.request.query?.instanceId;
          if (!instanceId) {
            ctx.status = 400;
            ctx.body = { error: 'instanceId is required' };
            return;
          }

          const rawBody = await readRawBody(ctx);
          const payload = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {};
          const signature = ctx.get('X-UiPath-Signature') || ctx.get('x-uipath-signature');

          const instance = await this.db.getRepository('uipathInstances').findOne({
            filter: { id: Number(instanceId), enabled: true },
          });
          if (!instance) {
            ctx.status = 404;
            ctx.body = { error: 'Instance not found' };
            return;
          }

          const secret = instance.get('webhookSecret') as string;
          if (secret && !UiPathWebhookVerifier.verify(secret, signature || '', rawBody)) {
            ctx.status = 401;
            ctx.body = { error: 'Invalid signature' };
            return;
          }

          const eventType = UiPathWebhookVerifier.parseEventType(payload);
          await this.db.getRepository('uipathWebhookEvents').create({
            values: {
              instanceId: Number(instanceId),
              eventType,
              eventId: payload.EventId || null,
              tenantId: payload.TenantId || null,
              folderId: payload.FolderId || null,
              payload,
              status: 'pending',
            },
          });

          this.onWebhookEvent(Number(instanceId), eventType, payload);
          ctx.body = { received: true, eventType };
        } catch (error: any) {
          ctx.status = error?.statusCode || (error?.name === 'SyntaxError' ? 400 : 500);
          ctx.body = { error: error?.message || 'Webhook receive failed' };
        }
      },
      { tag: 'uipathWebhookRawBody', before: 'bodyParser' },
    );
  }

  private startPollingCron() {
    this.pollTimer = setInterval(async () => {
      try {
        // Distributed lock — only 1 container polls
        const lockKey = 'plugin-uipath:poll-lock';
        const isLocked = await this.app.cache.get(lockKey);
        if (isLocked) return;
        await this.app.cache.set(lockKey, 'locked', 25_000); // 25s TTL

        const repo = this.db.getRepository('uipathInstances');
        const instances = await repo.find({ filter: { enabled: true, pollEnabled: true } });

        for (const instance of instances) {
          const id = Number(instance.get('id'));
          try {
            const client = await this.getApiClient(id);

            // Fetch dashboard snapshot
            const [jobsStats, sessionsStats] = await Promise.all([
              client.get('/api/Stats/GetJobsStats').catch(() => null),
              client.get('/api/Stats/GetSessionsStats').catch(() => null),
            ]);

            const snapshot: Partial<DashboardSnapshot> = {
              timestamp: Date.now(),
              jobsStats,
              sessionsStats,
            };

            // Store in distributed cache
            const cacheKey = `uipath-dashboard:${id}`;
            const history = ((await this.app.cache.get(cacheKey)) as any[]) || [];
            history.push(snapshot);
            if (history.length > MAX_SNAPSHOT_HISTORY) {
              history.splice(0, history.length - MAX_SNAPSHOT_HISTORY);
            }
            await this.app.cache.set(cacheKey, history, 2 * 60 * 60 * 1000);

            // Evaluate alert rules
            await this.evaluateAlerts(id, snapshot);
          } catch (err) {
            this.app.logger.debug(`[plugin-uipath] Poll failed for instance ${id}: ${err}`);
          }
        }
      } catch (err) {
        this.app.logger.debug(`[plugin-uipath] Polling cron error: ${err}`);
      }
    }, 30_000); // 30s interval
  }

  private async evaluateAlerts(instanceId: number, snapshot: any) {
    const repo = this.db.getRepository('uipathAlertRules');
    const rules = await repo.find({ filter: { instanceId, enabled: true } });

    for (const rule of rules) {
      const metric = rule.get('metric') as string;
      const operator = rule.get('operator') as string;
      const threshold = rule.get('threshold') as number;
      const windowMinutes = rule.get('windowMinutes') as number;
      const lastTriggered = rule.get('lastTriggeredAt') as Date | null;

      if (lastTriggered) {
        const elapsed = (Date.now() - new Date(lastTriggered).getTime()) / 60000;
        if (elapsed < windowMinutes) continue;
      }

      // Resolve metric value from snapshot
      const value = this.resolveMetricValue(metric, snapshot);
      if (value === undefined || value === null) continue;

      let breached = false;
      switch (operator) {
        case '>':
          breached = value > threshold;
          break;
        case '<':
          breached = value < threshold;
          break;
        case '>=':
          breached = value >= threshold;
          break;
        case '<=':
          breached = value <= threshold;
          break;
        case '==':
          breached = value === threshold;
          break;
      }

      if (!breached) continue;

      const alertMsg = `[UiPath Alert] ${rule.get('name')}: ${metric} ${operator} ${threshold} (current: ${value})`;
      const channel = rule.get('notifyChannel') as string;

      if (channel === 'webhook') {
        const webhookUrl = rule.get('webhookUrl') as string;
        if (webhookUrl) {
          fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              alert: rule.get('name'),
              metric,
              value,
              threshold,
              operator,
              instanceId,
              severity: rule.get('severity'),
            }),
          }).catch((err) => {
            this.app.logger.warn(`[plugin-uipath] Alert webhook failed: ${err}`);
          });
        }
      } else {
        this.app.logger.warn(alertMsg);
      }

      await repo.update({ filter: { id: rule.get('id') }, values: { lastTriggeredAt: new Date() } });
    }
  }

  private resolveMetricValue(metric: string, snapshot: any): number | undefined {
    // Navigate nested paths like "jobsStats.Faulted" or "sessionsStats.Disconnected"
    const parts = metric.split('.');
    let val: any = snapshot;
    for (const p of parts) {
      if (val == null) return undefined;
      val = val[p];
    }
    return typeof val === 'number' ? val : undefined;
  }

  async install() {}
}

const MAX_WEBHOOK_BODY_BYTES = 10 * 1024 * 1024;

function readRawBody(ctx: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteCount = 0;

    ctx.req.on('data', (chunk: Buffer) => {
      byteCount += chunk.length;
      if (byteCount > MAX_WEBHOOK_BODY_BYTES) {
        ctx.req.destroy();
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    ctx.req.on('end', () => resolve(Buffer.concat(chunks)));
    ctx.req.on('error', reject);
  });
}

export default PluginUiPathOrchestratorServer;
