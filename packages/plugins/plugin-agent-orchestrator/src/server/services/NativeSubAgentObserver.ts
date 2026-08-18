import { createHash } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { ExecutionSpanService } from './ExecutionSpanService';
import { AgentMemoryContextService } from './AgentMemoryContextService';
import { TokenTracker } from './TokenTracker';
import { getAgentExecutionContext, runWithAgentExecutionContext } from './AgentExecutionContext';
import { compileHarness } from './HarnessCompiler';
import type { CompiledHarness, HarnessLayer } from './HarnessCompiler';
import { redactSecretsIn, resolveRunRoleHarness, spilledText } from './harness-runtime-policy';
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
  policy: CompiledHarness;
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

function readSkillExecutionId(result: Record<string, unknown>): string | number | undefined {
  const nestedResult = asObject(result.result);
  const direct = nestedResult.execId || result.execId;
  if (typeof direct === 'string' || typeof direct === 'number') return direct;

  if (typeof result.content !== 'string') return undefined;
  try {
    const content = asObject(JSON.parse(result.content));
    return typeof content.execId === 'string' || typeof content.execId === 'number' ? content.execId : undefined;
  } catch {
    return undefined;
  }
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
    const parentConversation = await this.safeFindParentConversation(task.ctx, parentSessionId);
    const parentRunId = this.controlPlaneRunIdOf(parentConversation);
    // A sub-agent dispatched from a loop session inherits the role's frozen harness as an extra
    // compile layer, so delegation caps, sharing and memory restrictions do not reset at the hop.
    const parentRunHarness = parentRunId
      ? await this.safeResolveParentRunHarness(
          parentRunId,
          normalizeString(readValue(parentConversation, 'aiEmployeeUsername')),
        )
      : null;
    const policy = this.compilePolicy(settings, parentRunHarness);
    const spansEnabled = policy.observability.sharing !== 'disabled';

    const subSessionId = normalizeString(task.sessionId) || undefined;
    const employeeUsername = modelUsername(task.employee);
    const userId = currentUserId(task.ctx) || task.ctx?.auth?.user?.id;
    const dispatchToolMessage = await this.resolveDispatchToolMessage(task.ctx, parentSessionId, subSessionId);
    const toolCallId = dispatchToolMessage?.toolCallId;
    const leaderUsername = this.leaderUsernameFor(task.ctx, parentConversation);
    const rootRunId = makeNativeRunId([parentSessionId, subSessionId, toolCallId, employeeUsername]);
    const delegation = await this.resolveDelegationContext(parentSessionId);
    const childDepth = delegation.depth + 1;
    const memory = await this.safeBuildMemoryContext({
      userId,
      aiEmployeeUsername: employeeUsername,
      settings,
    });
    const observedTask: NativeSubAgentTask = {
      ...task,
      // Native dispatch passes the leader conversation's skillSettings to the
      // sub-agent. Clear that inherited filter so plugin-ai resolves tools from
      // the sub-agent employee's own bindings instead.
      skillSettings: undefined,
      question: memory.context ? `${memory.context}\n\n<agent_task>\n${task.question}\n</agent_task>` : task.question,
    };

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
        ...(parentRunId ? { agentLoopRunId: parentRunId } : {}),
      },
      parentSessionId,
      subSessionId,
      toolCallId,
      leaderUsername,
      employeeUsername,
      userId,
      policy,
      toolSpans: new Map(),
      pending: new Set(),
    };

    if (spansEnabled) {
      await this.safeCreateRootSpan(state, task.question, {
        depth: childDepth,
        parentSpanId: delegation.parentSpanId,
        agentLoopRunId: parentRunId,
      });
    }

    // Depth is persisted on the span, not carried in-process, so a resumed child arrives with its
    // true depth. The cap comes from the compiled policy, which includes the inherited parent
    // layer; exceeding it fails the dispatch instead of silently deepening the recursion.
    const maxDepth = policy.delegation.maxDepth;
    if (maxDepth !== null && childDepth > maxDepth) {
      const message = `Sub-agent delegation depth ${childDepth} exceeds the harness limit of ${maxDepth}.`;
      await this.spanService.finish(state.rootSpanId, 'error', state.rootStartedAt, {
        error: message,
        metadata: {
          ...state.rootMetadata,
          failedAt: new Date().toISOString(),
        },
      });
      throw new Error(message);
    }

    const originalWriter = task.writer;
    observedTask.writer = (chunk: Record<string, unknown>) => {
      const pending = this.handleWriterChunk(state, chunk).catch((error) => {
        this.plugin.app.logger?.warn?.('[AgentOrchestrator] Native writer observer failed', error);
      });
      state.pending.add(pending);
      return originalWriter?.(chunk);
    };

    try {
      const rawResult = await runWithAgentExecutionContext(
        {
          rootRunId,
          spanId: state.rootSpanId ? String(state.rootSpanId) : undefined,
          toolCallId,
          leaderUsername,
          employeeUsername,
          sessionId: subSessionId,
        },
        () => this.runWithKnowledgeBaseAgentContext(employeeUsername, () => originalRun(observedTask)),
      );
      const result = this.spillLargeResult(state, rawResult);
      await this.flushPending(state);
      const capturedOutput = this.spanOutput(state, trimText(result, 20000));
      await this.spanService.finish(state.rootSpanId, 'success', state.rootStartedAt, {
        ...(capturedOutput !== undefined ? { output: capturedOutput } : {}),
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
      const capturedError = this.spanOutput(state, trimText(errorMessage(error), 10000));
      await this.spanService.finish(state.rootSpanId, 'error', state.rootStartedAt, {
        ...(capturedError !== undefined ? { error: capturedError } : {}),
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

  // Span payload gates: inputs are captured only under 'full' sharing, outputs under 'full' or
  // 'feedback-only'. Redaction scrubs secret-looking keys on whatever is captured; free text is
  // deliberately left alone.
  private spanInput(state: RunState, input: Record<string, unknown>): Record<string, unknown> | undefined {
    const observability = state.policy.observability;
    if (observability.sharing !== 'full' || !observability.captureInputs) return undefined;
    return observability.redactSecrets ? redactSecretsIn(input) : input;
  }

  private spanOutput(state: RunState, output: unknown): unknown | undefined {
    const observability = state.policy.observability;
    if (observability.sharing === 'disabled' || !observability.captureOutputs) return undefined;
    return observability.redactSecrets ? redactSecretsIn(output) : output;
  }

  // Resolved settings are a raw profile record plus the harnessTag marker; the marker is not a
  // schema field. On any compile trouble fall back to an empty (all-default) harness so the
  // safety defaults — redaction on, sharing full — still govern the spans.
  private compilePolicy(settings: Record<string, unknown>, parentRunHarness: CompiledHarness | null): CompiledHarness {
    const tag =
      typeof settings.harnessTag === 'string' && settings.harnessTag.trim() ? settings.harnessTag.trim() : 'default';
    const { harnessTag: _harnessTag, ...rest } = settings;
    try {
      const layers: HarnessLayer[] = [];
      if (parentRunHarness) {
        // `sources` is a compiler artifact the strict schema rejects, so it is stripped before the
        // compiled parent harness is re-used as a layer. Most-restrictive-wins then carries the
        // parent's delegation caps, sharing mode and memory limits into the child.
        const { sources, ...inherited } = parentRunHarness;
        layers.push({ source: `run-role:${sources.join('+') || 'snapshot'}`, settings: inherited });
      }
      layers.push({ source: `profile:${tag}`, settings: rest });
      return compileHarness(layers);
    } catch (error) {
      this.plugin.app.logger?.warn?.('[AgentOrchestrator] Failed to compile observer harness policy', error);
      return compileHarness([{ source: 'default', settings: {} }]);
    }
  }

  // Oversized sub-agent results are stored on disk and replaced by a head/tail preview plus the
  // file path, so the parent conversation can read the full text back with its file tools.
  // Best effort: a spill failure keeps the original result inline.
  private spillLargeResult(state: RunState, result: string): string {
    const maxInlineBytes = state.policy.context.spill.maxInlineBytes;
    if (!maxInlineBytes || typeof result !== 'string') return result;
    try {
      const spillDir = resolve(process.cwd(), 'storage', 'plugin-agent-orchestrator', 'spills');
      mkdirSync(spillDir, { recursive: true });
      const spillPath = resolve(spillDir, `${state.rootRunId}-${Date.now()}.txt`);
      const replaced = spilledText(result, maxInlineBytes, spillPath);
      if (!replaced) return result;
      writeFileSync(spillPath, result, 'utf8');
      return replaced;
    } catch (error) {
      this.plugin.app.logger?.warn?.('[AgentOrchestrator] Sub-agent result spill failed', error);
      return result;
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

  private async safeCreateRootSpan(
    state: RunState,
    question: string,
    delegationInfo: { depth: number; parentSpanId?: string; agentLoopRunId?: number },
  ) {
    const span = (await this.spanService.create({
      rootRunId: state.rootRunId,
      parentSpanId: delegationInfo.parentSpanId,
      depth: delegationInfo.depth,
      agentLoopRunId: delegationInfo.agentLoopRunId,
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
      input: this.spanInput(state, {
        question,
        parentSessionId: state.parentSessionId,
        subSessionId: state.subSessionId,
      }),
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
    if (state.policy.observability.sharing === 'disabled') return;
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

    const toolName = normalizeString(toolCall.name);
    toolSpan.ready = this.spanService
      .create({
        rootRunId: state.rootRunId,
        parentSpanId: state.rootSpanId ? String(state.rootSpanId) : undefined,
        source: NATIVE_SOURCE,
        parentSessionId: state.parentSessionId || undefined,
        subSessionId: normalizeString(conversation.sessionId) || state.subSessionId || undefined,
        toolCallId,
        type:
          toolName === 'dispatch-sub-agent-task'
            ? 'dispatch'
            : toolName === 'skill_hub_execute' || toolName.startsWith('skill_hub_')
              ? 'skill'
              : 'tool',
        status: 'running',
        leaderUsername: state.leaderUsername,
        employeeUsername: normalizeString(conversation.username) || state.employeeUsername,
        toolName,
        title: toolName || 'tool call',
        input: this.spanInput(state, asObject(toolCall.args)),
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
    const toolName = normalizeString(toolCall.name);
    const skillExecutionId =
      toolName === 'skill_hub_execute' || toolName.startsWith('skill_hub_') ? readSkillExecutionId(result) : undefined;
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
      output: forceError ? undefined : this.spanOutput(state, trimText(output, 20000)),
      error: forceError ? this.spanOutput(state, trimText(errorMessage(error), 10000)) : undefined,
      skillExecutionId,
      metadata: {
        source: NATIVE_SOURCE,
        toolCallResultStatus: result.status,
        invokeStatus: result.invokeStatus,
        messageId: toolCall.messageId,
      },
    });

    if (skillExecutionId && existing.spanId) {
      await this.linkExecutionToSpan(skillExecutionId, existing.spanId);
    }

    await this.tokenTracker.estimateAndTrack(
      existing.spanId,
      normalizeString(toolCall.name),
      typeof output === 'string' ? output : JSON.stringify(output),
    );
  }

  private async linkExecutionToSpan(skillExecutionId: string | number, spanId: string | number) {
    try {
      const repo = this.plugin.db.getRepository('skillExecutions');
      if (!repo) return;
      await repo.update({
        filterByTk: skillExecutionId,
        values: { orchestratorSpanId: spanId },
      });
    } catch (error) {
      this.plugin.app.logger?.warn?.('[AgentOrchestrator] Failed to link skill execution to native span', error);
    }
  }

  private resolveParentSessionId(task: NativeSubAgentTask) {
    const values = task.ctx?.action?.params?.values || {};
    return normalizeString(values.sessionId) || undefined;
  }

  private leaderUsernameFor(ctx: NativeSubAgentTask['ctx'], parentConversation: unknown) {
    const values = ctx?.action?.params?.values || {};
    const direct =
      normalizeString(values.aiEmployeeUsername) ||
      normalizeString((asObject(values.aiEmployee) as Record<string, unknown>).username);
    return direct || normalizeString(readValue(parentConversation, 'aiEmployeeUsername')) || undefined;
  }

  private async safeFindParentConversation(ctx: NativeSubAgentTask['ctx'], parentSessionId?: string) {
    if (!parentSessionId) return null;
    try {
      const repo = ctx.db?.getRepository?.('aiConversations') as
        | { findOne?: (options: Record<string, unknown>) => Promise<unknown> }
        | undefined;
      const conversation = await repo?.findOne?.({ filter: { sessionId: parentSessionId } });
      return conversation || null;
    } catch {
      return null;
    }
  }

  private controlPlaneRunIdOf(conversation: unknown): number | undefined {
    const runId = Number(asObject(readValue(conversation, 'options')).controlPlaneRunId);
    return Number.isSafeInteger(runId) && runId > 0 ? runId : undefined;
  }

  private async safeResolveParentRunHarness(runId: number, parentUsername: string): Promise<CompiledHarness | null> {
    if (!parentUsername) return null;
    try {
      return await resolveRunRoleHarness(this.plugin.db, runId, parentUsername);
    } catch (error) {
      this.plugin.app.logger?.warn?.('[AgentOrchestrator] Failed to resolve parent run harness for delegation', error);
      return null;
    }
  }

  // The parent's persisted span is the authoritative depth source: it was recorded when the
  // parent itself was dispatched, so a resumed child arrives with its true depth even though its
  // in-process context is fresh. The runtime context can only confirm or deepen the count, never
  // lower it.
  private async resolveDelegationContext(parentSessionId?: string): Promise<{ parentSpanId?: string; depth: number }> {
    const candidates: Array<{ id?: string | number; depth?: unknown }> = [];
    const context = getAgentExecutionContext();
    if (context?.spanId) {
      const span = await this.safeFindSpan({ filterByTk: context.spanId });
      if (span) candidates.push(span);
    }
    if (parentSessionId) {
      const span = await this.safeFindSpan({
        filter: { subSessionId: parentSessionId, type: 'sub_agent' },
        sort: ['-id'],
      });
      if (span) candidates.push(span);
    }
    const depth = candidates.reduce((deepest, span) => Math.max(deepest, Number(span.depth) || 0), 0);
    const parentSpanId = candidates.find((span) => span.id !== undefined)?.id;
    return { parentSpanId: parentSpanId === undefined ? undefined : String(parentSpanId), depth };
  }

  private async safeFindSpan(
    options: Record<string, unknown>,
  ): Promise<{ id?: string | number; depth?: unknown } | null> {
    try {
      const repo = this.plugin.db.getRepository('agentExecutionSpans');
      if (!repo || typeof repo.findOne !== 'function') return null;
      return ((await repo.findOne(options)) as { id?: string | number; depth?: unknown } | null) || null;
    } catch (error) {
      this.plugin.app.logger?.warn?.('[AgentOrchestrator] Failed to resolve delegation parent span', error);
      return null;
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
