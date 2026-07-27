import { createHash } from 'crypto';
import { ExecutionSpanService } from './ExecutionSpanService';
import { AgentMemoryContextService } from './AgentMemoryContextService';
import { TokenTracker } from './TokenTracker';
import { asObject, currentUserId, toPlain, trimText } from '../utils/ctx-utils';

const WRAP_STATE_KEY = Symbol.for('plugin-agent-orchestrator.nativeSubAgentObserver');
const NATIVE_SOURCE = 'native-plugin-ai';

type NativeWriter = (chunk: Record<string, unknown>) => unknown;

type NativeSubAgentTask = {
  ctx: {
    action?: { params?: { values?: Record<string, unknown> } };
    auth?: { user?: { id?: string | number } };
    db?: { getRepository?: (name: string) => unknown };
    app?: unknown;
  };
  sessionId: string;
  employee: unknown;
  model?: unknown;
  question: string;
  skillSettings?: Record<string, unknown>;
  writer?: NativeWriter;
};

type DispatchToolMessage = {
  id?: string | number;
  messageId?: string | number;
  toolCallId?: string;
  sessionId?: string;
  status?: string;
  invokeStatus?: string;
};

type SpanRecord = {
  id?: string | number;
  rootRunId?: string;
  metadata?: Record<string, unknown>;
};

type ToolSpanState = {
  spanId?: string | number;
  startedAt: number;
  ready: Promise<void>;
};

type RunState = {
  rootRunId: string;
  rootSpanId?: string | number;
  rootStartedAt: number;
  rootMetadata: Record<string, unknown>;
  parentSessionId?: string;
  subSessionId?: string;
  toolCallId?: string;
  leaderUsername?: string;
  employeeUsername?: string;
  userId?: string | number;
  toolSpans: Map<string, ToolSpanState>;
  pending: Set<Promise<void>>;
};

type DispatcherWithRun = {
  run: (task: NativeSubAgentTask) => Promise<string>;
  [WRAP_STATE_KEY]?: {
    originalRun: (task: NativeSubAgentTask) => Promise<string>;
    wrappedRun: (task: NativeSubAgentTask) => Promise<string>;
  };
};

function readValue(record: unknown, key: string) {
  const model = record as { get?: (name: string) => unknown; [key: string]: unknown };
  return typeof model?.get === 'function' ? model.get(key) : model?.[key];
}

function normalizeString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function modelUsername(model: unknown) {
  return (
    normalizeString(readValue(model, 'username')) ||
    normalizeString(readValue(model, 'aiEmployeeUsername')) ||
    normalizeString(readValue(model, 'name')) ||
    undefined
  );
}

function makeNativeRunId(parts: Array<string | number | undefined>) {
  const source = parts.map((part) => String(part || '')).join('|');
  return `native_${createHash('sha1')
    .update(source || String(Date.now()))
    .digest('hex')
    .slice(0, 24)}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || 'Unknown error');
}

function chunkBody(chunk: Record<string, unknown>) {
  return asObject(chunk.body);
}

function chunkCurrentConversation(chunk: Record<string, unknown>) {
  return asObject(chunk.currentConversation);
}

export class NativeSubAgentObserver {
  private readonly spanService: ExecutionSpanService;
  private readonly memoryService: AgentMemoryContextService;
  private readonly tokenTracker: TokenTracker;

  constructor(private readonly plugin: { app: any; db: any; name?: string }) {
    this.spanService = new ExecutionSpanService(plugin);
    this.memoryService = new AgentMemoryContextService(plugin);
    this.tokenTracker = new TokenTracker(plugin);
  }

  install() {
    const aiPlugin = this.plugin.app.pm?.get?.('ai');
    const dispatcher = aiPlugin?.subAgentsDispatcher as DispatcherWithRun | undefined;
    if (!dispatcher?.run) {
      this.plugin.app.logger?.warn?.(
        '[AgentOrchestrator] plugin-ai subAgentsDispatcher not available; observer skipped.',
      );
      return false;
    }

    const existing = dispatcher[WRAP_STATE_KEY];
    if (existing?.wrappedRun === dispatcher.run) {
      return false;
    }

    const originalRun = existing?.originalRun || dispatcher.run.bind(dispatcher);
    const observer = this;
    const wrappedRun = async function wrappedNativeSubAgentRun(task: NativeSubAgentTask) {
      return observer.runObserved(originalRun, task);
    };

    dispatcher.run = wrappedRun;
    dispatcher[WRAP_STATE_KEY] = {
      originalRun,
      wrappedRun,
    };

    this.plugin.app.logger?.info?.('[AgentOrchestrator] Native plugin-ai sub-agent observer installed.');
    return true;
  }

  uninstall() {
    const aiPlugin = this.plugin.app.pm?.get?.('ai');
    const dispatcher = aiPlugin?.subAgentsDispatcher as DispatcherWithRun | undefined;
    const existing = dispatcher?.[WRAP_STATE_KEY];
    if (!dispatcher?.run || !existing || existing.wrappedRun !== dispatcher.run) {
      return false;
    }

    dispatcher.run = existing.originalRun;
    delete dispatcher[WRAP_STATE_KEY];
    this.plugin.app.logger?.info?.('[AgentOrchestrator] Native plugin-ai sub-agent observer uninstalled.');
    return true;
  }

  private async runObserved(originalRun: (task: NativeSubAgentTask) => Promise<string>, task: NativeSubAgentTask) {
    const settings = await this.safeResolvePolicy(task);
    if (settings.nativeObserverEnabled === false) {
      return originalRun(task);
    }

    const parentSessionId = this.resolveParentSessionId(task) || undefined;
    const subSessionId = normalizeString(task.sessionId) || undefined;
    const employeeUsername = modelUsername(task.employee);
    const userId = currentUserId(task.ctx) || task.ctx?.auth?.user?.id;
    const dispatchToolMessage = await this.resolveDispatchToolMessage(task.ctx, parentSessionId, subSessionId);
    const toolCallId = dispatchToolMessage?.toolCallId;
    const leaderUsername = await this.resolveLeaderUsername(task.ctx, parentSessionId);
    const rootRunId = makeNativeRunId([parentSessionId, subSessionId, toolCallId, employeeUsername]);
    const memory = await this.safeBuildMemoryContext({
      userId,
      aiEmployeeUsername: employeeUsername,
      settings,
    });
    const observedTask = memory.context
      ? {
          ...task,
          question: `${memory.context}\n\n<agent_task>\n${task.question}\n</agent_task>`,
        }
      : task;

    const state: RunState = {
      rootRunId,
      rootStartedAt: Date.now(),
      rootMetadata: {
        source: NATIVE_SOURCE,
        parentSessionId,
        subSessionId,
        toolCallId,
        dispatchToolMessageId: dispatchToolMessage?.id,
        dispatchMessageId: dispatchToolMessage?.messageId,
        memoryContextApplied: Boolean(memory.context),
        memoryScopes: memory.appliedScopes,
        memoryContextChars: memory.chars,
        harnessTag: settings.harnessTag || 'default',
      },
      parentSessionId,
      subSessionId,
      toolCallId,
      leaderUsername,
      employeeUsername,
      userId,
      toolSpans: new Map(),
      pending: new Set(),
    };

    await this.safeCreateRootSpan(state, task.question);

    const originalWriter = task.writer;
    observedTask.writer = (chunk: Record<string, unknown>) => {
      const pending = this.handleWriterChunk(state, chunk).catch((error) => {
        this.plugin.app.logger?.warn?.('[AgentOrchestrator] Native writer observer failed', error);
      });
      state.pending.add(pending);
      return originalWriter?.(chunk);
    };

    try {
      const result = await this.runWithKnowledgeBaseAgentContext(employeeUsername, () => originalRun(observedTask));
      await this.flushPending(state);
      await this.spanService.finish(state.rootSpanId, 'success', state.rootStartedAt, {
        output: trimText(result, 20000),
        metadata: {
          ...state.rootMetadata,
          completedAt: new Date().toISOString(),
        },
      });
      await this.tokenTracker.estimateAndTrack(
        state.rootSpanId,
        task.question,
        result,
        state.rootMetadata.agentLoopRunId ? Number(state.rootMetadata.agentLoopRunId) : undefined,
      );
      return result;
    } catch (error) {
      await this.flushPending(state);
      await this.spanService.finish(state.rootSpanId, 'error', state.rootStartedAt, {
        error: trimText(errorMessage(error), 10000),
        metadata: {
          ...state.rootMetadata,
          failedAt: new Date().toISOString(),
        },
      });
      await this.tokenTracker.estimateAndTrack(
        state.rootSpanId,
        task.question,
        errorMessage(error),
        state.rootMetadata.agentLoopRunId ? Number(state.rootMetadata.agentLoopRunId) : undefined,
      );
      throw error;
    }
  }

  private async safeResolvePolicy(task: NativeSubAgentTask) {
    try {
      return await this.memoryService.resolvePolicySettings(task);
    } catch (error) {
      this.plugin.app.logger?.warn?.('[AgentOrchestrator] Failed to resolve native observer policy', error);
      return { harnessTag: 'default' };
    }
  }

  private async safeBuildMemoryContext(options: {
    userId?: string | number;
    aiEmployeeUsername?: string;
    settings: Record<string, unknown>;
  }) {
    try {
      return await this.memoryService.buildContext(options);
    } catch (error) {
      this.plugin.app.logger?.warn?.('[AgentOrchestrator] Failed to build agent memory context', error);
      return { context: '', appliedScopes: [] as string[], chars: 0 };
    }
  }

  private async safeCreateRootSpan(state: RunState, question: string) {
    const span = (await this.spanService.create({
      rootRunId: state.rootRunId,
      parentSpanId: undefined,
      source: NATIVE_SOURCE,
      parentSessionId: state.parentSessionId,
      subSessionId: state.subSessionId,
      toolCallId: state.toolCallId,
      type: 'sub_agent',
      status: 'running',
      leaderUsername: state.leaderUsername,
      employeeUsername: state.employeeUsername,
      toolName: 'dispatch-sub-agent-task',
      title: `${state.leaderUsername || 'main'} -> ${state.employeeUsername || 'sub-agent'}`,
      input: {
        question,
        parentSessionId: state.parentSessionId,
        subSessionId: state.subSessionId,
      },
      metadata: state.rootMetadata,
      userId: state.userId,
    })) as SpanRecord | null;

    state.rootSpanId = span?.id;
  }

  private runWithKnowledgeBaseAgentContext<T>(employeeUsername: string | undefined, fn: () => Promise<T>) {
    if (!employeeUsername) return fn();
    const knowledgeBasePlugin = this.plugin.app.pm?.get?.('plugin-knowledge-base') as
      | { runWithAgentContext?: <TResult>(username: string, callback: () => Promise<TResult>) => Promise<TResult> }
      | undefined;
    return knowledgeBasePlugin?.runWithAgentContext
      ? knowledgeBasePlugin.runWithAgentContext(employeeUsername, fn)
      : fn();
  }

  private async handleWriterChunk(state: RunState, chunk: Record<string, unknown>) {
    const action = chunk.action;
    if (action === 'beforeToolCall') {
      await this.handleBeforeToolCall(state, chunk);
      return;
    }
    if (action === 'afterToolCall') {
      await this.handleAfterToolCall(state, chunk, false);
      return;
    }
    if (action === 'afterToolCallError') {
      await this.handleAfterToolCall(state, chunk, true);
      return;
    }
    if (action === 'afterSubAgentInvoke') {
      state.rootMetadata = {
        ...state.rootMetadata,
        afterSubAgentInvokeAt: new Date().toISOString(),
      };
      await this.spanService.update(state.rootSpanId, { metadata: state.rootMetadata });
    }
  }

  private async handleBeforeToolCall(state: RunState, chunk: Record<string, unknown>) {
    const body = chunkBody(chunk);
    const toolCall = asObject(body.toolCall);
    const toolCallId = normalizeString(toolCall.id);
    if (!toolCallId || state.toolSpans.has(toolCallId)) return;

    const conversation = chunkCurrentConversation(chunk);
    const startedAt = Date.now();
    const toolSpan: ToolSpanState = {
      startedAt,
      ready: Promise.resolve(),
    };
    state.toolSpans.set(toolCallId, toolSpan);

    toolSpan.ready = this.spanService
      .create({
        rootRunId: state.rootRunId,
        parentSpanId: state.rootSpanId ? String(state.rootSpanId) : undefined,
        source: NATIVE_SOURCE,
        parentSessionId: state.parentSessionId || undefined,
        subSessionId: normalizeString(conversation.sessionId) || state.subSessionId || undefined,
        toolCallId,
        type: normalizeString(toolCall.name) === 'dispatch-sub-agent-task' ? 'dispatch' : 'tool',
        status: 'running',
        leaderUsername: state.leaderUsername,
        employeeUsername: normalizeString(conversation.username) || state.employeeUsername,
        toolName: normalizeString(toolCall.name),
        title: normalizeString(toolCall.name) || 'tool call',
        input: asObject(toolCall.args),
        metadata: {
          source: NATIVE_SOURCE,
          currentConversation: conversation,
          messageId: toolCall.messageId,
        },
        userId: state.userId,
      })
      .then((span) => {
        toolSpan.spanId = (span as SpanRecord | null)?.id;
      });

    await toolSpan.ready;
  }

  private async handleAfterToolCall(state: RunState, chunk: Record<string, unknown>, forceError: boolean) {
    const body = chunkBody(chunk);
    const toolCall = asObject(body.toolCall);
    const toolCallId = normalizeString(toolCall.id);
    const existing = toolCallId ? state.toolSpans.get(toolCallId) : undefined;
    if (!existing) return;
    await existing.ready;

    const result = asObject(toPlain(body.toolCallResult));
    const error = body.error;
    const status = forceError || result.status === 'error' ? 'error' : 'success';
    const output = result.content ?? result.result ?? result;
    const invokeStart = Number(result.invokeStartTime);
    const invokeEnd = Number(result.invokeEndTime);
    const durationMs =
      Number.isFinite(invokeStart) && Number.isFinite(invokeEnd) && invokeEnd >= invokeStart
        ? invokeEnd - invokeStart
        : Date.now() - existing.startedAt;

    await this.spanService.update(existing.spanId, {
      status,
      endedAt: new Date(),
      durationMs,
      output: forceError ? undefined : trimText(output, 20000),
      error: forceError ? trimText(errorMessage(error), 10000) : undefined,
      metadata: {
        source: NATIVE_SOURCE,
        toolCallResultStatus: result.status,
        invokeStatus: result.invokeStatus,
        messageId: toolCall.messageId,
      },
    });

    await this.tokenTracker.estimateAndTrack(
      existing.spanId,
      normalizeString(toolCall.name),
      typeof output === 'string' ? output : JSON.stringify(output),
    );
  }

  private resolveParentSessionId(task: NativeSubAgentTask) {
    const values = task.ctx?.action?.params?.values || {};
    return normalizeString(values.sessionId) || undefined;
  }

  private async resolveLeaderUsername(ctx: NativeSubAgentTask['ctx'], parentSessionId?: string) {
    const values = ctx?.action?.params?.values || {};
    const direct =
      normalizeString(values.aiEmployeeUsername) ||
      normalizeString((asObject(values.aiEmployee) as Record<string, unknown>).username);
    if (direct) return direct;
    if (!parentSessionId) return undefined;

    try {
      const repo = ctx.db?.getRepository?.('aiConversations') as
        | { findOne?: (options: Record<string, unknown>) => Promise<unknown> }
        | undefined;
      const conversation = await repo?.findOne?.({
        filter: { sessionId: parentSessionId },
      });
      return normalizeString(readValue(conversation, 'aiEmployeeUsername')) || undefined;
    } catch {
      return undefined;
    }
  }

  private async resolveDispatchToolMessage(
    ctx: NativeSubAgentTask['ctx'],
    parentSessionId?: string,
    subSessionId?: string,
  ) {
    if (!parentSessionId) return null;
    try {
      const fromMetadata = await this.resolveDispatchToolMessageFromMetadata(ctx, parentSessionId, subSessionId);
      if (fromMetadata) {
        return fromMetadata;
      }

      const repo = ctx.db?.getRepository?.('aiToolMessages') as
        | { findOne?: (options: Record<string, unknown>) => Promise<unknown> }
        | undefined;
      const record = await repo?.findOne?.({
        filter: {
          sessionId: parentSessionId,
          toolName: 'dispatch-sub-agent-task',
          invokeStatus: {
            $ne: 'confirmed',
          },
        },
        sort: ['-id'],
      });
      return toPlain(record) as DispatchToolMessage | null;
    } catch {
      return null;
    }
  }

  private async resolveDispatchToolMessageFromMetadata(
    ctx: NativeSubAgentTask['ctx'],
    parentSessionId?: string,
    subSessionId?: string,
  ) {
    if (!parentSessionId || !subSessionId) return null;

    const messageRepo = ctx.db?.getRepository?.('aiMessages') as
      | { find?: (options: Record<string, unknown>) => Promise<unknown[]> }
      | undefined;
    const toolRepo = ctx.db?.getRepository?.('aiToolMessages') as
      | { findOne?: (options: Record<string, unknown>) => Promise<unknown> }
      | undefined;
    const messages = await messageRepo?.find?.({
      filter: { sessionId: parentSessionId },
      sort: ['-messageId'],
      limit: 20,
    });
    if (!Array.isArray(messages)) return null;

    for (const rawMessage of messages) {
      const message = toPlain(rawMessage);
      const conversations = asObject(message?.metadata).subAgentConversations;
      if (!Array.isArray(conversations)) continue;

      const matched = conversations.find((item) => normalizeString(item?.sessionId) === subSessionId);
      const toolCallId = normalizeString(matched?.toolCallId);
      if (!toolCallId) continue;

      const toolMessage = await toolRepo?.findOne?.({
        filter: {
          sessionId: parentSessionId,
          toolCallId,
        },
      });
      return {
        ...(toPlain(toolMessage) || {}),
        toolCallId,
        messageId: readValue(toolMessage, 'messageId') || message?.messageId,
        sessionId: parentSessionId,
        status: matched?.status,
      } as DispatchToolMessage;
    }

    return null;
  }

  private async flushPending(state: RunState) {
    const pending = Array.from(state.pending);
    if (!pending.length) return;
    await Promise.allSettled(pending);
  }
}

export { NATIVE_SOURCE, makeNativeRunId };
