import { Plugin } from '@nocobase/server';
import path from 'path';
import { createDelegateToolsProvider } from './tools/delegate-task';
import { registerTracingResource } from './resources/tracing';

export class PluginAgentOrchestratorServer extends Plugin {
  async afterAdd() {}

  async beforeLoad() {
    // Import collection definitions
    this.db.import({ directory: path.resolve(__dirname, 'collections') });
  }

  async load() {
    // --- ACL ---
    this.app.acl.registerSnippet({
      name: `pm.${this.name}`,
      actions: ['orchestratorConfig:*'],
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
    // Daily prune of orchestratorLogs to keep the table bounded.
    // Override window via env: ORCHESTRATOR_LOG_RETENTION_DAYS (default 30).
    this.app.cronJobManager.addJob({
      cronTime: '0 30 2 * * *',
      onTick: async () => {
        try {
          const days = Number(process.env.ORCHESTRATOR_LOG_RETENTION_DAYS || 30);
          if (!Number.isFinite(days) || days <= 0) return;
          const cutoff = new Date(Date.now() - days * 86400000);
          const repo = this.db.getRepository('orchestratorLogs');
          if (!repo) return;
          const deleted = await repo.destroy({
            filter: { createdAt: { $lt: cutoff.toISOString() } },
          });
          this.app.log.info(`[AgentOrchestrator] Pruned ${deleted} orchestratorLogs rows older than ${days} day(s).`);
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
    // No seed data needed on first install
  }

  async afterEnable() {}
  async afterDisable() {}
  async remove() {}
}

export default PluginAgentOrchestratorServer;
