import { z } from 'zod';
import { Context } from '@nocobase/actions';
// @ts-ignore - subpath export types resolve at build time via NocoBase bundler
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type PluginAIServer from '@nocobase/plugin-ai/dist/server';
import type { ToolsEntry } from '@nocobase/ai';

/**
 * Maximum delegation depth key stored in ctx metadata.
 * Used to prevent circular/recursive delegation chains.
 */
const ORCHESTRATOR_DEPTH_KEY = '__orchestratorDepth';

type TraceEvent = {
  type: string;
  at: string;
  title: string;
  content?: string;
  toolName?: string;
  args?: any;
  status?: string;
};

type AgentExecutionResult = {
  content: string;
  messages: any[];
};

function sanitizeToolPart(value: string) {
  return (value || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function buildDelegateToolName(leaderUsername: string, subAgentUsername: string) {
  return `delegate_${sanitizeToolPart(leaderUsername)}_to_${sanitizeToolPart(subAgentUsername)}`;
}

function isDelegateToolName(toolName: string) {
  return toolName.startsWith('delegate_to_') || (toolName.startsWith('delegate_') && toolName.includes('_to_'));
}

function createDelegateToolOptions(
  plugin: any,
  options: {
    leaderUsername: string;
    subAgentUsername: string;
    subAgentEmployee: any;
    maxDepth?: number;
    timeout?: number;
    toolName: string;
    legacyAlias?: boolean;
  },
) {
  const { leaderUsername, subAgentUsername, subAgentEmployee, maxDepth, timeout, toolName, legacyAlias } = options;
  const toolDescription = [
    `Delegate a task from "${leaderUsername}" to the AI Employee "${subAgentEmployee.nickname || subAgentUsername}".`,
    legacyAlias ? 'This is a backward-compatible alias for existing skill assignments.' : '',
    subAgentEmployee.about ? `Specialist profile: ${subAgentEmployee.about.substring(0, 200)}` : '',
    'The sub-agent will execute the task independently and return its final answer.',
  ].filter(Boolean).join(' ');

  return {
    scope: 'CUSTOM',
    execution: 'backend',
    defaultPermission: 'ALLOW',
    silence: false,
    introduction: {
      title: `[${leaderUsername}] ${subAgentEmployee.nickname || subAgentUsername}${legacyAlias ? ' (legacy)' : ''}`,
      about: toolDescription,
    },
    definition: {
      name: toolName,
      description: toolDescription,
      schema: z.object({
        task: z.string().describe('The detailed task description for the sub-agent to execute.'),
        context: z.string().optional().describe('Optional additional context to help the sub-agent understand the task better.'),
      }),
    },
    invoke: async (ctx: Context, args: { task: string; context?: string }, id: string) => {
      const callingEmployee = resolveCallingEmployee(ctx);
      if (callingEmployee && callingEmployee !== leaderUsername) {
        await logDelegation(ctx, plugin, {
          leaderUsername,
          subAgentUsername,
          toolName,
          task: args.task,
          context: args.context,
          result: '',
          status: 'error',
          depth: (ctx as any)[ORCHESTRATOR_DEPTH_KEY] ?? 0,
          durationMs: 0,
          error: `Employee "${callingEmployee}" is not authorized to use this delegation rule.`,
        });
        return {
          status: 'error' as const,
          content: `Employee "${callingEmployee}" is not authorized to delegate to "${subAgentUsername}". Configure an orchestration rule first.`,
        };
      }

      return invokeDelegateTask(ctx, plugin, {
        leaderUsername,
        subAgentUsername,
        subAgentEmployee,
        task: args.task,
        context: args.context,
        maxDepth: maxDepth ?? 1,
        timeout: timeout ?? 120000,
        toolCallId: id,
        toolName,
      });
    },
  };
}

function resolveCallingEmployee(ctx: Context) {
  const raw =
    (ctx as any)._currentAIEmployee ||
    (ctx as any).state?.currentAIEmployee ||
    (ctx as any).runtime?.context?.currentAIEmployee;
  if (!raw) return null;
  return typeof raw === 'string' ? raw : raw.username;
}

function truncateText(value: any, maxLen: number) {
  const text = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
  return text.length > maxLen ? `${text.slice(0, maxLen)}\n...[truncated]` : text;
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Creates one dynamic tool per configured sub-agent for a given leader.
 * Uses Strategy B (Per-SubAgent Tool): each sub-agent becomes a separate tool
 * with its own name and description, making LLM tool selection natural.
 *
 * Architecture:
 * - Uses createReactAgent (public LangGraph API) for agent execution
 * - Uses plugin-ai's getLLMService() for LLM model resolution
 * - Uses core app.aiManager.toolsManager.listTools() for tool resolution
 *   (same manager that AIEmployee uses — see ai-employee.ts:1286)
 * - Depth enforcement via ctx metadata tracking
 * - Per-leader scoping via invoke-time check (core ToolsOptions has no
 *   leaderUsername field, so scoping is enforced in the invoke callback)
 */
export function createDelegateToolsProvider(plugin: any) {
  return async (register: any) => {
    try {
      const configRepo = plugin.db.getRepository('orchestratorConfig');
      if (!configRepo) return;

      const configs = await configRepo.find({
        filter: { enabled: true },
      });
      if (!configs?.length) return;

      const employeeCache = new Map<string, any>();
      const tools = [];
      const configsBySubAgent = new Map<string, any[]>();
      for (const config of configs) {
        const items = configsBySubAgent.get(config.subAgentUsername) || [];
        items.push(config);
        configsBySubAgent.set(config.subAgentUsername, items);
      }

      for (const config of configs) {
        const { leaderUsername, subAgentUsername, maxDepth, timeout } = config;

        // Fetch the sub-agent employee model for its description and LLM config
        let subAgentEmployee = employeeCache.get(subAgentUsername);
        if (!subAgentEmployee) {
          subAgentEmployee = await plugin.db.getRepository('aiEmployees').findOne({
            filter: { username: subAgentUsername },
          });
          if (subAgentEmployee) {
            employeeCache.set(subAgentUsername, subAgentEmployee);
          }
        }
        if (!subAgentEmployee) continue;

        const toolName = buildDelegateToolName(leaderUsername, subAgentUsername);
        tools.push(createDelegateToolOptions(plugin, {
          leaderUsername,
          subAgentUsername,
          subAgentEmployee,
          maxDepth,
          timeout,
          toolName,
        }));
      }

      // Compatibility for existing single-parent setups that already assigned
      // delegate_to_<sub> to the parent employee's skills.
      for (const [subAgentUsername, items] of configsBySubAgent.entries()) {
        if (items.length !== 1) continue;
        const config = items[0];
        const subAgentEmployee = employeeCache.get(subAgentUsername);
        if (!subAgentEmployee) continue;
        const legacyToolName = `delegate_to_${sanitizeToolPart(subAgentUsername)}`;
        if (tools.some((tool: any) => tool.definition.name === legacyToolName)) continue;
        tools.push(createDelegateToolOptions(plugin, {
          leaderUsername: config.leaderUsername,
          subAgentUsername,
          subAgentEmployee,
          maxDepth: config.maxDepth,
          timeout: config.timeout,
          toolName: legacyToolName,
          legacyAlias: true,
        }));
      }

      if (tools.length) {
        register.registerTools(tools);
      }
    } catch (e) {
      plugin.app.log.error('[AgentOrchestrator] Failed to register delegate tools', e);
    }
  };
}

/**
 * Core execution logic using createReactAgent (public LangGraph API).
 *
 * This approach mirrors plugin-sub-agent's proven pattern:
 *  1. Get LLM model via aiPlugin.aiManager.getLLMService()
 *  2. Resolve sub-agent's tools via core app.aiManager.toolsManager.listTools()
 *  3. Build a standalone createReactAgent with the model + tools
 *  4. Stream results and extract final AI message
 *
 * Tool resolution uses the CORE toolsManager (app.aiManager.toolsManager) —
 * the same manager that AIEmployee.getToolsMap() uses (see ai-employee.ts:1286).
 * This ensures tool names in skillSettings.skills[].name match correctly.
 *
 * skillSettings.skills shape (verified against ai-employee.ts:1028):
 *   { name: string, autoCall: boolean }[]
 */
async function invokeDelegateTask(
  ctx: Context,
  plugin: any,
  options: {
    leaderUsername: string;
    subAgentUsername: string;
    subAgentEmployee: any;
    task: string;
    context?: string;
    maxDepth: number;
    timeout: number;
    toolCallId: string;
    toolName: string;
  },
) {
  const { leaderUsername, subAgentUsername, subAgentEmployee, task, context, maxDepth, timeout, toolCallId, toolName } = options;

  // --- P1: Depth enforcement ---
  const currentDepth: number = (ctx as any)[ORCHESTRATOR_DEPTH_KEY] ?? 0;
  if (currentDepth >= maxDepth) {
    await logDelegation(ctx, plugin, {
      leaderUsername,
      subAgentUsername,
      toolName,
      task,
      context,
      result: '',
      status: 'error',
      depth: currentDepth,
      durationMs: 0,
      error: `Delegation depth limit reached (${currentDepth}/${maxDepth}).`,
    });
    return {
      status: 'error' as const,
      content: `Delegation depth limit reached (${currentDepth}/${maxDepth}). Sub-agent "${subAgentUsername}" cannot delegate further.`,
    };
  }

  const startTime = Date.now();
  const trace: TraceEvent[] = [
    {
      type: 'start',
      at: nowIso(),
      title: `Delegation started: ${leaderUsername} -> ${subAgentUsername}`,
      content: task,
    },
  ];
  const logRecord = await logDelegation(ctx, plugin, {
    leaderUsername,
    subAgentUsername,
    toolName,
    task,
    context,
    result: '',
    status: 'running',
    depth: currentDepth,
    durationMs: 0,
    trace,
  });

  try {
    const aiPlugin = ctx.app.pm.get('ai') as PluginAIServer;
    if (!aiPlugin) {
      throw new Error('Plugin AI is not installed or enabled');
    }

    // --- Step 1: Resolve LLM model from sub-agent's employee config ---
    const modelSettings = subAgentEmployee.modelSettings;
    if (!modelSettings?.llmService || !modelSettings?.model) {
      throw new Error(`Sub-agent "${subAgentUsername}" has no LLM model configured. Please configure a model in the AI Employee settings.`);
    }

    const { provider } = await aiPlugin.aiManager.getLLMService({
      llmService: modelSettings.llmService,
      model: modelSettings.model,
    });
    const chatModel = provider.createModel();

    // --- Step 2: Resolve tools via CORE toolsManager ---
    // Uses app.aiManager.toolsManager (same as AIEmployee.getToolsMap at ai-employee.ts:1286)
    // NOT plugin-ai's local toolManager (which has a different grouped format).
    const coreToolsManager = ctx.app.aiManager.toolsManager;
    const allTools: ToolsEntry[] = await coreToolsManager.listTools();

    // skillSettings.skills is { name: string, autoCall: boolean }[]
    // (verified at ai-employee.ts:1028-1029)
    const employeeSkills: string[] = (subAgentEmployee.skillSettings?.skills ?? [])
      .map((s: any) => (typeof s === 'string' ? s : s.name))
      .filter(Boolean);

    const langchainTools: DynamicStructuredTool[] = [];

    for (const toolEntry of allTools) {
      const toolName = toolEntry.definition.name;
      if (!toolName) continue;

      // Only include tools that the sub-agent employee is configured to use.
      // Also skip our own delegate_to_* tools to prevent circular delegation
      // (belt-and-suspenders with the depth check above).
      if (!employeeSkills.includes(toolName) || isDelegateToolName(toolName)) {
        continue;
      }

      langchainTools.push(
        new DynamicStructuredTool({
          name: toolName.replace(/[^a-zA-Z0-9_-]/g, '_'),
          description: toolEntry.definition.description || toolName,
          schema: (toolEntry.definition.schema || z.object({})) as any,
          func: async (toolArgs) => {
            // Forward the invoke with depth tracking
            const invokeCtx = Object.create(ctx);
            (invokeCtx as any)[ORCHESTRATOR_DEPTH_KEY] = currentDepth + 1;

            trace.push({
              type: 'tool_call',
              at: nowIso(),
              title: `Calling tool: ${toolEntry.definition.name}`,
              toolName: toolEntry.definition.name,
              args: toolArgs,
            });

            try {
              const res = await toolEntry.invoke(invokeCtx, toolArgs, `orch-${toolCallId}`);
              trace.push({
                type: 'tool_result',
                at: nowIso(),
                title: `Tool finished: ${toolEntry.definition.name}`,
                toolName: toolEntry.definition.name,
                status: res?.status || 'success',
                content: truncateText(res?.content ?? res, 2000),
              });
              if (res?.status === 'error') {
                throw new Error(`Tool <${toolEntry.definition.name}> failed: ${res.content}`);
              }
              return typeof res?.content === 'string' ? res.content : JSON.stringify(res);
            } catch (e: any) {
              trace.push({
                type: 'tool_error',
                at: nowIso(),
                title: `Tool failed: ${toolEntry.definition.name}`,
                toolName: toolEntry.definition.name,
                status: 'error',
                content: e.message,
              });
              throw e;
            }
          },
        }),
      );
    }

    // --- Step 3: Build the agent ---
    const abortController = new AbortController();
    const executor = createReactAgent({
      llm: chatModel,
      tools: langchainTools,
    });

    // --- Step 4: Construct messages ---
    const systemPrompt = subAgentEmployee.chatSettings?.systemPrompt
      || subAgentEmployee.bio
      || `You are an AI assistant named "${subAgentEmployee.nickname || subAgentUsername}". ${subAgentEmployee.about || ''}`;

    const combinedTask = context
      ? `Task: ${task}\n\nContext Provided:\n${context}`
      : `Task: ${task}`;

    // --- Step 5: Execute with timeout + abort ---
    // P3 FIX: AbortController signal cancels the in-flight stream on timeout,
    // preventing continued token consumption after the timeout fires.
    const invokePromise = executeAgent(executor, systemPrompt, combinedTask, abortController.signal);

    const result = await Promise.race([
      invokePromise,
      createTimeout(timeout, subAgentUsername, abortController),
    ]) as AgentExecutionResult;

    const content = result.content || 'Sub-agent completed the task but produced no output.';
    trace.push({
      type: 'finish',
      at: nowIso(),
      title: `Delegation finished: ${subAgentUsername}`,
      status: 'success',
      content: truncateText(content, 2000),
    });

    // Log successful execution for tracing
    await logDelegation(ctx, plugin, {
      id: logRecord?.id,
      leaderUsername,
      subAgentUsername,
      toolName,
      task,
      context,
      result: content,
      status: 'success',
      depth: currentDepth,
      durationMs: Date.now() - startTime,
      trace,
      messages: result.messages,
    });

    return {
      status: 'success' as const,
      content,
    };
  } catch (e) {
    plugin.app.log.error(`[AgentOrchestrator] Sub-agent ${subAgentUsername} failed`, e);

    // Log failed execution for tracing
    await logDelegation(ctx, plugin, {
      id: logRecord?.id,
      leaderUsername,
      subAgentUsername,
      toolName,
      task,
      context,
      result: '',
      status: 'error',
      depth: currentDepth,
      durationMs: Date.now() - startTime,
      error: e.message,
      trace: [
        ...trace,
        {
          type: 'error',
          at: nowIso(),
          title: `Delegation failed: ${subAgentUsername}`,
          status: 'error',
          content: e.message,
        },
      ],
    }).catch((logErr) => {
      plugin.app.log.warn('[AgentOrchestrator] Failed to save error log for delegation', logErr);
    });

    return {
      status: 'error' as const,
      content: `Sub-agent "${subAgentUsername}" failed: ${e.message}`,
    };
  }
}

/**
 * Log a delegation event to the orchestratorLogs collection for observability.
 */
async function logDelegation(
  ctx: Context,
  plugin: any,
  data: {
    id?: number | string;
    leaderUsername: string;
    subAgentUsername: string;
    toolName: string;
    task: string;
    context?: string;
    result: string;
    status: string;
    depth: number;
    durationMs: number;
    error?: string;
    trace?: TraceEvent[];
    messages?: any[];
  },
) {
  try {
    const logsRepo = plugin.db.getRepository('orchestratorLogs');
    if (!logsRepo) {
      plugin.app.log.warn('[AgentOrchestrator] orchestratorLogs repository not found — skipping log');
      return;
    }

    // Safely resolve userId — ctx may be stale after long-running agent execution
    let userId: number | undefined;
    try {
      userId = ctx.auth?.user?.id || ctx.state?.currentUser?.id;
    } catch {
      // ctx lifecycle ended — proceed without userId
    }

    const values = {
      leaderUsername: data.leaderUsername,
      subAgentUsername: data.subAgentUsername,
      toolName: data.toolName,
      task: truncateText(data.task, 10000),
      context: truncateText(data.context || '', 10000),
      result: truncateText(data.result || '', 50000),
      status: data.status,
      depth: data.depth,
      durationMs: data.durationMs,
      error: truncateText(data.error || '', 10000),
      trace: data.trace || [],
      messages: data.messages || [],
      userId,
      updatedAt: new Date(),
    };

    if (data.id) {
      await logsRepo.update({
        filterByTk: data.id,
        values,
      });
      return { id: data.id };
    }

    const record = await logsRepo.create({
      values: {
        ...values,
        createdAt: new Date(),
      },
    });
    return record?.toJSON?.() || record;
  } catch (e) {
    plugin.app.log.warn('[AgentOrchestrator] Failed to log delegation event', e);
  }
}

/**
 * Execute the agent and extract the final AI message content.
 * Uses executor.invoke to get the final state cleanly, avoiding chunk parsing issues.
 * Accepts an AbortSignal so the execution can be cancelled on timeout.
 */
async function executeAgent(
  executor: any,
  systemPrompt: string,
  task: string,
  signal?: AbortSignal,
): Promise<AgentExecutionResult> {
  const config: any = { recursionLimit: 50 };
  if (signal) {
    config.signal = signal;
  }

  const finalState = await executor.invoke(
    {
      messages: [new SystemMessage(systemPrompt), new HumanMessage(task)],
    },
    config,
  );

  // finalState.messages contains the entire conversation history of this delegation
  const messages = finalState?.messages || [];
  
  // Find the last AI message in the chain
  const lastAIMessage = [...messages].reverse().find(m => m.getType() === 'ai');

  if (!lastAIMessage || !lastAIMessage.content) {
    return { content: '', messages: serializeMessages(messages) };
  }

  let content = '';
  if (typeof lastAIMessage.content === 'string') {
    content = lastAIMessage.content;
  } else if (Array.isArray(lastAIMessage.content)) {
    content = lastAIMessage.content
      .map((c: any) => c.text || JSON.stringify(c))
      .join('\n');
  } else {
    content = String(lastAIMessage.content);
  }

  return { content, messages: serializeMessages(messages) };
}

function serializeMessages(messages: any[]) {
  return (messages || []).map((message, index) => {
    const type = typeof message.getType === 'function' ? message.getType() : message.type;
    return {
      index,
      type,
      name: message.name,
      content: truncateText(message.content, 10000),
      toolCalls: message.tool_calls || message.toolCalls || [],
      toolCallId: message.tool_call_id,
      additionalKwargs: message.additional_kwargs,
      responseMetadata: message.response_metadata,
    };
  });
}

/**
 * Create a timeout promise that rejects after the specified duration.
 * P3 FIX: Also triggers AbortController to cancel the in-flight stream.
 */
function createTimeout(ms: number, agentName: string, abortController?: AbortController): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => {
      abortController?.abort();
      reject(new Error(`Sub-agent "${agentName}" timed out after ${ms / 1000}s`));
    }, ms),
  );
}
