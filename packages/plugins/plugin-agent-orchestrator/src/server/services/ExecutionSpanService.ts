import { toPlain } from '../utils/ctx-utils';
import { getAgentExecutionContext } from './AgentExecutionContext';

export const ORCHESTRATOR_TRACE_CONTEXT_KEY = '__orchestratorTraceContext';

export type OrchestratorTraceContext = {
  rootRunId: string;
  spanId?: string;
  parentSpanId?: string;
  toolCallId?: string;
  leaderUsername?: string;
  employeeUsername?: string;
  toolName?: string;
  agentLoopRunId?: string;
  agentLoopStepId?: string;
  sessionId?: string;
};

type SpanValues = {
  rootRunId: string;
  parentSpanId?: string;
  depth?: number;
  agentLoopRunId?: string | number;
  source?: string;
  parentSessionId?: string;
  subSessionId?: string;
  toolCallId?: string;
  type: string;
  status: string;
  leaderUsername?: string;
  employeeUsername?: string;
  toolName?: string;
  title?: string;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  durationMs?: number;
  startedAt?: Date;
  endedAt?: Date;
  orchestratorLogId?: string | number;
  skillExecutionId?: string | number;
  metadata?: Record<string, unknown>;
  userId?: string | number;
};

export class ExecutionSpanService {
  constructor(
    private readonly plugin: {
      app: { logger?: { warn?: (...args: unknown[]) => void } };
      db: {
        getRepository: (name: string) =>
          | {
              create: (opts: Record<string, unknown>) => Promise<unknown>;
              update: (opts: Record<string, unknown>) => Promise<unknown>;
            }
          | undefined;
      };
    },
  ) {}

  async create(values: SpanValues) {
    try {
      const repo = this.plugin.db.getRepository('agentExecutionSpans');
      if (!repo) return null;

      const record = await repo.create({
        values: {
          ...values,
          startedAt: values.startedAt || new Date(),
          createdAt: new Date(),
        },
      });
      return toPlain(record);
    } catch (error) {
      this.plugin.app.logger?.warn?.('[AgentOrchestrator] Failed to create execution span', error);
      return null;
    }
  }

  async update(spanId: string | number | undefined, values: Record<string, unknown>) {
    if (!spanId) return null;
    try {
      const repo = this.plugin.db.getRepository('agentExecutionSpans');
      if (!repo) return null;
      await repo.update({
        filterByTk: spanId,
        values: {
          ...values,
          updatedAt: new Date(),
        },
      });
      return { id: spanId };
    } catch (error) {
      this.plugin.app.logger?.warn?.(`[AgentOrchestrator] Failed to update execution span ${spanId}`, error);
      return null;
    }
  }

  async finish(
    spanId: string | number | undefined,
    status: 'success' | 'error' | 'canceled' | 'timeout',
    startedAt: number,
    values: Record<string, unknown> = {},
  ) {
    return this.update(spanId, {
      ...values,
      status,
      endedAt: new Date(),
      durationMs: Date.now() - startedAt,
    });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NocoCtx = Record<string, unknown> & { state?: Record<string, unknown>; runtime?: Record<string, unknown> };

function deepGet(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (current && typeof current === 'object') return (current as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

export function getOrchestratorTraceContext(ctx: NocoCtx): OrchestratorTraceContext | null {
  const requestContext =
    ctx[ORCHESTRATOR_TRACE_CONTEXT_KEY] ||
    deepGet(ctx, 'state.orchestratorTraceContext') ||
    deepGet(ctx, 'runtime.context.orchestratorTraceContext') ||
    null;
  const agentContext = getAgentExecutionContext();
  if (!requestContext && !agentContext) return null;

  return {
    ...(agentContext || {}),
    ...((requestContext as Record<string, unknown>) || {}),
    toolCallId:
      deepGet(ctx, 'runtime.toolCallId') ||
      (requestContext as Record<string, unknown>)?.toolCallId ||
      agentContext?.toolCallId,
  };
}

export function setOrchestratorTraceContext(ctx: NocoCtx, traceContext: OrchestratorTraceContext) {
  ctx[ORCHESTRATOR_TRACE_CONTEXT_KEY] = traceContext;
  return ctx;
}
