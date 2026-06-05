import { Plugin } from '@nocobase/server';
import path from 'path';
import { createDelegateToolsProvider } from './tools/delegate-task';
import { createExternalRagSearchTool } from './tools/external-rag-search';
import { createOrchestratorPlanTools } from './tools/orchestrator-plan';
import { registerTracingResource } from './resources/tracing';
import { registerAgentLoopResource } from './resources/agent-loop';
import { getRunEventBus } from './services/RunEventBus';
import SkillHubSubFeature from './skill-hub/plugin';
import { AgentLoopService } from './services/AgentLoopService';

export class PluginAgentOrchestratorServer extends Plugin {
  skillHub: SkillHubSubFeature;
  agentLoopService: AgentLoopService;

  async afterAdd() {
    this.skillHub = new SkillHubSubFeature(this);
    this.agentLoopService = new AgentLoopService(this);
  }

  async beforeLoad() {
    // Import collection definitions
    (this as any).db.import({ directory: path.resolve(__dirname, 'collections') });

    (this as any).db.addMigrations({
      namespace: (this as any).name,
      directory: path.resolve(__dirname, 'migrations'),
      context: { plugin: this },
    });
  }

  async load() {
    await this.skillHub.load();

    // --- ACL ---
    (this as any).app.acl.registerSnippet({
      name: `pm.${(this as any).name}`,
      actions: [
        'orchestratorConfig:*',
        'orchestratorTracing:*',
        'agentLoops:*',
        'agentLoopRuns:*',
        'agentLoopSteps:*',
        'agentLoopEvents:*',
        'agentLoopEventsStream:*',
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
    (this as any).app.acl.allow('skillDefinitions', 'list', 'loggedIn');
    (this as any).app.acl.allow('skillDefinitions', 'get', 'loggedIn');
    (this as any).app.acl.allow('skillLoopConfigs', 'list', 'loggedIn');
    (this as any).app.acl.allow('skillLoopConfigs', 'get', 'loggedIn');
    (this as any).app.acl.allow('skillExecutions', 'list', 'loggedIn');
    (this as any).app.acl.allow('skillExecutions', 'get', 'loggedIn');
    (this as any).app.acl.allow('skillHub', 'test', 'loggedIn');
    (this as any).app.acl.allow('skillHub', 'download', 'loggedIn');
    (this as any).app.acl.allow('skillHub', 'listTemplates', 'loggedIn');

    // --- Register Dynamic Tools ---
    // Each configured sub-agent becomes a callable tool for its leader.
    // Uses createReactAgent (LangGraph public API) instead of private AIEmployee class.
    // Tools are registered via app.aiManager.toolsManager (public API from @nocobase/ai core).
    const toolsManager = (this as any).app.aiManager.toolsManager;
    toolsManager.registerTools(createOrchestratorPlanTools(this, this.agentLoopService));
    toolsManager.registerTools(createExternalRagSearchTool(this));
    toolsManager.registerDynamicTools(createDelegateToolsProvider(this));

    // --- Register Agent Loop Resource ---
    registerAgentLoopResource(this, this.agentLoopService);

    // --- Register SSE Event Stream Resource (Phase 6) ---
    (this as any).app.resource({
      name: 'agentLoopEventsStream',
      actions: {
        async stream(ctx, next) {
          const runId = ctx.action.params?.runId || ctx.query?.runId || ctx.request.query?.runId;
          if (!runId) {
            ctx.throw(400, 'runId query parameter is required.');
            return;
          }

          ctx.type = 'text/event-stream';
          ctx.set('Cache-Control', 'no-cache');
          ctx.set('Connection', 'keep-alive');
          ctx.set('X-Accel-Buffering', 'no');

          const unsubscribe = getRunEventBus().subscribe(runId, (event: any) => {
            try {
              ctx.res.write(`data: ${JSON.stringify(event)}\n\n`);
            } catch {
              unsubscribe();
            }
          });

          const keepalive = setInterval(() => {
            try {
              ctx.res.write(': keepalive\n\n');
            } catch {
              clearInterval(keepalive);
              unsubscribe();
            }
          }, 15000);

          ctx.req.on('close', () => {
            clearInterval(keepalive);
            unsubscribe();
          });

          ctx.req.on('error', () => {
            clearInterval(keepalive);
            unsubscribe();
          });

          ctx.res.writeHead(200);
          ctx.res.write(': connected\n\n');

          await next();
        },
      },
    });

    // --- Register Tracing Resource (Phase 5) ---
    // Custom read-only resource for the Swarm Tracing admin page.
    registerTracingResource(this);

    // --- Log Retention ---
    // Daily prune of orchestratorLogs / agentExecutionSpans to keep tables bounded.
    // Override window via env: ORCHESTRATOR_LOG_RETENTION_DAYS (default 30).
    (this as any).app.cronJobManager.addJob({
      cronTime: '0 30 2 * * *',
      onTick: async () => {
        try {
          const days = Number(process.env.ORCHESTRATOR_LOG_RETENTION_DAYS || 30);
          if (!Number.isFinite(days) || days <= 0) return;
          const cutoff = new Date(Date.now() - days * 86400000);
          const repo = (this as any).db.getRepository('orchestratorLogs');
          const spansRepo = (this as any).db.getRepository('agentExecutionSpans');
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
          (this as any).app.log.info(
            `[AgentOrchestrator] Pruned ${deletedLogs} orchestratorLogs and ${deletedSpans} agentExecutionSpans rows older than ${days} day(s).`,
          );
        } catch (e) {
          (this as any).app.log.error('[AgentOrchestrator] Log retention job failed', e);
        }
      },
    });

    // NOTE: The createReactAgent approach does NOT create aiConversation records,
    // so there is no need for a middleware to hide "headless" conversations.
    // If future versions need conversation logging, add it here.
  }

  async install() {
    await this.skillHub.install();
  }

  async afterEnable() {}
  async afterDisable() {}
  async remove() {}

  async beforeStop() {
    await this.skillHub.beforeStop();
  }
}

export default PluginAgentOrchestratorServer;
