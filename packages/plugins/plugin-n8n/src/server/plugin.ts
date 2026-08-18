import { Plugin } from '@nocobase/server';
import { resolve } from 'path';
import { N8nApiClient } from './services/N8nApiClient';
import { N8nCollector } from './services/N8nCollector';
import { createWorkflowActions } from './actions/workflows';
import { createExecutionActions } from './actions/executions';
import { createVariableActions } from './actions/variables';
import { createCredentialActions } from './actions/credentials';
import { createMonitoringActions } from './actions/monitoring';
import { createProjectActions } from './actions/projects';
import { createTagActions } from './actions/tags';
import { createN8nTools } from './tools/n8n-tools';

export class PluginN8nServer extends Plugin {
  collector: N8nCollector;

  async getApiClient(instanceId?: number | string): Promise<N8nApiClient> {
    const repo = this.db.getRepository('n8nInstances');
    let instance;

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
      throw new Error('No n8n instance configured. Please add an n8n instance first.');
    }

    // Prefer internalUrl for server-to-server calls, fall back to baseUrl
    const internalUrl = instance.get('internalUrl') as string;
    const baseUrl = instance.get('baseUrl') as string;
    const effectiveUrl = internalUrl || baseUrl;
    const apiKey = instance.get('apiKey') as string;

    if (!effectiveUrl || !apiKey) {
      throw new Error('n8n instance is missing baseUrl or apiKey.');
    }

    return new N8nApiClient(effectiveUrl, apiKey);
  }

  async getDefaultInstanceId(): Promise<number | null> {
    const repo = this.db.getRepository('n8nInstances');
    const instance = await repo.findOne({ filter: { isDefault: true, enabled: true } });
    return instance ? Number(instance.get('id')) : null;
  }

  async load() {
    await this.db.import({
      directory: resolve(__dirname, 'collections'),
    });

    this.collector = new N8nCollector(this);

    // Register proxy resources — pass plugin ref via closure
    this.app.resourceManager.define({ name: 'n8nWorkflows', actions: createWorkflowActions(this) });
    this.app.resourceManager.define({ name: 'n8nExecutions', actions: createExecutionActions(this) });
    this.app.resourceManager.define({ name: 'n8nVariables', actions: createVariableActions(this) });
    this.app.resourceManager.define({ name: 'n8nCredentials', actions: createCredentialActions(this) });
    this.app.resourceManager.define({ name: 'n8nMonitoring', actions: createMonitoringActions(this) });
    this.app.resourceManager.define({ name: 'n8nProjects', actions: createProjectActions(this) });
    this.app.resourceManager.define({ name: 'n8nTags', actions: createTagActions(this) });

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
        'n8nProjects:*',
        'n8nTags:*',
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
            if (item.get && typeof item.get === 'function') {
              // Sequelize model - override toJSON
              const orig = item.toJSON ? item.toJSON() : item;
              delete orig.apiKey;
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

    // Register AI tools (graceful)
    this.registerAITools();

    // Start the background collector after app started
    this.app.on('afterStart', () => {
      this.collector.start();
    });

    this.app.on('beforeStop', () => {
      this.collector.stop();
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

  async install() {}
}

export default PluginN8nServer;
