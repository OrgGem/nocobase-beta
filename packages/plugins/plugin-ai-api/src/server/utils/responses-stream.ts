/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { OpenAIUsage } from './openai-format';
import {
  chatResultToResponse,
  createResponseOutputMessage,
  createResponseReasoningItem,
  extractReasoningText,
  extractResponseIncompleteReason,
  extractResponseOutputText,
  extractResponseServiceTier,
  generateResponseItemId,
  responseIncompleteReason,
  responseUsageFromOpenAIUsage,
  type ResponseFunctionToolCall,
  type ResponseObject,
  type ResponseOutputMessage,
  type ResponseOutputText,
  type ResponseReasoningItem,
} from './responses-format';

export interface ResponseStreamEvent {
  type: string;
  sequence_number: number;
  [key: string]: unknown;
}

interface ToolCallState {
  outputIndex: number;
  item: ResponseFunctionToolCall;
}

export interface ResponseStreamState {
  id: string;
  model: string;
  requestBody: Record<string, unknown>;
  createdAt: number;
  sequenceNumber: number;
  nextOutputIndex: number;
  textItem?: { outputIndex: number; item: ResponseOutputMessage; text: string };
  reasoningItem?: { outputIndex: number; item: ResponseReasoningItem; text: string };
  toolCalls: Map<number, ToolCallState>;
  usage?: OpenAIUsage;
  finishReason?: string;
  serviceTier?: ResponseObject['service_tier'];
}

function event(state: ResponseStreamState, value: Record<string, unknown> & { type: string }): ResponseStreamEvent {
  return { ...value, sequence_number: state.sequenceNumber++ };
}

export function createResponseStreamState(
  id: string,
  model: string,
  requestBody: Record<string, unknown>,
): ResponseStreamState {
  return {
    id,
    model,
    requestBody,
    createdAt: Math.floor(Date.now() / 1000),
    sequenceNumber: 0,
    nextOutputIndex: 0,
    toolCalls: new Map(),
  };
}

function responseSnapshot(state: ResponseStreamState, status: ResponseObject['status']): ResponseObject {
  const content = state.textItem?.text ?? '';
  const reasoningText = state.reasoningItem?.text;
  const toolCalls = [...state.toolCalls.values()].map(({ item }) => ({
    id: item.call_id,
    type: 'function' as const,
    function: { name: item.name, arguments: item.arguments },
  }));
  const response = chatResultToResponse({
    id: state.id,
    model: state.model,
    content,
    reasoningText,
    usage: state.usage,
    toolCalls,
    finishReason: state.finishReason,
    serviceTier: state.serviceTier,
    requestBody: state.requestBody,
    status,
  });

  // Preserve the stable item IDs and the provider emission order clients saw in earlier events.
  const indexedOutput: Array<{ index: number; item: ResponseObject['output'][number] }> = [];
  if (state.reasoningItem) {
    indexedOutput.push({
      index: state.reasoningItem.outputIndex,
      item: {
        ...state.reasoningItem.item,
        status: status === 'in_progress' ? 'in_progress' : status === 'failed' ? 'incomplete' : 'completed',
      },
    });
  }
  if (state.textItem) {
    indexedOutput.push({
      index: state.textItem.outputIndex,
      item: {
        ...state.textItem.item,
        status:
          status === 'in_progress'
            ? 'in_progress'
            : status === 'failed' || responseIncompleteReason(state.finishReason)
              ? 'incomplete'
              : 'completed',
        content: state.textItem.text ? [{ type: 'output_text', text: state.textItem.text, annotations: [] }] : [],
      },
    });
  }
  for (const { item, outputIndex } of state.toolCalls.values()) {
    indexedOutput.push({
      index: outputIndex,
      item: {
        ...item,
        status: status === 'in_progress' ? 'in_progress' : status === 'failed' ? 'incomplete' : 'completed',
      },
    });
  }
  const output = indexedOutput.sort((left, right) => left.index - right.index).map(({ item }) => item);
  response.created_at = state.createdAt;
  response.output = output;
  response.output_text = content;
  response.usage = responseUsageFromOpenAIUsage(state.usage);
  return response;
}

export function createResponseStartEvents(state: ResponseStreamState): ResponseStreamEvent[] {
  return [
    event(state, { type: 'response.created', response: responseSnapshot(state, 'in_progress') }),
    event(state, { type: 'response.in_progress', response: responseSnapshot(state, 'in_progress') }),
  ];
}

function ensureTextItem(state: ResponseStreamState): ResponseStreamEvent[] {
  if (state.textItem) return [];
  const outputIndex = state.nextOutputIndex++;
  const item = createResponseOutputMessage('', 'in_progress', generateResponseItemId('msg'));
  state.textItem = { outputIndex, item, text: '' };
  const part: ResponseOutputText = { type: 'output_text', text: '', annotations: [] };
  return [
    event(state, { type: 'response.output_item.added', output_index: outputIndex, item }),
    event(state, {
      type: 'response.content_part.added',
      item_id: item.id,
      output_index: outputIndex,
      content_index: 0,
      part,
    }),
  ];
}

function ensureReasoningItem(state: ResponseStreamState): ResponseStreamEvent[] {
  if (state.reasoningItem) return [];
  const outputIndex = state.nextOutputIndex++;
  const item = createResponseReasoningItem('');
  item.status = 'in_progress';
  state.reasoningItem = { outputIndex, item, text: '' };
  return [
    event(state, { type: 'response.output_item.added', output_index: outputIndex, item }),
    event(state, {
      type: 'response.content_part.added',
      item_id: item.id,
      output_index: outputIndex,
      content_index: 0,
      part: { type: 'reasoning_text', text: '' },
    }),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function appendToolCallChunks(state: ResponseStreamState, value: unknown): ResponseStreamEvent[] {
  if (!Array.isArray(value)) return [];
  const events: ResponseStreamEvent[] = [];
  for (const [fallbackIndex, raw] of value.entries()) {
    if (!isRecord(raw)) continue;
    const index = typeof raw.index === 'number' ? raw.index : fallbackIndex;
    const functionValue = isRecord(raw.function) ? raw.function : undefined;
    const id = typeof raw.id === 'string' ? raw.id : undefined;
    const name =
      typeof raw.name === 'string'
        ? raw.name
        : typeof functionValue?.name === 'string'
          ? functionValue.name
          : undefined;
    const argumentsDelta =
      typeof raw.args === 'string'
        ? raw.args
        : typeof functionValue?.arguments === 'string'
          ? functionValue.arguments
          : raw.args === undefined
            ? ''
            : JSON.stringify(raw.args);

    let call = state.toolCalls.get(index);
    if (!call) {
      const callId = id ?? generateResponseItemId('fc');
      const item: ResponseFunctionToolCall = {
        id: generateResponseItemId('fc'),
        type: 'function_call',
        status: 'in_progress',
        call_id: callId,
        name: name ?? '',
        arguments: '',
      };
      call = { outputIndex: state.nextOutputIndex++, item };
      state.toolCalls.set(index, call);
      events.push(event(state, { type: 'response.output_item.added', output_index: call.outputIndex, item }));
    }
    if (name) call.item.name = name;
    // Provider chunks may carry the real call id only in a later delta — keep it in sync so
    // tool results submitted against the streamed id match the stored item.
    if (id) call.item.call_id = id;
    if (argumentsDelta) {
      call.item.arguments += argumentsDelta;
      events.push(
        event(state, {
          type: 'response.function_call_arguments.delta',
          item_id: call.item.id,
          output_index: call.outputIndex,
          delta: argumentsDelta,
        }),
      );
    }
  }
  return events;
}

export function appendResponseStreamChunk(state: ResponseStreamState, chunk: unknown): ResponseStreamEvent[] {
  if (!isRecord(chunk)) return [];
  const events: ResponseStreamEvent[] = [];
  const reasoningDelta = extractReasoningText(chunk);
  if (reasoningDelta) {
    events.push(...ensureReasoningItem(state));
    const reasoning = state.reasoningItem as NonNullable<ResponseStreamState['reasoningItem']>;
    reasoning.text += reasoningDelta;
    reasoning.item.content = [{ type: 'reasoning_text', text: reasoning.text }];
    events.push(
      event(state, {
        type: 'response.reasoning_text.delta',
        item_id: reasoning.item.id,
        output_index: reasoning.outputIndex,
        content_index: 0,
        delta: reasoningDelta,
      }),
    );
  }

  const content = extractResponseOutputText(chunk);
  if (content) {
    events.push(...ensureTextItem(state));
    const text = state.textItem as NonNullable<ResponseStreamState['textItem']>;
    text.text += content;
    text.item.content = [{ type: 'output_text', text: text.text, annotations: [] }];
    events.push(
      event(state, {
        type: 'response.output_text.delta',
        item_id: text.item.id,
        output_index: text.outputIndex,
        content_index: 0,
        delta: content,
        logprobs: [],
      }),
    );
  }

  events.push(...appendToolCallChunks(state, chunk.tool_call_chunks));
  const finishReason = [chunk.response_metadata, chunk.additional_kwargs]
    .filter(isRecord)
    .map((metadata) => metadata.finish_reason)
    .find((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);
  const incompleteReason = extractResponseIncompleteReason(chunk);
  if (finishReason || incompleteReason) state.finishReason = finishReason ?? incompleteReason;
  state.serviceTier = state.serviceTier ?? extractResponseServiceTier(chunk);
  return events;
}

export function setResponseStreamUsage(state: ResponseStreamState, usage: OpenAIUsage | undefined): void {
  if (usage) state.usage = usage;
}

export function finalizeResponseStream(state: ResponseStreamState): ResponseStreamEvent[] {
  const events: ResponseStreamEvent[] = [];
  const incompleteReason = responseIncompleteReason(state.finishReason);
  if (state.reasoningItem) {
    const { item, outputIndex, text } = state.reasoningItem;
    item.status = 'completed';
    events.push(
      event(state, {
        type: 'response.reasoning_text.done',
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        text,
      }),
      event(state, {
        type: 'response.content_part.done',
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        part: { type: 'reasoning_text', text },
      }),
      event(state, { type: 'response.output_item.done', output_index: outputIndex, item }),
    );
  }
  if (state.textItem) {
    const { item, outputIndex, text } = state.textItem;
    item.status = incompleteReason ? 'incomplete' : 'completed';
    const part: ResponseOutputText = { type: 'output_text', text, annotations: [] };
    item.content = [part];
    events.push(
      event(state, {
        type: 'response.output_text.done',
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        text,
        logprobs: [],
      }),
      event(state, {
        type: 'response.content_part.done',
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        part,
      }),
      event(state, { type: 'response.output_item.done', output_index: outputIndex, item }),
    );
  }
  for (const { item, outputIndex } of state.toolCalls.values()) {
    item.status = 'completed';
    events.push(
      event(state, {
        type: 'response.function_call_arguments.done',
        item_id: item.id,
        output_index: outputIndex,
        name: item.name,
        arguments: item.arguments,
      }),
      event(state, { type: 'response.output_item.done', output_index: outputIndex, item }),
    );
  }
  const response = responseSnapshot(state, incompleteReason ? 'incomplete' : 'completed');
  events.push(
    event(state, { type: response.status === 'incomplete' ? 'response.incomplete' : 'response.completed', response }),
  );
  return events;
}

export function createResponseErrorEvent(
  state: ResponseStreamState,
  error: { message: string; code?: string },
): ResponseStreamEvent {
  return event(state, {
    type: 'error',
    code: error.code ?? 'server_error',
    message: error.message,
    param: null,
  });
}

export function createResponseFailedEvent(
  state: ResponseStreamState,
  error: { message: string; code?: string },
): ResponseStreamEvent {
  const response = responseSnapshot(state, 'failed');
  response.error = { code: error.code ?? 'server_error', message: error.message };
  response.completed_at = null;
  return event(state, { type: 'response.failed', response });
}
