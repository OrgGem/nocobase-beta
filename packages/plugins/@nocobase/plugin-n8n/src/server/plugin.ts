import { Plugin } from '@nocobase/server';
import { resolve } from 'path';
import { N8nApiClient } from './services/N8nApiClient';
import { workflows } from './actions/workflows';
import { executions } from './actions/executions';
import { variables } from './actions/variables';
import { credentials } from './actions/credentials';
import { monitoring } from './actions/monitoring';
import { createN8nTools } from './tools/n8n-tools';

export interface MetricsSnapshot {
  timestamp: number;
  cpu: number;
  memoryRss: number;
  heapUsed: number;
  heapTotal: number;
  eventLoopLag: number;
  eventLoopP99: number;
  activeHandles: number;
  activeRequests: number;
  queueWaiting: number;
  queueActive: number;
  queueCompleted: number;
  queueFailed: number;
  activeWorkflows: number;
}

const MAX_METRICS_HISTORY = 180;

export class PluginN8nServer extends Plugin {
  metricsHistory = new Map<number, MetricsSnapshot[]>();
  private metricsTimer: ReturnType<typeof setInterval> | null = null;

  async getApiClient(instanceId?: number | string): Promise<N8nApiClient> {
    const repo = this.db.getRepository('n8nInstances');
    const instance = instanceId
      ? await repo.findOne({ filter: { id: Number(instanceId) } })
      : await repo.findOne({ filter: { isDefault: true, enabled: true } });

    if (!instance) {
      // Fallback to any enabled instance
      const any = await repo.findOne({ filter: { enabled: true } });
      if (!any) throw new Error('No n8n instance configured');
      return new N8nApiClient(any.get('baseUrl'), any.get('apiKey'));
    }
    return new N8nApiClient(instance.get('baseUrl'), instance.get('apiKey'));
  }

  async getDefaultInstanceId(): Promise<number | null> {
    const repo = this.db.getRepository('n8nInstances');
    const instance = await repo.findOne({ filter: { isDefault: true, enabled: true } });
    return instance ? Number(instance.get('id')) : null;
  }

  async load() {
    await this.importCollections(resolve(__dirname, 'collections'));

    // Register proxy resources
    this.app.resourceManager.define({ name: 'n8nWorkflows', actions: workflows });
    this.app.resourceManager.define({ name: 'n8nExecutions', actions: executions });
    this.app.resourceManager.define({ name: 'n8nVariables', actions: variables });
    this.app.resourceManager.define({ name: 'n8nCredentials', actions: credentials });
    this.app.resourceManager.define({ name: 'n8nMonitoring', actions: monitoring });

    // ACL
    this.app.acl.registerSnippet({
      name: `pm.${this.name}`,
      actions: [
        'n8nInstances:*',
        'n8nAlertRules:*',
        'n8nWorkflows:*',
        'n8nExecutions:*',
        'n8nVariables:*',
        'n8nCredentials:*',
        'n8nMonitoring:*',
      ],
    });

    // Strip apiKey from instance responses
    this.app.resourceManager.use(async (ctx, next) => {
      await next();
      if (ctx.action?.resourceName === 'n8nInstances' && ctx.body) {
        const strip = (item: any) => {
          if (item && typeof item === 'object') {
            delete item.apiKey;
            if (item.dataValues) delete item.dataValues.apiKey;
          }
        };
        if (Array.isArray(ctx.body)) {
          ctx.body.forEach(strip);
        } else if (ctx.body?.data && Array.isArray(ctx.body.data)) {
          ctx.body.data.forEach(strip);
        } else {
          strip(ctx.body);
        }
      }
    });

    // Register AI tools (graceful)
    this.registerAITools();

    // Start metrics cron after app started
    this.app.on('afterStart', () => {
      this.startMetricsCron();
    });

    this.app.on('beforeStop', () => {
      if (this.metricsTimer) {
        clearInterval(this.metricsTimer);
        this.metricsTimer = null;
      }
    });
  }

  private registerAITools() {
    try {
      const aiManager = (this.app as any).aiManager;
      if (!aiManager?.toolsManager) {
        this.app.logger.info('[plugin-n8n] plugin-ai not available, skipping AI tool registration.');
        return;
      }
      const tools = createN8nTools((instanceId) => this.getApiClient(instanceId));
      aiManager.toolsManager.registerTools(tools);
      this.app.logger.info('[plugin-n8n] AI tools registered successfully.');
    } catch (error) {
      this.app.logger.warn('[plugin-n8n] Failed to register AI tools:', error);
    }
  }

  private startMetricsCron() {
    this.metricsTimer = setInterval(async () => {
      try {
        const repo = this.db.getRepository('n8nInstances');
        const instances = await repo.find({ filter: { enabled: true, metricsEnabled: true } });

        for (const instance of instances) {
          const id = Number(instance.get('id'));
          const baseUrl = instance.get('internalUrl') || instance.get('baseUrl');
          const apiKey = instance.get('apiKey');
          const client = new N8nApiClient(baseUrl as string, apiKey as string);

          try {
            const snapshot = await client.getMetricsSnapshot();
            if (!this.metricsHistory.has(id)) {
              this.metricsHistory.set(id, []);
            }
            const history = this.metricsHistory.get(id)!;
            history.push(snapshot);
            if (history.length > MAX_METRICS_HISTORY) {
              history.splice(0, history.length - MAX_METRICS_HISTORY);
            }

            // Evaluate alerts
            await this.evaluateAlerts(id, snapshot);
          } catch (err) {
            this.app.logger.debug(`[plugin-n8n] Metrics fetch failed for instance ${id}: ${err}`);
          }
        }
      } catch (err) {
        this.app.logger.debug(`[plugin-n8n] Metrics cron error: ${err}`);
      }
    }, 20000);
  }

  private async evaluateAlerts(instanceId: number, snapshot: MetricsSnapshot) {
    const repo = this.db.getRepository('n8nAlertRules');
    const rules = await repo.find({ filter: { instanceId, enabled: true } });

    for (const rule of rules) {
      const metric = rule.get('metric') as string;
      const operator = rule.get('operator') as string;
      const threshold = rule.get('threshold') as number;
      const windowMinutes = rule.get('windowMinutes') as number;
      const lastTriggered = rule.get('lastTriggeredAt') as Date | null;

      // Cooldown check
      if (lastTriggered) {
        const elapsed = (Date.now() - new Date(lastTriggered).getTime()) / 60000;
        if (elapsed < windowMinutes) continue;
      }

      // Get metric value from snapshot
      const value = (snapshot as any)[metric];
      if (value === undefined) continue;

      // Evaluate
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

      // Fire alert
      const alertMsg = `[n8n Alert] ${rule.get('name')}: ${metric} ${operator} ${threshold} (current: ${value})`;
      const channel = rule.get('notifyChannel') as string;

      if (channel === 'webhook') {
        const webhookUrl = rule.get('webhookUrl') as string;
        if (webhookUrl) {
          fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alert: rule.get('name'), metric, value, threshold, operator, instanceId }),
          }).catch(() => {});
        }
      } else {
        this.app.logger.warn(alertMsg);
      }

      // Update lastTriggeredAt
      await repo.update({ filter: { id: rule.get('id') }, values: { lastTriggeredAt: new Date() } });
    }
  }

  async install() {
    // No seed data needed
  }
}

export default PluginN8nServer;
