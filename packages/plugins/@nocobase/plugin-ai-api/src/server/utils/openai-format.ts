/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import crypto from 'crypto';

// ─── Model string parsing ───

export interface ParsedModel {
  llmService: string;
  modelId: string;
}

/**
 * Parse OpenAI-style model string into NocoBase llmService + modelId.
 * Format: "llmServiceName/modelId" (e.g. "my-openai/gpt-4o")
 * If no "/" is present, the entire string is treated as modelId and llmService is empty.
 */
export function parseModelString(model: string): ParsedModel {
  const slashIndex = model.indexOf('/');
  if (slashIndex === -1) {
    return { llmService: '', modelId: model };
  }
  return {
    llmService: model.substring(0, slashIndex),
    modelId: model.substring(slashIndex + 1),
  };
}

// ─── ID generation ───

export function generateCompletionId(): string {
  return `chatcmpl-${crypto.randomBytes(16).toString('hex').substring(0, 29)}`;
}

// ─── OpenAI error format ───

export function toOpenAIError(statusCode: number, message: string, type = 'invalid_request_error', code?: string) {
  return {
    error: {
      message,
      type,
      param: null,
      code: code || null,
    },
  };
}

// ─── OpenAI Chat Completion response (non-streaming) ───

export function toOpenAIResponse(options: {
  id: string;
  model: string;
  content: string;
  finishReason?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}) {
  const { id, model, content, finishReason = 'stop', usage } = options;
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    system_fingerprint: null,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
        },
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// ─── OpenAI Streaming chunk format ───

export function toOpenAIStreamChunk(options: {
  id: string;
  model: string;
  delta: { role?: string; content?: string };
  finishReason?: string | null;
}) {
  const { id, model, delta, finishReason = null } = options;
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    system_fingerprint: null,
    choices: [
      {
        index: 0,
        delta,
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
  };
}

// ─── OpenAI Embeddings response ───

export function toOpenAIEmbeddingsResponse(options: { model: string; embeddings: number[][]; promptTokens?: number }) {
  const { model, embeddings, promptTokens = 0 } = options;
  return {
    object: 'list' as const,
    data: embeddings.map((embedding, index) => ({
      object: 'embedding' as const,
      embedding,
      index,
    })),
    model,
    usage: {
      prompt_tokens: promptTokens,
      total_tokens: promptTokens,
    },
  };
}

/**
 * Format a streaming chunk as an SSE data line.
 */
export function formatSSE(data: any): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/**
 * Format the terminal SSE [DONE] signal.
 */
export function formatSSEDone(): string {
  return `data: [DONE]\n\n`;
}
