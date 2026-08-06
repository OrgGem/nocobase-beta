import type { Context } from '@nocobase/actions';

interface ObservationFinish {
  status: 'succeeded' | 'failed' | 'cancelled' | 'rejected';
  errorCode?: string;
  inputTokens?: number;
  outputTokens?: number;
}
interface ObservationHandle {
  markFirstByte(): void;
  addInputTokens(value: number): void;
  addOutputTokens(value: number): void;
  finish(result: ObservationFinish): void;
}
interface AppObservabilityContract {
  start(input: {
    service: string;
    operation: string;
    streaming?: boolean;
    attributes?: Record<string, string | number | boolean | null>;
  }): ObservationHandle;
}
interface AiApiObservabilityState {
  aiApiObservabilityHandle?: ObservationHandle;
  aiApiObservabilityOutcome?: ObservationFinish;
}

const CONTRACT_SYMBOL = Symbol.for('nocobase.app-observability.contract');
const NOOP_HANDLE: ObservationHandle = {
  markFirstByte() {},
  addInputTokens() {},
  addOutputTokens() {},
  finish() {},
};

function state(ctx: Context): AiApiObservabilityState {
  return ctx.state as AiApiObservabilityState;
}

function safely(ctx: Context, callback: () => void): void {
  try {
    callback();
  } catch (error) {
    ctx.app?.logger?.warn?.('[ai-api] App observability callback failed', { error });
  }
}

export function startAiApiObservation(
  ctx: Context,
  input: {
    service: 'llm.chat' | 'llm.agent' | 'llm.completion' | 'llm.embedding';
    operation: string;
    streaming: boolean;
    model?: string;
    mode: 'llm' | 'agent';
  },
): void {
  let handle = NOOP_HANDLE;
  safely(ctx, () => {
    const contract = (ctx.app as object & { [CONTRACT_SYMBOL]?: AppObservabilityContract })[CONTRACT_SYMBOL];
    if (!contract || typeof contract.start !== 'function') return;
    const candidate = contract.start({
      service: input.service,
      operation: input.operation,
      streaming: input.streaming,
      attributes: {
        mode: input.mode,
        endpoint: input.operation,
        ...(input.model ? { model: input.model } : {}),
      },
    });
    if (candidate && typeof candidate.finish === 'function') handle = candidate;
  });
  state(ctx).aiApiObservabilityHandle = handle;
}

export function markAiApiFirstProviderOutput(ctx: Context): void {
  safely(ctx, () => state(ctx).aiApiObservabilityHandle?.markFirstByte());
}

export function addAiApiUsage(
  ctx: Context,
  usage?: { prompt_tokens: number | null; completion_tokens: number | null },
): void {
  if (!usage) return;
  safely(ctx, () => {
    const handle = state(ctx).aiApiObservabilityHandle;
    if (usage.prompt_tokens !== null) handle?.addInputTokens(usage.prompt_tokens);
    if (usage.completion_tokens !== null) handle?.addOutputTokens(usage.completion_tokens);
  });
}

export function setAiApiObservationOutcome(ctx: Context, outcome: ObservationFinish): void {
  state(ctx).aiApiObservabilityOutcome = outcome;
}

export function finishAiApiObservation(ctx: Context, fallback: ObservationFinish): void {
  const current = state(ctx);
  const handle = current.aiApiObservabilityHandle;
  if (!handle) return;
  current.aiApiObservabilityHandle = undefined;
  const outcome = current.aiApiObservabilityOutcome ?? fallback;
  current.aiApiObservabilityOutcome = undefined;
  safely(ctx, () => handle.finish(outcome));
}
