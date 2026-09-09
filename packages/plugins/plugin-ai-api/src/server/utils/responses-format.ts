/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import crypto from 'crypto';
import type { OpenAIMessage } from './direct-llm-context';
import type { OpenAIToolCall, OpenAIUsage } from './openai-format';

export type ResponseStatus = 'completed' | 'failed' | 'in_progress' | 'cancelled' | 'queued' | 'incomplete';
export type ResponseItemStatus = 'in_progress' | 'completed' | 'incomplete';
export type ResponseServiceTier = 'auto' | 'default' | 'flex' | 'scale' | 'priority';

export interface ResponseOutputTextFileCitation {
  type: 'file_citation';
  file_id: string;
  filename: string;
  index: number;
}

export interface ResponseOutputTextURLCitation {
  type: 'url_citation';
  end_index: number;
  start_index: number;
  title: string;
  url: string;
}

export interface ResponseOutputTextContainerFileCitation {
  type: 'container_file_citation';
  container_id: string;
  end_index: number;
  file_id: string;
  filename: string;
  start_index: number;
}

export interface ResponseOutputTextFilePath {
  type: 'file_path';
  file_id: string;
  index: number;
}

export type ResponseOutputTextAnnotation =
  | ResponseOutputTextFileCitation
  | ResponseOutputTextURLCitation
  | ResponseOutputTextContainerFileCitation
  | ResponseOutputTextFilePath;

export interface ResponseOutputTextTopLogprob {
  token: string;
  bytes: number[];
  logprob: number;
}

export interface ResponseOutputTextLogprob {
  token: string;
  bytes: number[];
  logprob: number;
  top_logprobs: ResponseOutputTextTopLogprob[];
}

export interface ResponseOutputText {
  type: 'output_text';
  text: string;
  annotations: ResponseOutputTextAnnotation[];
  logprobs?: ResponseOutputTextLogprob[];
}

export interface ResponseOutputMessage {
  id: string;
  type: 'message';
  status: ResponseItemStatus;
  role: 'assistant';
  content: ResponseOutputText[];
  phase?: 'commentary' | 'final_answer' | null;
}

export interface ResponseFunctionToolCall {
  id: string;
  type: 'function_call';
  status: ResponseItemStatus;
  call_id: string;
  name: string;
  arguments: string;
}

export interface ResponseReasoningItem {
  id: string;
  type: 'reasoning';
  status: ResponseItemStatus;
  summary: Array<{ type: 'summary_text'; text: string }>;
  content?: Array<{ type: 'reasoning_text'; text: string }>;
}

export type ResponseOutputItem = ResponseOutputMessage | ResponseFunctionToolCall | ResponseReasoningItem;

export interface ResponseUsage {
  input_tokens: number;
  input_tokens_details: { cached_tokens: number };
  output_tokens: number;
  output_tokens_details: { reasoning_tokens: number };
  total_tokens: number;
}

export interface ResponseObject {
  id: string;
  object: 'response';
  created_at: number;
  completed_at?: number | null;
  status: ResponseStatus;
  error: {
    code:
      | 'server_error'
      | 'rate_limit_exceeded'
      | 'invalid_prompt'
      | 'vector_store_timeout'
      | 'invalid_image'
      | 'invalid_image_format'
      | 'invalid_base64_image'
      | 'invalid_image_url'
      | 'image_too_large'
      | 'image_too_small'
      | 'image_parse_error'
      | 'image_content_policy_violation'
      | 'invalid_image_mode'
      | 'image_file_too_large'
      | 'unsupported_image_media_type'
      | 'empty_image_file'
      | 'failed_to_download_image'
      | 'image_file_not_found';
    message: string;
  } | null;
  incomplete_details: { reason: 'max_output_tokens' | 'content_filter' } | null;
  instructions: string | null;
  max_output_tokens?: number | null;
  model: string;
  output: ResponseOutputItem[];
  output_text: string;
  parallel_tool_calls: boolean;
  previous_response_id?: string | null;
  prompt_cache_key?: string;
  prompt_cache_retention?: 'in_memory' | '24h' | null;
  reasoning?: Record<string, unknown> | null;
  safety_identifier?: string;
  service_tier: ResponseServiceTier;
  temperature: number | null;
  text?: {
    format?:
      | { type: 'text' }
      | { type: 'json_object' }
      | { type: 'json_schema'; name: string; schema: Record<string, unknown>; description?: string; strict?: boolean | null };
    verbosity?: 'low' | 'medium' | 'high';
  } | undefined;
  tool_choice:
    | 'none'
    | 'auto'
    | 'required'
    | { type: 'allowed_tools'; mode: 'auto' | 'required'; tools: Array<Record<string, unknown>> }
    | { type: 'function'; name: string }
    | { type: 'mcp'; server_label: string; name?: string | null }
    | { type: 'custom'; name: string }
    | { type: 'apply_patch' }
    | { type: 'shell' }
    | {
        type:
          | 'file_search'
          | 'web_search_preview'
          | 'computer'
          | 'computer_use_preview'
          | 'computer_use'
          | 'web_search_preview_2025_03_11'
          | 'image_generation'
          | 'code_interpreter'
          | 'mcp';
      };
  tools: Array<
    | { type: 'function'; name: string; parameters: Record<string, unknown> | null; strict: boolean | null; description?: string }
    | { type: 'file_search'; vector_store_ids: string[]; max_num_results?: number }
    | {
        type: 'web_search_preview';
        user_location?: { type: 'approximate'; city?: string | null; country?: string | null; region?: string | null; timezone?: string | null } | null;
        search_context_size?: 'low' | 'medium' | 'high';
      }
    | { type: 'computer_use_preview'; display_width: number; display_height: number; environment: 'windows' | 'mac' | 'linux' | 'ubuntu' | 'browser' }
    | { type: 'code_interpreter'; container: string | { type: 'auto'; file_ids?: string[]; memory_limit?: '1g' | '4g' | '16g' | '64g' | null } }
    | { type: 'mcp'; server_label: string; server_url?: string }
    | {
        type: 'image_generation';
        size?: string;
        quality?: 'auto' | 'low' | 'medium' | 'high';
        output_format?: 'png' | 'webp' | 'jpeg';
        action?: 'generate' | 'edit' | 'auto';
        background?: 'transparent' | 'opaque' | 'auto';
      }
    | { type: 'custom'; name: string; description?: string; format?: { type: 'text' } | { type: 'grammar'; definition: string; syntax: 'lark' | 'regex' }; defer_loading?: boolean }
    | { type: 'shell' }
    | { type: 'apply_patch' }
  >;
  top_p: number | null;
  truncation: 'auto' | 'disabled';
  usage: ResponseUsage;
  user?: string;
  metadata: Record<string, string> | null;
}

export interface ResponseResultParts {
  content: string;
  reasoningText?: string;
  usage?: OpenAIUsage;
  toolCalls?: OpenAIToolCall[];
  finishReason?: string;
  serviceTier?: ResponseServiceTier;
}

export function generateResponseId(): string {
  return `resp_${crypto.randomBytes(16).toString('hex')}`;
}

export function generateResponseItemId(prefix: 'msg' | 'fc' | 'rs' = 'msg'): string {
  return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function responseImageToChatBlock(block: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof block.image_url !== 'string' || !block.image_url) return null;
  return {
    type: 'image_url',
    image_url: {
      url: block.image_url,
      ...(typeof block.detail === 'string' ? { detail: block.detail } : {}),
    },
  };
}

function responseFileToChatBlock(block: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof block.file_data === 'string' && block.file_data) {
    return {
      type: 'file',
      file: {
        file_data: block.file_data,
        ...(typeof block.filename === 'string' ? { filename: block.filename } : {}),
      },
    };
  }
  if (typeof block.file_url === 'string' && block.file_url) {
    return { type: 'file_url', file_url: { url: block.file_url } };
  }
  return null;
}

function responseContentToChatContent(content: unknown): unknown {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content;

  return content.flatMap((block): unknown[] => {
    if (typeof block === 'string') return [{ type: 'text', text: block }];
    if (!isRecord(block)) return [];
    if ((block.type === 'input_text' || block.type === 'output_text') && typeof block.text === 'string') {
      return [{ type: 'text', text: block.text }];
    }
    if (block.type === 'input_image') {
      const converted = responseImageToChatBlock(block);
      return converted ? [converted] : [];
    }
    if (block.type === 'input_file') {
      const converted = responseFileToChatBlock(block);
      return converted ? [converted] : [];
    }
    if (block.type === 'text' || block.type === 'image_url' || block.type === 'file' || block.type === 'file_url') {
      return [block];
    }
    return [];
  });
}

function messageItemToChatMessage(item: Record<string, unknown>): OpenAIMessage | null {
  const role = typeof item.role === 'string' ? item.role : undefined;
  if (!role) return null;
  return {
    role,
    content: responseContentToChatContent(item.content),
    ...(typeof item.phase === 'string' ? { phase: item.phase } : {}),
  };
}

function functionCallToChatMessage(item: Record<string, unknown>): OpenAIMessage | null {
  if (typeof item.call_id !== 'string' || typeof item.name !== 'string') return null;
  return {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: item.call_id,
        type: 'function',
        function: {
          name: item.name,
          arguments: typeof item.arguments === 'string' ? item.arguments : '{}',
        },
      },
    ],
  };
}

function appendFunctionCall(messages: OpenAIMessage[], item: Record<string, unknown>): boolean {
  const message = functionCallToChatMessage(item);
  if (!message) return false;
  const previous = messages.at(-1);
  const previousAdditional = isRecord(previous?.additional_kwargs) ? (previous as OpenAIMessage).additional_kwargs as Record<string, unknown> : {} as Record<string, unknown>;
  const hasReasoning =
    typeof previousAdditional.reasoning_content === 'string' || isRecord(previousAdditional.reasoning);
  if (
    previous?.role !== 'assistant' ||
    previous.content !== '' ||
    ((!Array.isArray(previous.tool_calls) || previous.tool_calls.length === 0) && !hasReasoning)
  ) {
    messages.push(message);
    return true;
  }

  const previousCalls = Array.isArray(previous.tool_calls) ? previous.tool_calls : [];
  const nextCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  previous.tool_calls = [...previousCalls, ...nextCalls];
  previous.additional_kwargs = {
    ...(isRecord(previous.additional_kwargs) ? previous.additional_kwargs : {}),
    tool_calls: previous.tool_calls,
  };
  const responseMetadata = isRecord(previous.response_metadata) ? previous.response_metadata : {};
  const output = Array.isArray(responseMetadata.output) ? responseMetadata.output : [];
  previous.response_metadata = { ...responseMetadata, output: [...output, item] };
  return true;
}

function reasoningToChatMessage(item: Record<string, unknown>): OpenAIMessage {
  const summary = Array.isArray(item.summary)
    ? item.summary
        .filter((part): part is Record<string, unknown> => isRecord(part) && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n')
    : '';
  const content = Array.isArray(item.content)
    ? item.content
        .filter((part): part is Record<string, unknown> => isRecord(part) && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n')
    : '';
  return {
    role: 'assistant',
    content: '',
    additional_kwargs: {
      reasoning_content: content || summary,
      reasoning: item,
    },
    response_metadata: { output: [item] },
  };
}

function appendReasoningItem(messages: OpenAIMessage[], item: Record<string, unknown>): void {
  const previous = messages.at(-1);
  if (previous?.role === 'assistant' && previous.content === '') {
    const reasoning = reasoningToChatMessage(item);
    previous.additional_kwargs = {
      ...(isRecord(previous.additional_kwargs) ? previous.additional_kwargs : {}),
      ...(isRecord(reasoning.additional_kwargs) ? reasoning.additional_kwargs : {}),
    };
    const responseMetadata = isRecord(previous.response_metadata) ? previous.response_metadata : {};
    const output = Array.isArray(responseMetadata.output) ? responseMetadata.output : [];
    previous.response_metadata = { ...responseMetadata, output: [...output, item] };
    return;
  }
  messages.push(reasoningToChatMessage(item));
}
function functionCallOutputToChatMessage(item: Record<string, unknown>): OpenAIMessage | null {
  if (typeof item.call_id !== 'string') return null;
  return {
    role: 'tool',
    content: responseContentToChatContent(item.output),
    tool_call_id: item.call_id,
  };
}

export function responsesInputToMessages(input: unknown, instructions?: unknown): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];
  if (typeof instructions === 'string' && instructions) {
    messages.push({ role: 'developer', content: instructions });
  }

  if (typeof input === 'string') return [...messages, { role: 'user', content: input }];
  if (!Array.isArray(input)) return messages;

  for (const item of input) {
    if (!isRecord(item)) continue;
    if (item.type === 'function_call') {
      appendFunctionCall(messages, item);
      continue;
    }
    if (item.type === 'reasoning') {
      appendReasoningItem(messages, item);
      continue;
    }
    let message: OpenAIMessage | null = null;
    if (item.type === 'function_call_output') message = functionCallOutputToChatMessage(item);
    else if (item.type === 'message' || typeof item.role === 'string') message = messageItemToChatMessage(item);
    if (message) messages.push(message);
  }
  return messages;
}

function responseFunctionToolToChatTool(tool: Record<string, unknown>): Record<string, unknown> | null {
  if (tool.type !== 'function' || typeof tool.name !== 'string') return null;
  return {
    type: 'function',
    function: {
      name: tool.name,
      ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
      parameters: isRecord(tool.parameters) ? tool.parameters : {},
      ...(typeof tool.strict === 'boolean' ? { strict: tool.strict } : {}),
    },
  };
}

export function responsesToolsToChatTools(tools: unknown): unknown[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  return tools.flatMap((tool) => {
    if (!isRecord(tool)) return [];
    const converted = responseFunctionToolToChatTool(tool);
    return converted ? [converted] : [];
  });
}

function responsesToolChoiceToChatToolChoice(toolChoice: unknown): unknown {
  if (!isRecord(toolChoice) || toolChoice.type !== 'function' || typeof toolChoice.name !== 'string') {
    return toolChoice;
  }
  return { type: 'function', function: { name: toolChoice.name } };
}

export function responsesBodyToChatBody(body: Record<string, unknown>): Record<string, unknown> {
  const chatBody: Record<string, unknown> = {
    model: body.model,
    messages: responsesInputToMessages(body.input, body.instructions),
  };

  if (body.temperature !== undefined) chatBody.temperature = body.temperature;
  if (body.top_p !== undefined) chatBody.top_p = body.top_p;
  if (body.max_output_tokens !== undefined) chatBody.max_completion_tokens = body.max_output_tokens;
  const tools = responsesToolsToChatTools(body.tools);
  if (tools) chatBody.tools = tools;
  if (body.tool_choice !== undefined) chatBody.tool_choice = responsesToolChoiceToChatToolChoice(body.tool_choice);
  if (body.stream !== undefined) chatBody.stream = body.stream;
  if (body.service_tier !== undefined && body.service_tier !== null) chatBody.service_tier = body.service_tier;
  if (body.prompt_cache_key !== undefined) chatBody.promptCacheKey = body.prompt_cache_key;
  if (body.prompt_cache_retention !== undefined && body.prompt_cache_retention !== null) {
    chatBody.promptCacheRetention = body.prompt_cache_retention;
  }
  if (body.reasoning !== undefined && body.reasoning !== null) chatBody.reasoning = body.reasoning;
  if (body.safety_identifier !== undefined) chatBody.safety_identifier = body.safety_identifier;
  if (body.text !== undefined) {
    if (isRecord(body.text)) {
      if (body.text.format !== undefined) chatBody.response_format = responsesTextFormatToChatFormat(body.text.format);
      if (body.text.verbosity !== undefined) chatBody.verbosity = body.text.verbosity;
    }
  }
  if (body.parallel_tool_calls !== undefined && body.parallel_tool_calls !== null) {
    chatBody.parallel_tool_calls = body.parallel_tool_calls;
  }
  if (body.user !== undefined) chatBody.user = body.user;
  return chatBody;
}

export function responseUsageFromOpenAIUsage(usage: OpenAIUsage | undefined, reasoningTokens = 0): ResponseUsage {
  return {
    input_tokens: usage?.prompt_tokens ?? 0,
    input_tokens_details: { cached_tokens: usage?.prompt_cache_tokens ?? 0 },
    output_tokens: usage?.completion_tokens ?? 0,
    output_tokens_details: { reasoning_tokens: usage?.reasoning_tokens ?? reasoningTokens },
    total_tokens: usage?.total_tokens ?? 0,
  };
}

export function createResponseOutputMessage(
  text: string,
  status: ResponseItemStatus = 'completed',
  id = generateResponseItemId('msg'),
  phase?: ResponseOutputMessage['phase'],
): ResponseOutputMessage {
  return {
    id,
    type: 'message',
    status,
    role: 'assistant',
    content: text ? [{ type: 'output_text', text, annotations: [] }] : [],
    ...(phase === undefined ? {} : { phase }),
  };
}

export function extractResponseOutputText(value: unknown): string {
  if (!isRecord(value)) return '';
  if (typeof value.content === 'string') return value.content;
  if (!Array.isArray(value.content)) return '';
  return value.content
    .filter(
      (block): block is Record<string, unknown> =>
        isRecord(block) && (block.type === 'text' || block.type === 'output_text'),
    )
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('');
}

function toolCallToResponseFunctionCall(call: OpenAIToolCall): ResponseFunctionToolCall {
  return {
    id: generateResponseItemId('fc'),
    type: 'function_call',
    status: 'completed',
    call_id: call.id,
    name: call.function.name,
    arguments: call.function.arguments,
  };
}

export function createResponseReasoningItem(text: string): ResponseReasoningItem {
  return {
    id: generateResponseItemId('rs'),
    type: 'reasoning',
    status: 'completed',
    summary: [],
    content: text ? [{ type: 'reasoning_text', text }] : [],
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function responseMetadata(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return Object.fromEntries(entries);
}

export function chatResultToResponse(
  options: ResponseResultParts & {
    id?: string;
    model: string;
    requestBody: Record<string, unknown>;
    status?: ResponseStatus;
  },
): ResponseObject {
  const {
    id = generateResponseId(),
    model,
    content,
    reasoningText,
    usage,
    toolCalls,
    finishReason,
    serviceTier,
    requestBody,
    status = responseIncompleteReason(finishReason) ? 'incomplete' : 'completed',
  } = options;
  const output: ResponseOutputItem[] = [];
  if (reasoningText) output.push(createResponseReasoningItem(reasoningText));
  if (content) output.push(createResponseOutputMessage(content));
  if (toolCalls?.length) output.push(...toolCalls.map(toolCallToResponseFunctionCall));
  const now = Math.floor(Date.now() / 1000);

  return {
    id,
    object: 'response',
    created_at: now,
    completed_at: status === 'completed' ? now : null,
    status,
    error: null,
    incomplete_details:
      status === 'incomplete' ? { reason: responseIncompleteReason(finishReason) ?? 'max_output_tokens' } : null,
    instructions: typeof requestBody.instructions === 'string' ? requestBody.instructions : null,
    ...(requestBody.max_output_tokens === undefined
      ? {}
      : { max_output_tokens: numberOrNull(requestBody.max_output_tokens) }),
    model,
    output,
    output_text: content,
    parallel_tool_calls: requestBody.parallel_tool_calls !== false,
    ...(requestBody.previous_response_id === undefined
      ? {}
      : {
          previous_response_id:
            typeof requestBody.previous_response_id === 'string' ? requestBody.previous_response_id : null,
        }),
    prompt_cache_key: typeof requestBody.prompt_cache_key === 'string' ? requestBody.prompt_cache_key : undefined,
    prompt_cache_retention:
      requestBody.prompt_cache_retention === 'in_memory' || requestBody.prompt_cache_retention === '24h'
        ? requestBody.prompt_cache_retention
        : requestBody.prompt_cache_retention === null
          ? null
          : undefined,
    ...(requestBody.reasoning === undefined
      ? {}
      : { reasoning: isRecord(requestBody.reasoning) ? requestBody.reasoning : null }),
    safety_identifier: typeof requestBody.safety_identifier === 'string' ? requestBody.safety_identifier : undefined,
    service_tier: serviceTier ?? (isResponseServiceTier(requestBody.service_tier) ? requestBody.service_tier : 'auto'),
    temperature: numberOrNull(requestBody.temperature),
    ...(requestBody.text === undefined ? {} : { text: isRecord(requestBody.text) ? (requestBody.text as ResponseObject['text']) : undefined }),
    tool_choice: (requestBody.tool_choice as ResponseObject['tool_choice']) ?? 'auto',
    tools: Array.isArray(requestBody.tools) ? requestBody.tools : [],
    top_p: numberOrNull(requestBody.top_p),
    truncation: requestBody.truncation === 'auto' ? 'auto' : 'disabled',
    usage: responseUsageFromOpenAIUsage(usage),
    user: typeof requestBody.user === 'string' ? requestBody.user : undefined,
    metadata: responseMetadata(requestBody.metadata),
  };
}

export function extractReasoningText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const candidates: unknown[] = [
    value.reasoning_content,
    value.reasoning,
    isRecord(value.additional_kwargs) ? value.additional_kwargs.reasoning_content : undefined,
    isRecord(value.additional_kwargs) ? value.additional_kwargs.reasoning : undefined,
    isRecord(value.response_metadata) ? value.response_metadata.reasoning_content : undefined,
    isRecord(value.response_metadata) ? value.response_metadata.reasoning : undefined,
  ];
  for (const candidate of candidates) {
    const text = reasoningValueToText(candidate);
    if (text) return text;
  }
  if (Array.isArray(value.content)) {
    const text = value.content
      .filter(
        (block): block is Record<string, unknown> =>
          isRecord(block) && (block.type === 'reasoning' || block.type === 'reasoning_content'),
      )
      .map(reasoningValueToText)
      .filter((part): part is string => Boolean(part))
      .join('');
    if (text) return text;
  }
  return undefined;
}

function reasoningValueToText(value: unknown): string | undefined {
  if (typeof value === 'string') return value || undefined;
  if (!isRecord(value)) return undefined;
  if (typeof value.reasoning === 'string' && value.reasoning) return value.reasoning;
  if (typeof value.text === 'string' && value.text) return value.text;
  if (typeof value.content === 'string' && value.content) return value.content;

  for (const key of ['content', 'summary']) {
    const parts = value[key];
    if (!Array.isArray(parts)) continue;
    const text = parts
      .filter(isRecord)
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('');
    if (text) return text;
  }
  return undefined;
}

export function responseIncompleteReason(
  finishReason: string | undefined,
): NonNullable<ResponseObject['incomplete_details']>['reason'] | null {
  if (finishReason === 'length' || finishReason === 'max_tokens' || finishReason === 'max_output_tokens') {
    return 'max_output_tokens';
  }
  if (finishReason === 'content_filter') return 'content_filter';
  return null;
}

/** Read the terminal reason LangChain preserves from an upstream Responses API object. */
export function extractResponseIncompleteReason(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const metadataCandidates = [value.response_metadata, value.additional_kwargs, value];
  for (const candidate of metadataCandidates) {
    if (!isRecord(candidate)) continue;
    if (candidate.status === 'incomplete' && candidate.incomplete_details === null) return 'max_output_tokens';
    const details = candidate.incomplete_details;
    if (!isRecord(details)) continue;
    if (details.reason === 'max_output_tokens' || details.reason === 'content_filter') return details.reason;
  }
  return undefined;
}

export function extractResponseServiceTier(value: unknown): ResponseServiceTier | undefined {
  if (!isRecord(value)) return undefined;
  const responseMetadata = isRecord(value.response_metadata) ? value.response_metadata : undefined;
  const candidate = responseMetadata?.service_tier ?? responseMetadata?.serviceTier ?? value.service_tier;
  return isResponseServiceTier(candidate) ? candidate : undefined;
}

export function isResponseServiceTier(value: unknown): value is ResponseServiceTier {
  return value === 'auto' || value === 'default' || value === 'flex' || value === 'scale' || value === 'priority';
}

export function findResponseParameterProblem(body: Record<string, unknown>): string | undefined {
  if (body.instructions !== undefined && body.instructions !== null && typeof body.instructions !== 'string') {
    return "'instructions' must be a string or null";
  }
  const numberFields: Array<{ name: string; min: number; max?: number; integer?: boolean }> = [
    { name: 'max_output_tokens', min: 1, integer: true },
    { name: 'temperature', min: 0, max: 2 },
    { name: 'top_p', min: 0, max: 1 },
  ];
  for (const field of numberFields) {
    const value = body[field.name];
    if (value === undefined || value === null) continue;
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < field.min ||
      (field.max !== undefined && value > field.max) ||
      (field.integer && !Number.isSafeInteger(value))
    ) {
      return `'${field.name}' must be ${field.integer ? 'an integer' : 'a number'} between ${field.min} and ${
        field.max ?? 'the supported model limit'
      }`;
    }
  }
  for (const name of ['parallel_tool_calls', 'store', 'stream']) {
    if (body[name] !== undefined && body[name] !== null && typeof body[name] !== 'boolean') {
      return `'${name}' must be a boolean or null`;
    }
  }
  for (const name of ['prompt_cache_key', 'safety_identifier', 'user']) {
    if (body[name] !== undefined && typeof body[name] !== 'string') {
      return `'${name}' must be a string`;
    }
  }
  if (typeof body.safety_identifier === 'string' && body.safety_identifier.length > 64) {
    return "'safety_identifier' must be at most 64 characters";
  }
  if (
    body.prompt_cache_retention !== undefined &&
    body.prompt_cache_retention !== null &&
    body.prompt_cache_retention !== 'in_memory' &&
    body.prompt_cache_retention !== '24h'
  ) {
    return "'prompt_cache_retention' must be 'in_memory', '24h', or null";
  }
  if (body.reasoning !== undefined && body.reasoning !== null) {
    if (!isRecord(body.reasoning)) return "'reasoning' must be an object or null";
    const effort = body.reasoning.effort;
    if (
      effort !== undefined &&
      effort !== null &&
      effort !== 'none' &&
      effort !== 'minimal' &&
      effort !== 'low' &&
      effort !== 'medium' &&
      effort !== 'high' &&
      effort !== 'xhigh'
    ) {
      return "'reasoning.effort' must be none, minimal, low, medium, high, xhigh, or null";
    }
  }
  if (body.text !== undefined && body.text !== null) {
    if (!isRecord(body.text)) return "'text' must be an object or null";
    if (body.text.verbosity !== undefined && body.text.verbosity !== null) {
      if (body.text.verbosity !== 'low' && body.text.verbosity !== 'medium' && body.text.verbosity !== 'high') {
        return "'text.verbosity' must be low, medium, high, or null";
      }
    }
    const format = body.text.format;
    if (format !== undefined && format !== null) {
      if (!isRecord(format)) return "'text.format' must be an object or null";
      if (format.type !== 'text' && format.type !== 'json_object' && format.type !== 'json_schema') {
        return "'text.format.type' must be text, json_object, or json_schema";
      }
      if (
        format.type === 'json_schema' &&
        (typeof format.name !== 'string' || !format.name || !isRecord(format.schema))
      ) {
        return "'text.format' with type json_schema requires a non-empty name and an object schema";
      }
    }
  }
  if (body.previous_response_id !== undefined && body.previous_response_id !== null) {
    if (typeof body.previous_response_id !== 'string' || !body.previous_response_id) {
      return "'previous_response_id' must be a non-empty string or null";
    }
  }
  return undefined;
}

export function findUnsupportedResponseInput(input: unknown): string | undefined {
  if (!Array.isArray(input)) return undefined;
  for (const item of input) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const block of item.content) {
      if (!isRecord(block)) continue;
      if (block.type === 'input_image' && typeof block.file_id === 'string') {
        return 'input_image.file_id';
      }
      if (block.type === 'input_file' && typeof block.file_id === 'string') {
        return 'input_file.file_id';
      }
    }
  }
  return undefined;
}
export function findResponseToolProblem(tools: unknown): string | undefined {
  if (tools === undefined) return undefined;
  if (!Array.isArray(tools)) return "'tools' must be an array";
  for (const [index, tool] of tools.entries()) {
    if (!isRecord(tool)) return `tools[${index}] must be an object`;
    if (tool.type !== 'function') return `tool type '${String(tool.type ?? 'unknown')}' is not supported`;
    if (typeof tool.name !== 'string' || !tool.name) return `tools[${index}].name must be a non-empty string`;
    if (tool.parameters !== undefined && tool.parameters !== null && !isRecord(tool.parameters)) {
      return `tools[${index}].parameters must be an object or null`;
    }
    if (tool.strict !== undefined && tool.strict !== null && typeof tool.strict !== 'boolean') {
      return `tools[${index}].strict must be a boolean or null`;
    }
    if (tool.description !== undefined && tool.description !== null && typeof tool.description !== 'string') {
      return `tools[${index}].description must be a string or null`;
    }
    if (tool.defer_loading !== undefined) return `tools[${index}].defer_loading is not supported`;
  }
  return undefined;
}

export function findResponseToolChoiceProblem(toolChoice: unknown): string | undefined {
  if (toolChoice === undefined) return undefined;
  if (toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'required') return undefined;
  if (!isRecord(toolChoice)) return "'tool_choice' must be auto, none, required, or a function choice object";
  if (toolChoice.type !== 'function' || typeof toolChoice.name !== 'string' || !toolChoice.name) {
    return "'tool_choice' object must have type='function' and a non-empty name";
  }
  return undefined;
}
export function findResponseInputProblem(input: unknown): string | undefined {
  if (typeof input === 'string') return input.length > 0 ? undefined : "'input' string must not be empty";
  if (!Array.isArray(input)) return "'input' must be a string or an array";
  if (input.length === 0) return "'input' array must not be empty";
  for (const [index, item] of input.entries()) {
    if (!isRecord(item)) return `input[${index}] must be an object`;
    if (item.type === 'function_call') {
      if (
        typeof item.call_id !== 'string' ||
        !item.call_id ||
        typeof item.name !== 'string' ||
        !item.name ||
        typeof item.arguments !== 'string'
      ) {
        return `input[${index}] function_call requires non-empty call_id and name strings plus string arguments`;
      }
      continue;
    }
    if (item.type === 'reasoning') {
      if (typeof item.id !== 'string' || !item.id || !Array.isArray(item.summary)) {
        return `input[${index}] reasoning requires a non-empty id and summary array`;
      }
      const invalidSummary = item.summary.some(
        (part) => !isRecord(part) || part.type !== 'summary_text' || typeof part.text !== 'string',
      );
      if (invalidSummary) return `input[${index}].reasoning summary items must be summary_text objects`;
      if (
        item.content !== undefined &&
        (!Array.isArray(item.content) ||
          item.content.some(
            (part) => !isRecord(part) || part.type !== 'reasoning_text' || typeof part.text !== 'string',
          ))
      ) {
        return `input[${index}].reasoning content items must be reasoning_text objects`;
      }
      continue;
    }
    if (item.type === 'function_call_output') {
      if (typeof item.call_id !== 'string' || !item.call_id || item.output === undefined) {
        return `input[${index}] function_call_output requires call_id and output`;
      }
      if (
        typeof item.output !== 'string' &&
        (!Array.isArray(item.output) ||
          item.output.some(
            (part) =>
              !isRecord(part) ||
              (part.type !== 'input_text' && part.type !== 'input_image' && part.type !== 'input_file'),
          ))
      ) {
        return `input[${index}] function_call_output output must be a string or input content array`;
      }
      continue;
    }
    if (item.type === 'message' || typeof item.role === 'string') {
      if (item.role !== 'user' && item.role !== 'assistant' && item.role !== 'system' && item.role !== 'developer') {
        return `input[${index}].role is not supported`;
      }
      if (typeof item.content !== 'string' && !Array.isArray(item.content)) {
        return `input[${index}].content must be a string or an array`;
      }
      if (
        item.phase !== undefined &&
        item.phase !== null &&
        item.phase !== 'commentary' &&
        item.phase !== 'final_answer'
      ) {
        return `input[${index}].phase must be commentary, final_answer, or null`;
      }
      if (Array.isArray(item.content)) {
        for (const [contentIndex, block] of item.content.entries()) {
          if (!isRecord(block) || typeof block.type !== 'string') {
            return `input[${index}].content[${contentIndex}] must be a typed object`;
          }
          if ((block.type === 'input_text' || block.type === 'output_text') && typeof block.text !== 'string') {
            return `input[${index}].content[${contentIndex}].text must be a string`;
          }
          if (
            block.type === 'input_image' &&
            typeof block.image_url !== 'string' &&
            typeof block.file_id !== 'string'
          ) {
            return `input[${index}].content[${contentIndex}] input_image requires image_url or file_id`;
          }
          if (
            block.type === 'input_file' &&
            typeof block.file_url !== 'string' &&
            typeof block.file_data !== 'string' &&
            typeof block.file_id !== 'string'
          ) {
            return `input[${index}].content[${contentIndex}] input_file requires file_url, file_data, or file_id`;
          }
          if (
            block.type !== 'input_text' &&
            block.type !== 'output_text' &&
            block.type !== 'input_image' &&
            block.type !== 'input_file'
          ) {
            return `input[${index}].content[${contentIndex}] type '${block.type}' is not supported`;
          }
        }
      }
      continue;
    }
    return `input[${index}] type '${String(item.type ?? 'unknown')}' is not supported`;
  }
  return undefined;
}

export function findUnsupportedResponseParameter(body: Record<string, unknown>): string | undefined {
  const unsupported = [
    'background',
    'context_management',
    'conversation',
    'include',
    'max_tool_calls',
    'prompt',
    'stream_options',
    'top_logprobs',
  ];
  return unsupported.find((name) => body[name] !== undefined);
}

function responsesTextFormatToChatFormat(format: unknown): unknown {
  if (!isRecord(format) || format.type !== 'json_schema') return format;
  return {
    type: 'json_schema',
    json_schema: {
      name: format.name,
      schema: format.schema,
      ...(typeof format.description === 'string' ? { description: format.description } : {}),
      ...(typeof format.strict === 'boolean' ? { strict: format.strict } : {}),
    },
  };
}
