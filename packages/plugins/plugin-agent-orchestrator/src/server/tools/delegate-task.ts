function sanitizeToolPart(value: string) {
  return (value || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function buildDelegateToolName(leaderUsername: string, subAgentUsername: string) {
  return `delegate_${sanitizeToolPart(leaderUsername)}_to_${sanitizeToolPart(subAgentUsername)}`;
}

export function buildDispatchToolName(leaderUsername: string) {
  return `dispatch_subagents_${sanitizeToolPart(leaderUsername)}`;
}

export function invalidateDelegateToolsCache() {
  // Legacy dynamic delegate tools are retired. Native plugin-ai owns sub-agent dispatch.
}

/**
 * Retired compatibility provider.
 *
 * plugin-agent-orchestrator no longer registers delegate_* or dispatch_subagents_*
 * tools. Keep this export so older imports fail closed instead of reintroducing
 * a LangChain-backed executor path.
 */
export function createDelegateToolsProvider(plugin: { app?: { logger?: { info?: (message: string) => void } } }) {
  return async () => {
    plugin.app?.logger?.info?.(
      '[AgentOrchestrator] Legacy delegate_* tools are retired; native dispatch-sub-agent-task is used instead.',
    );
  };
}
