// SPDX-License-Identifier: Apache-2.0

export const SIGNED_CONTEXT_KEY = '__custom_llm_signed_context';

type JsonRecord = Record<string, unknown>;

export type SignedContextScope = {
  service: string;
  model: string;
  sessionId?: string;
};

type SignedToolCall = {
  id: string;
  originalId?: string;
  providerSpecificFields?: JsonRecord;
  extraContent?: JsonRecord;
};

type SignedContext = SignedContextScope & {
  version: 1;
  toolCalls: SignedToolCall[];
  thinkingBlocks?: JsonRecord[];
};

type AccumulatedToolCall = {
  id: string;
  name: string;
  arguments: string;
  providerSpecificFields?: JsonRecord;
  extraContent?: JsonRecord;
};

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function shortToolCallId(id: string): string {
  const suffixIndex = id.indexOf('__thought__');
  return suffixIndex < 0 ? id : id.slice(0, suffixIndex);
}

// SSE tool-call and thinking-block fields are deltas. Merge fragments within their
// original index, retaining their order and all provider-specific fields.
function mergeFragments(target: JsonRecord, fragment: JsonRecord): void {
  for (const [key, value] of Object.entries(fragment)) {
    if (key === 'index' || key === '__proto__' || key === 'constructor' || key === 'prototype' || value == null) {
      continue;
    }
    const existing = target[key];
    if (typeof value === 'string' && typeof existing === 'string') {
      target[key] = key === 'type' ? existing : existing + value;
    } else if (isRecord(value) && isRecord(existing)) {
      mergeFragments(existing, value);
    } else if (isRecord(value)) {
      const nested: JsonRecord = {};
      mergeFragments(nested, value);
      target[key] = nested;
    } else if (existing === undefined) {
      target[key] = value;
    }
  }
}

export class SignedStreamAccumulator {
  private readonly calls = new Map<number, AccumulatedToolCall>();
  private readonly blocks = new Map<number, JsonRecord>();
  private currentUnindexedBlock?: number;
  private nextBlockIndex = 0;

  addToolCalls(value: unknown): void {
    if (!Array.isArray(value)) return;
    value.forEach((entry, position) => {
      if (!isRecord(entry)) return;
      const index = typeof entry.index === 'number' ? entry.index : position;
      const current = this.calls.get(index) ?? { id: '', name: '', arguments: '' };
      if (typeof entry.id === 'string') current.id += entry.id;
      if (isRecord(entry.function)) {
        if (typeof entry.function.name === 'string') current.name += entry.function.name;
        if (typeof entry.function.arguments === 'string') current.arguments += entry.function.arguments;
      }
      if (isRecord(entry.provider_specific_fields)) {
        current.providerSpecificFields ??= {};
        mergeFragments(current.providerSpecificFields, entry.provider_specific_fields);
      }
      if (isRecord(entry.extra_content)) {
        current.extraContent ??= {};
        mergeFragments(current.extraContent, entry.extra_content);
      }
      this.calls.set(index, current);
    });
  }

  addThinkingBlocks(value: unknown): void {
    if (!Array.isArray(value)) return;
    value.forEach((entry, position) => {
      if (!isRecord(entry)) return;
      let index: number;
      if (typeof entry.index === 'number') {
        index = entry.index;
        this.nextBlockIndex = Math.max(this.nextBlockIndex, index + 1);
        this.currentUnindexedBlock = undefined;
      } else {
        const previous =
          this.currentUnindexedBlock === undefined ? undefined : this.blocks.get(this.currentUnindexedBlock);
        const typeChanged = previous?.type && entry.type && previous.type !== entry.type;
        const startsNewThinking =
          previous?.signature && typeof entry.thinking === 'string' && entry.thinking.length > 0;
        const startsRedactedBlock = previous?.type === 'redacted_thinking' && entry.type === 'redacted_thinking';
        if (
          position > 0 ||
          this.currentUnindexedBlock === undefined ||
          typeChanged ||
          startsNewThinking ||
          startsRedactedBlock
        ) {
          this.currentUnindexedBlock = this.nextBlockIndex++;
        }
        index = this.currentUnindexedBlock;
      }
      const block = this.blocks.get(index) ?? {};
      mergeFragments(block, entry);
      this.blocks.set(index, block);
    });
  }

  result(scope: SignedContextScope): { toolCallChunks: JsonRecord[]; signedContext?: SignedContext } {
    const orderedCalls = Array.from(this.calls.entries()).sort(([a], [b]) => a - b);
    const toolCallChunks = orderedCalls.map(([index, call]) => ({
      type: 'tool_call_chunk',
      index,
      id: shortToolCallId(call.id),
      name: call.name,
      args: call.arguments,
    }));
    const toolCalls = orderedCalls.flatMap(([, call]) => {
      const id = shortToolCallId(call.id);
      if (id === call.id && !call.providerSpecificFields && !call.extraContent) return [];
      return [
        {
          id,
          ...(id !== call.id ? { originalId: call.id } : {}),
          ...(call.providerSpecificFields ? { providerSpecificFields: call.providerSpecificFields } : {}),
          ...(call.extraContent ? { extraContent: call.extraContent } : {}),
        },
      ];
    });
    const thinkingBlocks = Array.from(this.blocks.entries())
      .sort(([a], [b]) => a - b)
      .map(([, block]) => block);
    const signedContext =
      toolCalls.length || thinkingBlocks.length
        ? { version: 1 as const, ...scope, toolCalls, ...(thinkingBlocks.length ? { thinkingBlocks } : {}) }
        : undefined;
    return { toolCallChunks, signedContext };
  }
}

export function prepareSignedMessage(
  message: JsonRecord,
  scope: SignedContextScope,
): { message: JsonRecord; signedContext?: SignedContext } {
  const accumulator = new SignedStreamAccumulator();
  accumulator.addToolCalls(message.tool_calls);
  const providerFields = isRecord(message.provider_specific_fields) ? message.provider_specific_fields : undefined;
  accumulator.addThinkingBlocks(message.thinking_blocks ?? providerFields?.thinking_blocks);
  const { signedContext } = accumulator.result(scope);
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map((entry) => {
        if (!isRecord(entry)) return entry;
        const { provider_specific_fields: _providerSpecificFields, extra_content: _extraContent, ...toolCall } = entry;
        return { ...toolCall, id: typeof toolCall.id === 'string' ? shortToolCallId(toolCall.id) : toolCall.id };
      })
    : message.tool_calls;
  return { message: { ...message, tool_calls: toolCalls }, signedContext };
}

type HistoryMessage = {
  getType?: () => string;
  _getType?: () => string;
  role?: string;
  tool_calls?: Array<{ id?: string; name?: string }>;
  additional_kwargs?: JsonRecord;
};

export type RequestMessageContext = {
  toolCallIds: string[];
  reasoningContent?: string;
  signedContext?: SignedContext;
};

// LangChain converts message objects to OpenAI payloads before completionWithRetry.
// Keep metadata by assistant-message position instead of global tool-call IDs.
export function collectRequestMessageContexts(
  messages: HistoryMessage[],
  scope: SignedContextScope,
  enableReasoning: boolean,
): Array<RequestMessageContext | undefined> {
  return messages.map((message) => {
    const type = message.getType?.() ?? message._getType?.() ?? message.role;
    if (type !== 'ai' && type !== 'assistant') return undefined;
    const kwargs = message.additional_kwargs ?? {};
    const stored = kwargs[SIGNED_CONTEXT_KEY];
    let signedContext: SignedContext | undefined;
    if (
      isRecord(stored) &&
      stored.version === 1 &&
      stored.service === scope.service &&
      stored.model === scope.model &&
      (!stored.sessionId || stored.sessionId === scope.sessionId) &&
      Array.isArray(stored.toolCalls)
    ) {
      signedContext = stored as unknown as SignedContext;
    } else if (!stored && Array.isArray(kwargs.tool_calls)) {
      const legacy = prepareSignedMessage({ tool_calls: kwargs.tool_calls }, scope).signedContext;
      if (legacy?.toolCalls.length) signedContext = legacy;
    }
    const reasoningContent =
      enableReasoning && typeof kwargs.reasoning_content === 'string' ? kwargs.reasoning_content : undefined;
    const toolCallIds = (message.tool_calls ?? []).flatMap((call) =>
      typeof call.id === 'string' ? [shortToolCallId(call.id)] : [],
    );
    return reasoningContent || signedContext ? { toolCallIds, reasoningContent, signedContext } : undefined;
  });
}

export function restoreRequestMessageContexts(request: JsonRecord, contexts: Array<RequestMessageContext | undefined>) {
  if (!Array.isArray(request.messages)) return;
  let ids = new Map<string, string>();
  const usedContexts = new Set<number>();
  for (const [index, message] of request.messages.entries()) {
    if (!isRecord(message)) continue;
    if (message.role === 'assistant') {
      ids = new Map();
      const messageIds = Array.isArray(message.tool_calls)
        ? message.tool_calls.flatMap((call) =>
            isRecord(call) && typeof call.id === 'string' ? [shortToolCallId(call.id)] : [],
          )
        : [];
      const sameToolCalls = (context: RequestMessageContext | undefined) =>
        context?.toolCallIds.length === messageIds.length &&
        context.toolCallIds.every((id, position) => id === messageIds[position]);
      let contextIndex = index;
      if (usedContexts.has(contextIndex) || !sameToolCalls(contexts[contextIndex])) {
        contextIndex = messageIds.length
          ? contexts.findIndex((context, candidate) => !usedContexts.has(candidate) && sameToolCalls(context))
          : -1;
      }
      const context = contexts[contextIndex];
      if (!context) continue;
      usedContexts.add(contextIndex);
      if (context.reasoningContent && Array.isArray(message.tool_calls) && !message.reasoning_content) {
        message.reasoning_content = context.reasoningContent;
      }
      if (context.signedContext?.thinkingBlocks?.length) {
        message.thinking_blocks = context.signedContext.thinkingBlocks;
      }
      if (!Array.isArray(message.tool_calls)) continue;
      for (const call of message.tool_calls) {
        if (!isRecord(call) || typeof call.id !== 'string') continue;
        const original = context.signedContext?.toolCalls.find((item) => item.id === call.id);
        if (!original) continue;
        if (original.originalId) {
          ids.set(call.id, original.originalId);
          call.id = original.originalId;
        }
        if (original.providerSpecificFields) call.provider_specific_fields = original.providerSpecificFields;
        if (original.extraContent) call.extra_content = original.extraContent;
      }
    } else if (message.role === 'tool' && typeof message.tool_call_id === 'string') {
      message.tool_call_id = ids.get(message.tool_call_id) ?? message.tool_call_id;
    } else {
      ids = new Map();
    }
  }
}
