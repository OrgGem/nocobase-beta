/**
 * Shared scope/source resolution for AI tools.
 *
 * Extracted from shared-context-tool.ts and promote-to-kb-tool.ts
 * to eliminate duplicated logic (Fix P2-4).
 */

import type { ContextScope } from '../services/session-context';

/**
 * Resolve the context scope from the current request context.
 *
 * Checks (in priority order):
 *  1. Orchestrator trace context → rootRunId (set by delegate-task.ts)
 *  2. Chat session → sessionId (from plugin-ai conversation context)
 */
export function resolveScope(ctx: any): ContextScope {
  const scope: ContextScope = {};

  // 1. Orchestrator trace context (set by agent-orchestrator delegate-task.ts)
  const traceCtx =
    ctx?.['__orchestratorTraceContext'] ||
    ctx?.state?.orchestratorTraceContext ||
    ctx?.runtime?.context?.orchestratorTraceContext;

  if (traceCtx?.rootRunId) {
    scope.rootRunId = traceCtx.rootRunId;
  }

  // 2. AI Chat session
  const sessionId =
    ctx?.action?.params?.values?.sessionId ||
    ctx?.action?.params?.sessionId ||
    ctx?.state?.sessionId;

  if (sessionId) {
    scope.sessionId = sessionId;
  }

  return scope;
}

/**
 * Identify who is writing the context entry.
 */
export function resolveSource(ctx: any): string {
  // From orchestrator trace context
  const traceCtx =
    ctx?.['__orchestratorTraceContext'] ||
    ctx?.state?.orchestratorTraceContext;
  if (traceCtx?.employeeUsername) return traceCtx.employeeUsername;

  // From AI Employee context
  const employee =
    ctx?._currentAIEmployee ||
    ctx?.state?.currentAIEmployee ||
    ctx?.action?.params?.values?.aiEmployee;

  if (typeof employee === 'string') return employee;
  if (employee?.username) return employee.username;

  return 'unknown';
}

/**
 * Resolve the authenticated user ID from the context.
 */
export function resolveUserId(ctx: any): string | number | undefined {
  return ctx?.auth?.user?.id || ctx?.state?.currentUser?.id;
}
