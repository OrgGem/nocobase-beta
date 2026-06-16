/**
 * Single accessor for the core AI tools manager.
 *
 * plugin-ai exposes the tools manager at `app.aiManager.toolsManager`, and the
 * same instance is reachable via `pluginAI.ai.toolsManager`. Mixing the two
 * access paths risks registering tools on one object while resolving them on
 * another if the wiring ever diverges. Every orchestrator call site goes
 * through this helper so registration and resolution always share one manager.
 */
export function getAIToolsManager(app: any) {
  const toolsManager = app?.aiManager?.toolsManager;
  if (!toolsManager) {
    throw new Error(
      '[AgentOrchestrator] app.aiManager.toolsManager is not available. ' +
        'Ensure @nocobase/plugin-ai is enabled and loaded before plugin-agent-orchestrator.',
    );
  }
  return toolsManager;
}

/** Same accessor, but returns undefined instead of throwing (best-effort call sites). */
export function tryGetAIToolsManager(app: any) {
  return app?.aiManager?.toolsManager;
}
