export const ORCHESTRATOR_TRACE_CONTEXT_KEY = '__orchestratorTraceContext';

export type OrchestratorTraceContext = {
  rootRunId: string;
  spanId?: string;
  parentSpanId?: string;
  toolCallId?: string;
  leaderUsername?: string;
  employeeUsername?: string;
  toolName?: string;
};

type SpanValues = {
  rootRunId: string;
  parentSpanId?: string;
  type: string;
  status: string;
  leaderUsername?: string;
  employeeUsername?: string;
  toolName?: string;
  title?: string;
  input?: any;
  output?: string;
  error?: string;
  durationMs?: number;
  startedAt?: Date;
  endedAt?: Date;
  orchestratorLogId?: string | number;
  skillExecutionId?: string | number;
  metadata?: any;
  userId?: string | number;
};

function toPlain(record: any) {
  return record?.toJSON?.() || record;
}

export class ExecutionSpanService {
  constructor(private readonly plugin: any) {}

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
      this.plugin.app.log?.warn?.('[AgentOrchestrator] Failed to create execution span', error);
      return null;
    }
  }

  async update(spanId: string | number | undefined, values: Record<string, any>) {
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
      this.plugin.app.log?.warn?.(`[AgentOrchestrator] Failed to update execution span ${spanId}`, error);
      return null;
    }
  }

  async finish(
    spanId: string | number | undefined,
    status: 'success' | 'error' | 'canceled' | 'timeout',
    startedAt: number,
    values: Record<string, any> = {},
  ) {
    return this.update(spanId, {
      ...values,
      status,
      endedAt: new Date(),
      durationMs: Date.now() - startedAt,
    });
  }
}

export function getOrchestratorTraceContext(ctx: any): OrchestratorTraceContext | null {
  return (
    ctx?.[ORCHESTRATOR_TRACE_CONTEXT_KEY] ||
    ctx?.state?.orchestratorTraceContext ||
    ctx?.runtime?.context?.orchestratorTraceContext ||
    null
  );
}

export function setOrchestratorTraceContext(ctx: any, traceContext: OrchestratorTraceContext) {
  ctx[ORCHESTRATOR_TRACE_CONTEXT_KEY] = traceContext;
  return ctx;
}
