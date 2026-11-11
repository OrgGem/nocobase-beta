/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

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
  nativeIdentity?: string;
  parentSpanId?: string;
  depth?: number;
  agentLoopRunId?: string | number | null;
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
  nativeActivityAt?: Date;
  orchestratorLogId?: string | number;
  skillExecutionId?: string | number;
  metadata?: Record<string, unknown>;
  userId?: string | number;
};

export class ExecutionSpanService {
  constructor(
    private readonly plugin: {
      app: {
        logger?: {
          warn?: (
            message: string,
            meta?: { module?: string; submodule?: string; method?: string; [key: string]: unknown },
          ) => void;
        };
      };
      db: {
        getRepository: (name: string) =>
          | {
              create: (opts: Record<string, unknown>) => Promise<unknown>;
              update: (opts: Record<string, unknown>) => Promise<unknown>;
              findOne?: (opts: Record<string, unknown>) => Promise<unknown>;
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
      this.plugin.app.logger?.warn?.('[AgentOrchestrator] Failed to create execution span', { error });
      return null;
    }
  }

  async upsertNative(identity: string, values: SpanValues) {
    if (!identity) return null;
    const repo = this.plugin.db.getRepository('agentExecutionSpans');
    if (!repo?.findOne) return this.create({ ...values, nativeIdentity: identity });

    try {
      const existing = await repo.findOne({ filter: { nativeIdentity: identity } });
      if (existing) return this.updateNativeRecord(repo, existing, values, identity);
      try {
        if (values.type === 'sub_agent' && values.parentSessionId && values.subSessionId && values.toolCallId) {
          const legacy = await repo.findOne({
            filter: {
              nativeIdentity: null,
              source: values.source,
              type: 'sub_agent',
              parentSessionId: values.parentSessionId,
              subSessionId: values.subSessionId,
              toolCallId: values.toolCallId,
            },
          });
          if (legacy) return await this.updateNativeRecord(repo, legacy, values, identity);
        }
        const record = await repo.create({
          values: {
            ...values,
            nativeIdentity: identity,
            startedAt: values.startedAt || new Date(),
            createdAt: new Date(),
          },
        });
        return toPlain(record);
      } catch (createError) {
        // The unique native identity serializes projection writes from concurrent app instances.
        // Re-read after a conflict so the losing writer can reconcile the row instead of creating
        // a duplicate or failing the native agent call.
        const raced = await repo.findOne({ filter: { nativeIdentity: identity } });
        if (!raced) throw createError;
        return this.updateNativeRecord(repo, raced, values, identity);
      }
    } catch (error) {
      this.warn(`[AgentOrchestrator] Failed to upsert native execution span ${identity}`, error);
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
      this.plugin.app.logger?.warn?.(`[AgentOrchestrator] Failed to update execution span ${spanId}`, { error });
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

  private async updateNativeRecord(
    repo: {
      update: (opts: Record<string, unknown>) => Promise<unknown>;
    },
    rawExisting: unknown,
    values: SpanValues,
    identity: string,
  ) {
    const existing = toPlain(rawExisting) as Record<string, unknown>;
    const nextValues = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
    delete nextValues.nativeActivityAt;
    const terminalStatuses = ['success', 'error', 'canceled', 'timeout'];
    const isNonTerminal = !terminalStatuses.includes(values.status);
    if (isNonTerminal) delete nextValues.status;
    const existingMetadata =
      existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
        ? (existing.metadata as Record<string, unknown>)
        : {};
    const incomingMetadata =
      values.metadata && typeof values.metadata === 'object' && !Array.isArray(values.metadata) ? values.metadata : {};
    await repo.update({
      filterByTk: existing.id,
      values: {
        ...nextValues,
        nativeIdentity: identity,
        metadata: { ...existingMetadata, ...incomingMetadata },
        startedAt: existing.startedAt || values.startedAt || new Date(),
        updatedAt: new Date(),
      },
    });
    if (isNonTerminal) {
      // A sync may have read an old running row while another instance completed it.
      // Guard the status update in the database rather than trusting the earlier read.
      await repo.update({
        filter: { id: existing.id, status: { $notIn: terminalStatuses } },
        values: { status: values.status },
      });
    }
    if (values.nativeActivityAt)
      await this.advanceNativeActivity(existing.id as string | number, values.nativeActivityAt);
    return { ...existing, ...nextValues, nativeIdentity: identity, id: existing.id };
  }

  async advanceNativeActivity(id: string | number, activityAt: Date) {
    const repo = this.plugin.db.getRepository('agentExecutionSpans');
    if (!repo) throw new Error('Execution span repository is unavailable.');
    await repo.update({
      filter: { id, $or: [{ nativeActivityAt: null }, { nativeActivityAt: { $lt: activityAt.toISOString() } }] },
      values: { nativeActivityAt: activityAt },
    });
  }

  private warn(message: string, error: unknown) {
    try {
      this.plugin.app.logger?.warn?.(message, { error });
    } catch {
      // Telemetry logging must not affect the native agent call.
    }
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

  const requestRootRunId = (requestContext as Record<string, unknown>)?.rootRunId;
  const rootRunId = typeof requestRootRunId === 'string' ? requestRootRunId : agentContext?.rootRunId;
  if (!rootRunId) return null;

  const toolCallId = [
    deepGet(ctx, 'runtime.toolCallId'),
    (requestContext as Record<string, unknown>)?.toolCallId,
    agentContext?.toolCallId,
  ].find((value): value is string => typeof value === 'string');

  return {
    ...(agentContext || {}),
    ...((requestContext as Record<string, unknown>) || {}),
    rootRunId,
    toolCallId,
  };
}

export function setOrchestratorTraceContext(ctx: NocoCtx, traceContext: OrchestratorTraceContext) {
  ctx[ORCHESTRATOR_TRACE_CONTEXT_KEY] = traceContext;
  return ctx;
}
