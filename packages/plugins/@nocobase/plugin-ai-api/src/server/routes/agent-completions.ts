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
  toOpenAIStreamChunk,
  toOpenAIError,
  formatSSE,
  formatSSEDone,
} from '../utils/openai-format';
import { resolveModelString } from '../utils/resolve-service';
import { checkEmployeeAccess } from '../middleware/role-permission';
import type PluginAiApiServer from '../plugin';

/**
 * POST /api/ai-llm/v1/chat/completions (agent mode)
 *
 * Runs the full AI Employee pipeline by directly instantiating AIEmployee
 * from plugin-ai. This provides TRUE real-time streaming — no buffering.
 *
 * ## Architecture (vs old approach)
 *
 * OLD (fake streaming, HTTP loopback):
 *   Client → ai-api → HTTP to localhost → aiConversations:sendMessages
 *                   ← buffers entire response ←
 *   Client ← 20-char fake chunks ← re-emit
 *
 * NEW (true streaming, direct instantiation):
 *   Client → ai-api → AIEmployee(ctx) ← writes directly to ctx.res
 *   We intercept ctx.res.write to translate NocoBase SSE → OpenAI SSE
 *   Client ← real-time OpenAI SSE chunks ← write() intercept
 *
 * ## NocoBase → OpenAI SSE translation
 *
 * NocoBase emits: `data: {"type":"content","body":"chunk text"}\n\n`
 * We emit:        `data: {"choices":[{"delta":{"content":"chunk text"},...}]}\n\n`
 *
 * Other NocoBase event types (tool_calls, stream_start, etc.) are silently
 * ignored — they are NocoBase-internal events not part of the OpenAI protocol.
 *
 * ## Known limitation
 * Token usage is always { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
 * in agent mode. ResponseMetadataCollector is private inside AIEmployee with no
 * public accessor. Modifying plugin-ai is out of scope for this plugin.
 */
export async function handleAgentCompletions(ctx: Context, plugin: PluginAiApiServer) {
  const body = ctx.request.body as any;

  // ─── Validate ─────────────────────────────────────────────────────────────
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

  if (body.n !== undefined && body.n !== null && body.n !== 1) {
    ctx.status = 400;
    ctx.body = toOpenAIError(
      400,
      `The 'n' parameter value ${body.n} is not supported. This gateway always returns n=1.`,
      'invalid_request_error',
      'unsupported_parameter',
    );
    return;
  }

  // ─── Load config and validate AI Employee ─────────────────────────────────
  const config = await ctx.db.getRepository('aiApiConfig').findOne();
  if (!config?.defaultAiEmployee) {
    ctx.status = 400;
    ctx.body = toOpenAIError(
      400,
      'Agent mode requires a Default AI Employee. Configure one in Settings > AI API Gateway.',
      'invalid_request_error',
      'missing_config',
    );
    return;
  }

  // ─── Resolve model ─────────────────────────────────────────────────────────
  const resolved = await resolveModelString(ctx, body.model);
  if (!resolved) {
    ctx.status = 404;
    ctx.body = toOpenAIError(
      404,
      `Could not resolve model '${body.model}'. Use GET /v1/models to see available models.`,
      'invalid_request_error',
      'model_not_found',
    );
    return;
  }

  const { service, modelId } = resolved;
  if (service.enabled === false) {
    ctx.status = 404;
    ctx.body = toOpenAIError(404, 'LLM service is disabled', 'invalid_request_error', 'model_not_found');
    return;
  }

  const employeeUsername = config.defaultAiEmployee;

  // ─── Check role is allowed to use this employee ────────────────────────────
  if (!checkEmployeeAccess(ctx, employeeUsername)) {
    ctx.status = 403;
    ctx.body = toOpenAIError(
      403,
      `Role is not permitted to use AI Employee '${employeeUsername}'. ` +
        `An admin must grant access in Settings → Users & Permissions → [Role] → AI API.`,
      'permission_denied',
      'employee_not_permitted',
    );
    return;
  }

  const wantStream = body.stream === true;

  try {
    // ─── Load AI Employee record ────────────────────────────────────────────
    const employeeRecord = await ctx.db.getRepository('aiEmployees').findOne({
      filter: { username: employeeUsername },
    });
    if (!employeeRecord) {
      ctx.status = 400;
      ctx.body = toOpenAIError(
        400,
        `AI employee '${employeeUsername}' not found. Check Settings > AI API Gateway.`,
        'invalid_request_error',
        'missing_config',
      );
      return;
    }

    // ─── Create ephemeral conversation directly in DB ───────────────────────
    // Avoids the HTTP loopback of the old implementation.
    // thread: 1 = LangGraph-enabled (non-legacy) mode for full agent capabilities.
    const userId = ctx.state.currentUser?.id;
    const conversation = await ctx.db.getRepository('aiConversations').create({
      values: {
        userId,
        aiEmployee: { username: employeeUsername },
        options: {},
        thread: 1,
      },
    });
    const sessionId = conversation.sessionId ?? conversation.id ?? String(conversation.get('id'));

    // ─── Convert OpenAI messages → NocoBase AIMessageInput format ──────────
    // AIMessageInput = Omit<AIMessage, 'messageId' | 'sessionId'>
    // = { role, content: { type, content }, toolCalls?, attachments?, ... }
    const userMessages = body.messages.map((msg: any) => ({
      // 'assistant' role maps to the AI employee's username in NocoBase's system
      role: msg.role === 'assistant' ? employeeUsername : msg.role,
      content: {
        type: 'text',
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      },
    }));

    const completionId = generateCompletionId();

    // ─── Dynamic import of AIEmployee ──────────────────────────────────────
    // Uses dynamic import() to avoid a hard compile-time path dependency.
    // plugin-ai is a peerDependency and is always available at runtime.
    let AIEmployee: any;
    try {
      const mod = await import(
        /* webpackIgnore: true */
        '@nocobase/plugin-ai/dist/server/ai-employees/ai-employee.js' as any
      );
      AIEmployee = mod.AIEmployee;
    } catch (importErr) {
      ctx.log.error(
        'AI API: Failed to import AIEmployee from plugin-ai. Ensure plugin-ai is installed and built.',
        importErr,
      );
      ctx.status = 500;
      ctx.body = toOpenAIError(500, 'Agent mode unavailable: plugin-ai not found or not built', 'server_error');
      return;
    }
    if (!AIEmployee) {
      ctx.status = 500;
      ctx.body = toOpenAIError(
        500,
        'Agent mode unavailable: AIEmployee class not exported by plugin-ai',
        'server_error',
      );
      return;
    }

    // ─── Ensure timezone/locale headers exist for AIEmployee.parseVariables ──
    // External clients don't send X-Timezone / X-Locale, but plugin-ai's
    // parseVariables() calls ctx.get('x-timezone') to resolve date variables
    // in the AI employee system prompt. Without it, utc2unit() crashes.
    if (!ctx.get('x-timezone')) {
      ctx.req.headers['x-timezone'] = 'UTC';
    }
    if (!ctx.get('x-locale')) {
      ctx.req.headers['x-locale'] = 'en-US';
    }

    if (wantStream) {
      // ── TRUE STREAMING ────────────────────────────────────────────────────
      //
      // ChatStreamProtocol.write() inside AIEmployee calls ctx.res.write() directly.
      // We monkey-patch ctx.res.write to intercept NocoBase SSE events and translate
      // them into OpenAI SSE format before they reach the wire.
      //
      // NocoBase format:  data: {"type":"content","body":"Hello "}\n\n
      // OpenAI format:    data: {"choices":[{"delta":{"content":"Hello "},...}]}\n\n
      //
      // We also intercept ctx.res.end to prevent AIEmployee from closing the stream
      // before we can send the final [DONE] marker.

      ctx.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      ctx.status = 200;

      // Send the initial role delta (OpenAI streaming convention)
      ctx.res.write(
        formatSSE(
          toOpenAIStreamChunk({
            id: completionId,
            model: body.model,
            delta: { role: 'assistant', content: '' },
          }),
        ),
      );

      const originalWrite = ctx.res.write.bind(ctx.res);
      const originalEnd = ctx.res.end.bind(ctx.res);

      // Intercept end() — prevent AIEmployee from terminating the stream early.
      // We restore and call it ourselves in the finally block.
      (ctx.res as any).end = (...args: any[]) => {
        // If called with data (error paths), flush it via the intercepted write
        if (args[0]) {
          (ctx.res as any).write(args[0]);
        }
        // Don't actually end — we control this
      };

      // Intercept write() — translate NocoBase SSE → OpenAI SSE
      (ctx.res as any).write = (data: Buffer | string): boolean => {
        const text = typeof data === 'string' ? data : data.toString('utf8');

        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;

          const jsonStr = trimmed.substring(6);
          if (!jsonStr) continue;

          try {
            const event = JSON.parse(jsonStr);

            if (event.type === 'content' && event.body) {
              // Content chunk — forward as OpenAI delta
              originalWrite(
                formatSSE(
                  toOpenAIStreamChunk({
                    id: completionId,
                    model: body.model,
                    delta: { content: String(event.body) },
                  }),
                ),
              );
            } else if (event.type === 'error' && event.body) {
              // Error from the agent — surface as SSE error object
              originalWrite(
                formatSSE({
                  error: {
                    message: String(event.body),
                    type: 'server_error',
                    code: 'agent_error',
                  },
                }),
              );
            }
            // stream_start, stream_end, tool_calls, tool_call_status,
            // web_search, reasoning, new_message, tool_call_chunks → silently ignored.
            // These are NocoBase-internal events not part of the OpenAI protocol.
          } catch {
            // Non-JSON SSE line — ignore
          }
        }
        return true;
      };

      try {
        const aiEmployee = new AIEmployee(
          ctx,
          employeeRecord,
          sessionId,
          undefined, // systemMessage — use AI employee's default
          undefined, // skillSettings
          false, // webSearch
          { llmService: service.name, model: modelId },
          false, // legacy — use LangGraph (thread: 1)
        );

        await aiEmployee.stream({ userMessages });
      } finally {
        // Restore original write/end before sending our closing frames
        (ctx.res as any).write = originalWrite;
        (ctx.res as any).end = originalEnd;

        // Send the finish chunk and [DONE] signal
        originalWrite(
          formatSSE(
            toOpenAIStreamChunk({
              id: completionId,
              model: body.model,
              delta: {},
              finishReason: 'stop',
            }),
          ),
        );
        originalWrite(formatSSEDone());
        originalEnd();
      }
    } else {
      // ── NON-STREAMING (invoke) ─────────────────────────────────────────────
      //
      // AIEmployee.invoke() returns the final LangGraph state object.
      // The last AI message in state.messages contains the response content.

      const aiEmployee = new AIEmployee(
        ctx,
        employeeRecord,
        sessionId,
        undefined,
        undefined,
        false,
        { llmService: service.name, model: modelId },
        false,
      );

      const result = await aiEmployee.invoke({ userMessages });
      const content = extractLastAiMessageContent(result);

      ctx.status = 200;
      ctx.set('Content-Type', 'application/json');
      ctx.body = {
        id: completionId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        system_fingerprint: null,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content },
            logprobs: null,
            finish_reason: 'stop',
          },
        ],
        // NOTE: Token usage is unavailable in agent mode.
        // ResponseMetadataCollector is private inside AIEmployee and not exposed publicly.
        // Clients can detect agent mode by checking usage.total_tokens === 0.
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
    }

    // ─── Cleanup: delete the ephemeral conversation (best-effort) ────────────
    // Run after response is sent so cleanup latency doesn't affect the client.
    setImmediate(async () => {
      try {
        await ctx.db.getRepository('aiConversations').destroy({
          filterByTk: sessionId,
        });
      } catch {
        // Best-effort: if cleanup fails, the conversation stays in DB.
        // CheckpointCleaner in plugin-ai will handle stale conversations after 48h.
      }
    });
  } catch (err) {
    ctx.log.error('AI API agent completions error:', err);
    if (!ctx.res.headersSent) {
      ctx.status = 500;
      ctx.body = toOpenAIError(500, err.message || 'Internal server error', 'server_error');
    }
  }
}

/**
 * Extract the last AI message content from a LangGraph invoke() result.
 *
 * LangGraph state has a `messages` array of LangChain BaseMessage instances.
 * We iterate from the end to find the last message that is NOT a HumanMessage
 * or ToolMessage (those are user/tool inputs, not AI output).
 */
function extractLastAiMessageContent(result: any): string {
  if (!result?.messages || !Array.isArray(result.messages)) return '';

  for (let i = result.messages.length - 1; i >= 0; i--) {
    const msg = result.messages[i];
    if (!msg) continue;

    const className = msg?.constructor?.name;
    if (className === 'HumanMessage' || className === 'ToolMessage') continue;

    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      const textBlock = msg.content.find((c: any) => c.type === 'text');
      return textBlock?.text || '';
    }
  }

  return '';
}
