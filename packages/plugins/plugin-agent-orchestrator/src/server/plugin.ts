import { Plugin } from '@nocobase/server';
import path from 'path';
import { createExternalRagSearchTool } from './tools/external-rag-search';
import { registerTracingResource } from './resources/tracing';
import { registerAgentMonitorResource } from './resources/agent-monitor';
import SkillHubSubFeature from './skill-hub/plugin';
import { NativeSubAgentObserver } from './services/NativeSubAgentObserver';
import { asObject, isAdminUser, currentUserId } from './utils/ctx-utils';
import { getAIToolsManager } from './utils/ai-manager';

function normalizeOptionalString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function readModelValue(record: unknown, key: string) {
  const model = record as { get?: (name: string) => unknown; [key: string]: unknown };
  return typeof model?.get === 'function' ? model.get(key) : model?.[key];
}

function buildAgentMemoryContextKey(values: { scope: string; userId?: unknown; aiEmployeeUsername?: string }) {
  const userPart = values.scope === 'public' ? 'public' : String(values.userId || '');
  const agentPart = values.aiEmployeeUsername || '*';
  return `${values.scope}:${userPart}:${agentPart}`;
}

async function validateAgentMemoryContextValues(ctx: any) {
  const actionName = ctx.action?.actionName;
  const values = ctx.action?.params?.values || {};
  let nextValues = values;
  let currentId = ctx.action?.params?.filterByTk;

  if (actionName === 'update' && ctx.action?.params?.filterByTk) {
    const existing = await ctx.db.getRepository('agentMemoryContexts').findOne({
      filter: { id: ctx.action.params.filterByTk },
    });
    currentId = readModelValue(existing, 'id') || currentId;
    nextValues = {
      ...(existing?.toJSON?.() || existing || {}),
      ...values,
    };
  }

  const scope = normalizeOptionalString(nextValues.scope);
  const userId = nextValues.userId;
  const aiEmployeeUsername = normalizeOptionalString(nextValues.aiEmployeeUsername);

  if (!['public', 'user', 'agent_user'].includes(scope)) {
    ctx.throw(400, 'scope must be one of: public, user, agent_user.');
    return;
  }

  if (scope === 'public' && userId != null && userId !== '') {
    ctx.throw(400, 'scope="public" requires userId to be empty.');
    return;
  }

  if ((scope === 'user' || scope === 'agent_user') && (userId == null || userId === '')) {
    ctx.throw(400, `scope="${scope}" requires userId.`);
    return;
  }

  if (scope === 'agent_user' && !aiEmployeeUsername) {
    ctx.throw(400, 'scope="agent_user" requires aiEmployeeUsername.');
    return;
  }

  const normalizedValues = {
    ...values,
    scope,
    userId: scope === 'public' ? null : userId,
    aiEmployeeUsername,
    contextKey: buildAgentMemoryContextKey({
      scope,
      userId: scope === 'public' ? null : userId,
      aiEmployeeUsername,
    }),
  };

  const repo = ctx.db.getRepository('agentMemoryContexts');
  const duplicate =
    (await repo.findOne({
      filter: { contextKey: normalizedValues.contextKey },
    })) ||
    (await repo.findOne({
      filter: {
        scope,
        userId: normalizedValues.userId,
        aiEmployeeUsername,
      },
    }));
  const duplicateId = readModelValue(duplicate, 'id');
  if (duplicateId && String(duplicateId) !== String(currentId || '')) {
    ctx.throw(400, 'An agent memory context already exists for this scope, user, and AI employee.');
    return;
  }

  ctx.action.params.values = normalizedValues;
}

async function resolveTracingRetentionDays(plugin: { db: any; app: any }) {
  const envDays = Number(process.env.ORCHESTRATOR_LOG_RETENTION_DAYS);
  if (Number.isFinite(envDays) && envDays > 0) return envDays;

  try {
    const defaultProfile = await plugin.db.getRepository('agentHarnessProfiles').findOne({
      filter: {
        tag: 'default',
        enabled: true,
      },
    });
    const settings = asObject(readModelValue(defaultProfile, 'settings'));
    const profileDays = Number(settings.tracingRetentionDays);
    if (Number.isFinite(profileDays) && profileDays > 0) {
      return profileDays;
    }
  } catch (error) {
    plugin.app.logger?.warn?.('[AgentOrchestrator] Failed to load tracing retention policy', error);
  }

  return 30;
}

export class PluginAgentOrchestratorServer extends Plugin {
  skillHub: SkillHubSubFeature;
  nativeObserver: NativeSubAgentObserver;
  private readonly installNativeObserver = () => {
    this.nativeObserver?.install();
  };

  async afterAdd() {
    this.skillHub = new SkillHubSubFeature(this);
    this.nativeObserver = new NativeSubAgentObserver(this);
  }

  async beforeLoad() {
    // Import collection definitions
    this.db.import({ directory: path.resolve(__dirname, 'collections') });

    this.db.addMigrations({
      namespace: this.name,
      directory: path.resolve(__dirname, 'migrations'),
      context: { plugin: this },
    });
  }

  async load() {
    await this.skillHub.load();

    // --- ACL ---
    this.app.acl.registerSnippet({
      name: `pm.${this.name}`,
      actions: [
        'orchestratorConfig:*',
        'orchestratorTracing:*',
        'agentMonitor:*',
        'agentMemoryContexts:*',
        'agentLoopRuns:*',
        'agentLoopSteps:*',
        'agentLoopEvents:*',
        'agentHarnessProfiles:*',
        'agentExecutionSpans:*',
        'skillDefinitions:*',
        'skillExecutions:*',
        'skillLoopConfigs:*',
        'skillHub:*',
        'skillWorkerConfigs:*',
      ],
    });

    // Allow any logged-in user to read available skills and loop configs.
    // This mirrors the plugin-ai pattern (acl.allow with 'loggedIn')
    // so that non-admin users with AI roles can use skills without
    // requiring manual snippet assignment per role.
    // Create/update/destroy remain restricted to admin roles via the snippet above.
    this.app.acl.allow('skillDefinitions', 'list', 'loggedIn');
    this.app.acl.allow('skillDefinitions', 'get', 'loggedIn');
    this.app.acl.allow('skillLoopConfigs', 'list', 'loggedIn');
    this.app.acl.allow('skillLoopConfigs', 'get', 'loggedIn');
    this.app.acl.allow('skillExecutions', 'list', 'loggedIn');
    this.app.acl.allow('skillExecutions', 'get', 'loggedIn');
    this.app.acl.allow('skillHub', 'test', 'loggedIn');
    this.app.acl.allow('skillHub', 'download', 'loggedIn');
    this.app.acl.allow('skillHub', 'listTemplates', 'loggedIn');
    this.app.acl.allow('agentMonitor', ['list', 'get'], 'loggedIn');

    // Data scoping for skillExecutions: a logged-in non-admin user may only
    // read their own executions. Rows hold inputArgs / stdout / output files,
    // so an unscoped list/get would leak one user's data to another. Admins
    // (root/admin roles) keep full visibility. This mirrors the owner/admin
    // check enforced by skillHub:download.
    this.app.resourceManager.use(
      async (ctx, next) => {
        const { resourceName, actionName } = ctx.action || {};
        if (resourceName === 'skillExecutions' && (actionName === 'list' || actionName === 'get')) {
          if (!isAdminUser(ctx)) {
            const userId = currentUserId(ctx);
            const ownerFilter = userId ? { triggeredById: userId } : { triggeredById: null };
            ctx.action.mergeParams({ filter: ownerFilter });
          }
        }
        await next();
      },
      { tag: 'orchestrator-skill-executions-scope', after: 'acl' },
    );

    this.app.resourceManager.use(
      async (ctx, next) => {
        const { resourceName, actionName } = ctx.action || {};
        if (resourceName === 'agentMemoryContexts' && (actionName === 'create' || actionName === 'update')) {
          await validateAgentMemoryContextValues(ctx);
        }
        await next();
      },
      { tag: 'orchestrator-agent-memory-context-policy', after: 'acl' },
    );

    // --- Register External Tool Only ---
    // Native @nocobase/plugin-ai owns sub-agent dispatch. The orchestrator no
    // longer registers delegate_* / dispatch_subagents_* tools or controller
    // plan tools; Skill Hub still registers its own AI tools from its subfeature.
    const toolsManager = getAIToolsManager(this.app);
    toolsManager.registerTools(createExternalRagSearchTool(this));

    // --- Native plugin-ai Monitor Resource ---
    registerAgentMonitorResource(this);
    this.installNativeObserver();
    this.app.on?.('afterStart', this.installNativeObserver);

    // --- Register Tracing Resource (Phase 5) ---
    // Custom read-only resource for the Swarm Tracing admin page.
    registerTracingResource(this);

    // --- Log Retention ---
    // Daily prune of orchestratorLogs / agentExecutionSpans to keep tables bounded.
    // Override window via env: ORCHESTRATOR_LOG_RETENTION_DAYS (default 30).
    this.app.cronJobManager.addJob({
      cronTime: '0 30 2 * * *',
      onTick: async () => {
        try {
          const days = await resolveTracingRetentionDays(this);
          const cutoff = new Date(Date.now() - days * 86400000);
          const repo = this.db.getRepository('orchestratorLogs');
          const spansRepo = this.db.getRepository('agentExecutionSpans');
          const deletedLogs = repo
            ? await repo.destroy({
                filter: { createdAt: { $lt: cutoff.toISOString() } },
              })
            : 0;
          const deletedSpans = spansRepo
            ? await spansRepo.destroy({
                filter: { createdAt: { $lt: cutoff.toISOString() } },
              })
            : 0;
          this.app.log.info(
            `[AgentOrchestrator] Pruned ${deletedLogs} orchestratorLogs and ${deletedSpans} agentExecutionSpans rows older than ${days} day(s).`,
          );
        } catch (e) {
          this.app.log.error('[AgentOrchestrator] Log retention job failed', e);
        }
      },
    });

    // Native sub-agent conversations are owned by @nocobase/plugin-ai. This
    // plugin only observes their execution spans and policy context.
  }

  async install() {
    await this.skillHub.install();
  }

  async afterEnable() {}
  async afterDisable() {
    this.nativeObserver?.uninstall();
  }
  async remove() {}

  async beforeStop() {
    this.app.off?.('afterStart', this.installNativeObserver);
    this.app.removeListener?.('afterStart', this.installNativeObserver);
    this.nativeObserver?.uninstall();
    await this.skillHub.beforeStop();
  }
}

export default PluginAgentOrchestratorServer;
