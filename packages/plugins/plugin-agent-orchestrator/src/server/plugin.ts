import { Plugin } from '@nocobase/server';
import path from 'path';
import { createDelegateToolsProvider } from './tools/delegate-task';
import { registerTracingResource } from './resources/tracing';
import SkillHubSubFeature from './skill-hub/plugin';

export class PluginAgentOrchestratorServer extends Plugin {
  skillHub: SkillHubSubFeature;

  async afterAdd() {
    this.skillHub = new SkillHubSubFeature(this);
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
      actions: ['orchestratorConfig:*', 'orchestratorTracing:*', 'agentExecutionSpans:*', 'skillDefinitions:*', 'skillExecutions:*', 'skillHub:*', 'skillWorkerConfigs:*'],
    });

    // --- Register Dynamic Tools ---
    // Each configured sub-agent becomes a callable tool for its leader.
    // Uses createReactAgent (LangGraph public API) instead of private AIEmployee class.
    // Tools are registered via app.aiManager.toolsManager (public API from @nocobase/ai core).
    const toolsManager = this.app.aiManager.toolsManager;
    toolsManager.registerDynamicTools(createDelegateToolsProvider(this));

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
          const days = Number(process.env.ORCHESTRATOR_LOG_RETENTION_DAYS || 30);
          if (!Number.isFinite(days) || days <= 0) return;
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
