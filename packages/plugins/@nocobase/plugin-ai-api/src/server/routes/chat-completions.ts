/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Context } from '@nocobase/actions';
import {
  generateCompletionId,
  toOpenAIResponse,
  toOpenAIStreamChunk,
  toOpenAIError,
  formatSSE,
  formatSSEDone,
} from '../utils/openai-format';
import { resolveModelString } from '../utils/resolve-service';
import { checkEmployeeAccess } from '../middleware/role-permission';
import type PluginAiApiServer from '../plugin';

/**
 * POST /api/ai-llm/v1/chat/completions
 *
 * Handles OpenAI-compatible chat completion requests.
 * Supports both streaming (SSE) and non-streaming modes.
 */
export async function handleChatCompletions(ctx: Context, plugin: PluginAiApiServer) {
  const body = ctx.request.body as any;

  // ─── Validate request ───
  if (!body?.model) {
    ctx.status = 400;
    ctx.body = toOpenAIError(400, "'model' is required", 'invalid_request_error', 'missing_model');
    return;
  }

  if (!body?.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    ctx.status = 400;
    ctx.body = toOpenAIError(400, "'messages' must be a non-empty array", 'invalid_request_error', 'missing_messages');
    return;
  }

  // ─── Reject unsupported n parameter ───
  if (body.n !== undefined && body.n !== null && body.n !== 1) {
    ctx.status = 400;
    ctx.body = toOpenAIError(
      400,
      `The 'n' parameter value ${body.n} is not supported. ` +
        `This API gateway always returns exactly one completion (n=1). Please omit 'n' or set it to 1.`,
      'invalid_request_error',
      'unsupported_parameter',
    );
    return;
  }

  const stream = body.stream === true;

  // ─── Resolve model string against DB ───
  const resolved = await resolveModelString(ctx, body.model);
  if (!resolved) {
    ctx.status = 404;
    ctx.body = toOpenAIError(
      404,
      `Could not resolve model '${body.model}'. Format: 'serviceName/modelId'. Use GET /v1/models to see available models.`,
      'invalid_request_error',
      'model_not_found',
    );
    return;
  }

  const { service, modelId } = resolved;

  try {
    const aiPlugin = ctx.app.pm.get('ai') as any;
    if (!aiPlugin) {
      ctx.status = 500;
      ctx.body = toOpenAIError(500, 'AI plugin not available', 'server_error');
      return;
    }

    if (service.enabled === false) {
      ctx.status = 404;
      ctx.body = toOpenAIError(
        404,
        `LLM service '${service.title || service.name}' is disabled`,
        'invalid_request_error',
        'model_not_found',
      );
      return;
    }

    // ─── Check whitelist ───
    const config = await ctx.db.getRepository('aiApiConfig').findOne();
    if (config?.enabledLlmServices?.length) {
      const serviceName = service.name;
      const serviceTitle = service.title;
      const isAllowed = config.enabledLlmServices.some((s: string) => s === serviceName || s === serviceTitle);
      if (!isAllowed) {
        ctx.status = 403;
        ctx.body = toOpenAIError(
          403,
          `LLM service '${service.title || service.name}' is not enabled for API access`,
          'invalid_request_error',
          'model_not_available',
        );
        return;
      }
    }

    // ─── Create LLM provider instance ───
    const providerMeta = aiPlugin.aiManager.llmProviders.get(service.provider);
    if (!providerMeta) {
      ctx.status = 500;
      ctx.body = toOpenAIError(500, `Provider '${service.provider}' not registered`, 'server_error');
      return;
    }

    const modelOptions: Record<string, any> = {
      model: modelId,
      llmService: service.name,
    };

    // Pass through optional parameters
    if (body.temperature !== undefined) modelOptions.temperature = body.temperature;
    if (body.top_p !== undefined) modelOptions.topP = body.top_p;
    if (body.max_tokens !== undefined) modelOptions.maxTokens = body.max_tokens;
    if (body.frequency_penalty !== undefined) modelOptions.frequencyPenalty = body.frequency_penalty;
    if (body.presence_penalty !== undefined) modelOptions.presencePenalty = body.presence_penalty;
    if (body.stop !== undefined) modelOptions.stop = body.stop;

    const Provider = providerMeta.provider;
    const provider = new Provider({
      app: ctx.app,
      serviceOptions: service.options,
      modelOptions,
    });

    // ─── Build system prompt from AI Employee ───
    let systemPrompt = '';
    if (config?.defaultAiEmployee) {
      // Check role is allowed to use this employee
      if (!checkEmployeeAccess(ctx, config.defaultAiEmployee)) {
        ctx.status = 403;
        ctx.body = toOpenAIError(
          403,
          `Role is not permitted to use AI Employee '${config.defaultAiEmployee}'. ` +
            `An admin must grant access in Settings → Users & Permissions → [Role] → AI API.`,
          'permission_denied',
          'employee_not_permitted',
        );
        return;
      }
      const employee = await ctx.db.getRepository('aiEmployees').findOne({
        filter: { username: config.defaultAiEmployee },
      });
      if (employee) {
        systemPrompt = employee.about || employee.defaultPrompt || '';
      }
    }

    // ─── Build messages (inject system prompt if not provided by client) ───
    const messages = [...body.messages];
    const hasSystemMessage = messages.some((m: any) => m.role === 'system');
    if (systemPrompt && !hasSystemMessage) {
      messages.unshift({ role: 'system', content: systemPrompt });
    }

    // ─── Build message tuples for LangChain model ───
    // LangChain chat models accept [role, content] tuples or BaseMessage objects.
    // We use tuples to avoid importing @langchain/core directly.
    const langchainMessages = messages.map((msg: any) => {
      const role = msg.role === 'assistant' ? 'ai' : msg.role;
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      return [role, content] as [string, string];
    });

    const completionId = generateCompletionId();
    const chatModel = provider.createModel();

    if (stream) {
      // ─── Streaming mode ───
      await handleStreamingCompletion(ctx, chatModel, langchainMessages, completionId, body.model);
    } else {
      // ─── Non-streaming mode ───
      await handleNonStreamingCompletion(ctx, chatModel, langchainMessages, completionId, body.model);
    }
  } catch (err) {
    ctx.log.error('AI API chat completions error:', err);
    if (!ctx.res.headersSent) {
      ctx.status = 500;
      ctx.body = toOpenAIError(500, err.message || 'Internal server error', 'server_error');
    }
  }
}

// ─── Non-streaming handler ───

async function handleNonStreamingCompletion(
  ctx: Context,
  chatModel: any,
  messages: any[],
  completionId: string,
  modelName: string,
) {
  const result = await chatModel.invoke(messages);

  let content = '';
  if (typeof result.content === 'string') {
    content = result.content;
  } else if (Array.isArray(result.content)) {
    // Handle array content (e.g. OpenAI responses API)
    const textPart = result.content.find((c: any) => c.type === 'text');
    content = textPart?.text || JSON.stringify(result.content);
  }

  // Extract usage if available
  const usage = result.usage_metadata
    ? {
        prompt_tokens: result.usage_metadata.input_tokens || 0,
        completion_tokens: result.usage_metadata.output_tokens || 0,
        total_tokens: result.usage_metadata.total_tokens || 0,
      }
    : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  ctx.status = 200;
  ctx.body = toOpenAIResponse({
    id: completionId,
    model: modelName,
    content,
    usage,
  });
}

// ─── Streaming handler ───

async function handleStreamingCompletion(
  ctx: Context,
  chatModel: any,
  messages: any[],
  completionId: string,
  modelName: string,
) {
  // Set SSE headers
  ctx.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable nginx buffering
  });
  ctx.status = 200;

  // Send initial chunk with role
  ctx.res.write(
    formatSSE(
      toOpenAIStreamChunk({
        id: completionId,
        model: modelName,
        delta: { role: 'assistant', content: '' },
      }),
    ),
  );

  try {
    const stream = await chatModel.stream(messages);

    for await (const chunk of stream) {
      let content = '';
      if (typeof chunk.content === 'string') {
        content = chunk.content;
      } else if (Array.isArray(chunk.content)) {
        const textPart = chunk.content.find((c: any) => c.type === 'text');
        content = textPart?.text || '';
      }

      if (content) {
        ctx.res.write(
          formatSSE(
            toOpenAIStreamChunk({
              id: completionId,
              model: modelName,
              delta: { content },
            }),
          ),
        );
      }
    }

    // Send finish chunk
    ctx.res.write(
      formatSSE(
        toOpenAIStreamChunk({
          id: completionId,
          model: modelName,
          delta: {},
          finishReason: 'stop',
        }),
      ),
    );

    // Send [DONE]
    ctx.res.write(formatSSEDone());
  } catch (err) {
    ctx.log.error('AI API streaming error:', err);
    // Send error as SSE event before closing
    ctx.res.write(
      formatSSE({
        error: {
          message: err.message || 'Streaming error',
          type: 'server_error',
        },
      }),
    );
  } finally {
    ctx.res.end();
  }
}
