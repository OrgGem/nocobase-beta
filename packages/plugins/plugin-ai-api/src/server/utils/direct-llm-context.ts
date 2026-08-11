import type { Context } from '@nocobase/actions';

export type ContextOverflowBehavior = 'reject' | 'truncate';

export interface OpenAIMessage {
  role: string;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
  [key: string]: unknown;
}

interface ModelMetadata {
  contextWindow: number;
  maxCompletionTokens: number;
}

interface ContextPreparationOptions {
  serviceName: string;
  modelId: string;
  messages: OpenAIMessage[];
  tools?: unknown;
  maxCompletionTokens?: unknown;
  maxTokens?: unknown;
}

export interface PreparedDirectLlmContext {
  messages: OpenAIMessage[];
  estimatedInputTokens: number;
  inputTokenBudget: number;
  reservedOutputTokens: number;
  truncated: boolean;
}

export class DirectLlmContextError extends Error {
  constructor(
    readonly code:
      | 'context_length_exceeded'
      | 'context_estimation_unsupported'
      | 'max_completion_tokens_exceeds_model_limit'
      | 'model_context_metadata_not_configured',
    message: string,
  ) {
    super(message);
    this.name = 'DirectLlmContextError';
  }
}

function getValue<T>(
  record: { get?: (key: string) => unknown; [key: string]: unknown } | null,
  key: string,
): T | undefined {
  return (record?.get?.(key) as T | undefined) ?? (record?.[key] as T | undefined);
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function hasImageContent(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some(
      (block) => typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'image_url',
    )
  );
}

function estimateValueTokens(value: unknown): number {
  if (value === undefined) return 0;
  return Math.ceil(Buffer.byteLength(JSON.stringify(value), 'utf8') / 3);
}

function estimateMessagesTokens(messages: OpenAIMessage[]): number {
  return messages.reduce((total, message) => total + estimateValueTokens(message) + 4, 0);
}

function containsUnsupportedContent(messages: OpenAIMessage[]): boolean {
  return messages.some((message) => hasImageContent(message.content));
}

function isInstruction(message: OpenAIMessage): boolean {
  return message.role === 'system' || message.role === 'developer';
}

function splitTurns(messages: OpenAIMessage[]): { fixed: OpenAIMessage[]; turns: OpenAIMessage[][] } {
  const fixed: OpenAIMessage[] = [];
  const turns: OpenAIMessage[][] = [];
  let currentTurn: OpenAIMessage[] | undefined;

  for (const message of messages) {
    if (isInstruction(message)) {
      fixed.push(message);
      continue;
    }
    if (message.role === 'user' || !currentTurn) {
      currentTurn = [message];
      turns.push(currentTurn);
      continue;
    }
    currentTurn.push(message);
  }

  return { fixed, turns };
}

function messagesWithTurns(messages: OpenAIMessage[], turns: OpenAIMessage[][]): OpenAIMessage[] {
  const retainedMessages = new Set(turns.flat());
  return messages.filter((message) => isInstruction(message) || retainedMessages.has(message));
}

async function loadModelMetadata(ctx: Context, serviceName: string, modelId: string): Promise<ModelMetadata> {
  const row = await ctx.db.getRepository('aiApiModelMetadata').findOne({
    filter: { llmService: serviceName, model: modelId, enabled: true },
  });
  const contextWindow = positiveInteger(getValue<unknown>(row, 'contextWindow'));
  const maxCompletionTokens = positiveInteger(getValue<unknown>(row, 'maxCompletionTokens'));
  if (!contextWindow || !maxCompletionTokens) {
    throw new DirectLlmContextError(
      'model_context_metadata_not_configured',
      `Context metadata is not configured for '${serviceName}/${modelId}'. Configure context window and max completion tokens.`,
    );
  }
  return { contextWindow, maxCompletionTokens };
}

async function resolveOverflowBehavior(ctx: Context): Promise<ContextOverflowBehavior> {
  const userId = ctx.state.currentUser?.id;
  if (userId === null || userId === undefined) return 'reject';
  const policy = await ctx.db.getRepository('aiApiUserQuotaPolicies').findOne({
    filter: { userId, enabled: true },
  });
  return getValue<unknown>(policy, 'contextOverflowBehavior') === 'truncate' ? 'truncate' : 'reject';
}

function resolveReservedOutputTokens(options: ContextPreparationOptions, metadata: ModelMetadata): number {
  const requested = positiveInteger(options.maxCompletionTokens ?? options.maxTokens);
  if (requested && requested > metadata.maxCompletionTokens) {
    throw new DirectLlmContextError(
      'max_completion_tokens_exceeds_model_limit',
      `Requested max completion tokens (${requested}) exceeds the model limit (${metadata.maxCompletionTokens}).`,
    );
  }
  return requested ?? metadata.maxCompletionTokens;
}

export async function prepareDirectLlmContext(
  ctx: Context,
  options: ContextPreparationOptions,
): Promise<PreparedDirectLlmContext> {
  if (containsUnsupportedContent(options.messages)) {
    throw new DirectLlmContextError(
      'context_estimation_unsupported',
      'Context enforcement does not support image_url content without a model-specific vision token estimator.',
    );
  }

  const [metadata, behavior] = await Promise.all([
    loadModelMetadata(ctx, options.serviceName, options.modelId),
    resolveOverflowBehavior(ctx),
  ]);
  const reservedOutputTokens = resolveReservedOutputTokens(options, metadata);
  const inputTokenBudget = metadata.contextWindow - reservedOutputTokens;
  if (inputTokenBudget <= 0) {
    throw new DirectLlmContextError(
      'context_length_exceeded',
      `The model context window (${metadata.contextWindow}) leaves no input capacity after reserving ${reservedOutputTokens} output tokens.`,
    );
  }

  const fixedOverheadTokens = estimateValueTokens(options.tools) + (options.tools === undefined ? 0 : 4);
  const originalEstimate = estimateMessagesTokens(options.messages) + fixedOverheadTokens;
  if (originalEstimate <= inputTokenBudget) {
    return {
      messages: options.messages,
      estimatedInputTokens: originalEstimate,
      inputTokenBudget,
      reservedOutputTokens,
      truncated: false,
    };
  }

  if (behavior === 'reject') {
    throw new DirectLlmContextError(
      'context_length_exceeded',
      `Estimated input tokens (${originalEstimate}) exceed the allowed input budget (${inputTokenBudget}).`,
    );
  }

  const { turns } = splitTurns(options.messages);
  let remainingTurns = turns;
  let messages = messagesWithTurns(options.messages, remainingTurns);
  let estimatedInputTokens = estimateMessagesTokens(messages) + fixedOverheadTokens;

  while (remainingTurns.length > 1 && estimatedInputTokens > inputTokenBudget) {
    remainingTurns = remainingTurns.slice(1);
    messages = messagesWithTurns(options.messages, remainingTurns);
    estimatedInputTokens = estimateMessagesTokens(messages) + fixedOverheadTokens;
  }

  if (estimatedInputTokens > inputTokenBudget) {
    throw new DirectLlmContextError(
      'context_length_exceeded',
      `The fixed instructions, tools, and newest conversation turn require ${estimatedInputTokens} input tokens, exceeding the allowed budget (${inputTokenBudget}).`,
    );
  }

  return {
    messages,
    estimatedInputTokens,
    inputTokenBudget,
    reservedOutputTokens,
    truncated: messages.length !== options.messages.length,
  };
}
