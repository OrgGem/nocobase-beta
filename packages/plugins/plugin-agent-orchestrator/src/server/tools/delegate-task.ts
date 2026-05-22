import { z } from 'zod';
import { createHash } from 'crypto';
import { Context } from '@nocobase/actions';
// @ts-ignore - subpath export types resolve at build time via NocoBase bundler
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type PluginAIServer from '@nocobase/plugin-ai/dist/server';
import type { ToolsEntry } from '@nocobase/ai';
import {
  ExecutionSpanService,
  getOrchestratorTraceContext,
  setOrchestratorTraceContext,
} from '../services/ExecutionSpanService';

/**
 * Maximum delegation depth key stored in ctx metadata.
 * Used to prevent circular/recursive delegation chains.
 */
const ORCHESTRATOR_DEPTH_KEY = '__orchestratorDepth';
/**
 * Context key for tracking the full delegation path.
 * Used to detect and prevent circular delegation chains.
 */
const ORCHESTRATOR_PATH_KEY = '__orchestratorPath';


/** Max sub-agents that the dispatch tool runs concurrently in one call. */
const MAX_DISPATCH_CONCURRENCY = 5;
/** Hard cap on tasks per dispatch call to keep output bounded. */
const MAX_DISPATCH_TASKS = 20;
/** OpenAI/Anthropic tool-name limit. Names exceeding this are silently rejected by providers. */
const MAX_TOOL_NAME_LENGTH = 64;

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

type EmployeeSkillConfig = {
  name: string;
  autoCall: boolean;
};

function sanitizeToolPart(value: string) {
  return (value || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function buildDelegateToolName(leaderUsername: string, subAgentUsername: string) {
  return `delegate_${sanitizeToolPart(leaderUsername)}_to_${sanitizeToolPart(subAgentUsername)}`;
}

function buildDispatchToolName(leaderUsername: string) {
  return `dispatch_subagents_${sanitizeToolPart(leaderUsername)}`;
}

function createRootRunId(seed = '') {
  const hash = createHash('sha1')
    .update(`${Date.now()}::${Math.random()}::${seed}`)
    .digest('hex')
    .slice(0, 10);
  return `run_${Date.now()}_${hash}`;
}

/**
 * Set of tool names this plugin actually registered in the most recent build.
 * Sub-agents must not see these tools (would enable circular delegation), but
 * we don't want to drop unrelated user tools whose names happen to start with
 * "delegate_" — so we filter by the known registry, not a regex pattern.
 */
let registeredDelegateNamesByPlugin: WeakMap<object, ReadonlySet<string>> = new WeakMap();

function isDelegateToolName(plugin: any, toolName: string) {
  return registeredDelegateNamesByPlugin.get(plugin)?.has(toolName) ?? false;
}

/**
 * Run async work over `items` with at most `limit` concurrent executions.
 * Preserves input order in the returned array.
 */
async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const i = cursor;
      cursor += 1;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
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
    llmService?: string;
    model?: string;
    recursionLimit?: number;
  },
) {
  const {
    leaderUsername,
    subAgentUsername,
    subAgentEmployee,
    maxDepth,
    timeout,
    toolName,
    legacyAlias,
    llmService,
    model,
    recursionLimit,
  } = options;
  const dispatchToolName = buildDispatchToolName(leaderUsername);
  const toolDescription = [
    `Delegate a task from "${leaderUsername}" to the AI Employee "${subAgentEmployee.nickname || subAgentUsername}".`,
    legacyAlias ? 'This is a backward-compatible alias for existing skill assignments.' : '',
    subAgentEmployee.about ? `Specialist profile: ${subAgentEmployee.about.substring(0, 200)}` : '',
    'The sub-agent will execute the task independently and return its final answer.',
    `For multiple INDEPENDENT sub-tasks, prefer "${dispatchToolName}" to fan-out in one call (up to ${MAX_DISPATCH_CONCURRENCY} run in parallel), or emit several delegate_* calls in the SAME assistant turn so they run concurrently.`,
  ]
    .filter(Boolean)
    .join(' ');

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
        context: z
          .string()
          .optional()
          .describe('Optional additional context to help the sub-agent understand the task better.'),
      }),
    },
    invoke: async (ctx: Context, args: { task: string; context?: string }, id: string) => {
      const callingEmployee = await resolveCallingEmployee(ctx, plugin);
      if (!callingEmployee) {
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
          error: `Cannot determine calling AI employee for delegation tool "${toolName}".`,
        });
        return {
          status: 'error' as const,
          content: `Cannot determine calling AI employee for "${toolName}". Start the request from an AI Employee conversation so leader scoping can be enforced.`,
        };
      }
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
        llmService,
        model,
        recursionLimit,
      });
    },
  };
}

type DispatchRuleEntry = {
  rule: any;
  employee: any;
};

type DispatchTaskResult = {
  index: number;
  subAgent: string;
  status: 'success' | 'error';
  content: string;
  durationMs: number;
};

function formatDispatchResults(results: DispatchTaskResult[], rulesBySubAgent: Map<string, DispatchRuleEntry>) {
  const total = results.length;
  const ok = results.filter((r) => r.status === 'success').length;
  const lines = [
    `Dispatched ${total} sub-task(s) — ${ok} succeeded, ${
      total - ok
    } failed (max ${MAX_DISPATCH_CONCURRENCY} ran in parallel).`,
    '',
  ];
  for (const r of results) {
    const employee = rulesBySubAgent.get(r.subAgent)?.employee;
    const displayName = employee?.nickname || r.subAgent;
    const dur = `${(r.durationMs / 1000).toFixed(1)}s`;
    lines.push(`--- [${r.index + 1}] ${displayName} (${r.subAgent}) [${r.status}] (${dur}) ---`);
    lines.push(r.content || '(empty)');
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/**
 * Build a single fan-out tool per leader. The leader passes a list of
 * `{ subAgent, task, context? }` items; we run them concurrently (capped at
 * MAX_DISPATCH_CONCURRENCY) and aggregate the results into one response.
 *
 * Each underlying execution still goes through `invokeDelegateTask`, so depth
 * limits, per-rule timeouts, LLM overrides, and orchestratorLogs entries
 * behave identically to a direct `delegate_*_to_*` call.
 */
function createDispatchToolOptions(
  plugin: any,
  options: {
    leaderUsername: string;
    rulesBySubAgent: Map<string, DispatchRuleEntry>;
  },
) {
  const { leaderUsername, rulesBySubAgent } = options;
  const toolName = buildDispatchToolName(leaderUsername);
  const subAgentNames = Array.from(rulesBySubAgent.keys());

  const subAgentList = subAgentNames
    .map((username) => {
      const entry = rulesBySubAgent.get(username);
      if (!entry) return `- ${username}`;
      const profile = entry.employee?.about ? ` — ${String(entry.employee.about).substring(0, 120)}` : '';
      const display = entry.employee?.nickname ? ` (${entry.employee.nickname})` : '';
      return `- ${username}${display}${profile}`;
    })
    .join('\n');

  const description = [
    `Dispatch multiple tasks from "${leaderUsername}" to its configured sub-agents in one call.`,
    `At most ${MAX_DISPATCH_CONCURRENCY} sub-tasks run in parallel; up to ${MAX_DISPATCH_TASKS} tasks per call.`,
    'Use this when you have already planned independent sub-tasks and want to fan-out, then aggregate the results.',
    `Available sub-agents:\n${subAgentList}`,
  ].join(' ');

  return {
    scope: 'CUSTOM',
    execution: 'backend',
    defaultPermission: 'ALLOW',
    silence: false,
    introduction: {
      title: `[${leaderUsername}] Dispatch sub-agents`,
      about: description,
    },
    definition: {
      name: toolName,
      description,
      schema: z.object({
        tasks: z
          .array(
            z.object({
              subAgent: z
                .enum(subAgentNames as [string, ...string[]])
                .describe('Username of the sub-agent that should execute this task.'),
              task: z.string().describe('Detailed task description for the sub-agent.'),
              context: z.string().optional().describe('Optional additional context for the sub-agent.'),
            }),
          )
          .min(1)
          .max(MAX_DISPATCH_TASKS)
          .describe(`List of sub-tasks to dispatch concurrently. Up to ${MAX_DISPATCH_CONCURRENCY} run in parallel.`),
      }),
    },
    invoke: async (
      ctx: Context,
      args: { tasks: Array<{ subAgent: string; task: string; context?: string }> },
      id: string,
    ) => {
      const callingEmployee = await resolveCallingEmployee(ctx, plugin);
      if (!callingEmployee) {
        const distinctSubs = Array.from(new Set((args.tasks ?? []).map((t) => t.subAgent).filter(Boolean)));
        const reportedSub = distinctSubs.length === 1 ? distinctSubs[0] : '(multiple)';
        await logDelegation(ctx, plugin, {
          leaderUsername,
          subAgentUsername: reportedSub,
          toolName,
          task: truncateText(args.tasks ?? [], 2000),
          result: '',
          status: 'error',
          depth: (ctx as any)[ORCHESTRATOR_DEPTH_KEY] ?? 0,
          durationMs: 0,
          error: `Cannot determine calling AI employee for dispatch tool "${toolName}". Targets: ${
            distinctSubs.join(', ') || '(empty)'
          }.`,
        });
        return {
          status: 'error' as const,
          content: `Cannot determine calling AI employee for "${toolName}". Start the request from an AI Employee conversation so leader scoping can be enforced.`,
        };
      }
      if (callingEmployee && callingEmployee !== leaderUsername) {
        // Mirror the per-rule delegate tool: persist the rejection to
        // orchestratorLogs so admins can investigate via the Tracing tab.
        const distinctSubs = Array.from(new Set((args.tasks ?? []).map((t) => t.subAgent).filter(Boolean)));
        const reportedSub = distinctSubs.length === 1 ? distinctSubs[0] : '(multiple)';
        await logDelegation(ctx, plugin, {
          leaderUsername,
          subAgentUsername: reportedSub,
          toolName,
          task: truncateText(args.tasks ?? [], 2000),
          result: '',
          status: 'error',
          depth: (ctx as any)[ORCHESTRATOR_DEPTH_KEY] ?? 0,
          durationMs: 0,
          error: `Employee "${callingEmployee}" is not authorized to dispatch sub-agents for leader "${leaderUsername}". Targets: ${
            distinctSubs.join(', ') || '(empty)'
          }.`,
        });
        return {
          status: 'error' as const,
          content: `Employee "${callingEmployee}" is not authorized to dispatch sub-agents for leader "${leaderUsername}".`,
        };
      }

      const tasks = args.tasks ?? [];
      if (!tasks.length) {
        return {
          status: 'error' as const,
          content: 'No tasks provided. Pass at least one item in `tasks`.',
        };
      }

      const dispatchRootRunId =
        getOrchestratorTraceContext(ctx)?.rootRunId || createRootRunId(`${leaderUsername}:dispatch`);

      const results = await runWithConcurrency<
        { subAgent: string; task: string; context?: string },
        DispatchTaskResult
      >(tasks, MAX_DISPATCH_CONCURRENCY, async (item, i) => {
        const startedAt = Date.now();
        const entry = rulesBySubAgent.get(item.subAgent);
        if (!entry) {
          return {
            index: i,
            subAgent: item.subAgent,
            status: 'error',
            content: `Unknown sub-agent "${item.subAgent}". Allowed: ${subAgentNames.join(', ')}.`,
            durationMs: 0,
          };
        }

        try {
          const res = await invokeDelegateTask(ctx, plugin, {
            leaderUsername,
            subAgentUsername: item.subAgent,
            subAgentEmployee: entry.employee,
            task: item.task,
            context: item.context,
            maxDepth: entry.rule.maxDepth ?? 1,
            timeout: entry.rule.timeout ?? 120000,
            toolCallId: `${id}-${i}`,
            toolName,
            llmService: entry.rule.llmService,
            model: entry.rule.model,
            recursionLimit: entry.rule.recursionLimit,
            rootRunId: dispatchRootRunId,
          });
          return {
            index: i,
            subAgent: item.subAgent,
            status: res.status,
            content: res.content,
            durationMs: Date.now() - startedAt,
          };
        } catch (e: any) {
          return {
            index: i,
            subAgent: item.subAgent,
            status: 'error',
            content: e?.message || String(e),
            durationMs: Date.now() - startedAt,
          };
        }
      });

      const successCount = results.filter((r) => r.status === 'success').length;
      return {
        status: (successCount > 0 ? 'success' : 'error') as 'success' | 'error',
        content: formatDispatchResults(results, rulesBySubAgent),
      };
    },
  };
}

type CtxSnapshot = {
  userId?: number;
};

/**
 * Read the few ctx fields we depend on once, before kicking off the long-running
 * sub-agent. Avoids "ctx is destroyed" or stale-state issues when we later
 * write the orchestratorLogs row from inside the agent's execution promise.
 */
function captureCtxSnapshot(ctx: Context): CtxSnapshot {
  let userId: number | undefined;
  try {
    userId = (ctx as any).auth?.user?.id || (ctx as any).state?.currentUser?.id;
  } catch {
    // ctx already disposed — nothing to capture.
  }
  return { userId };
}

function normalizeEmployeeUsername(raw: any) {
  if (!raw) return null;
  if (typeof raw === 'string') return raw;
  return raw.username || raw.aiEmployeeUsername || raw.name || null;
}

async function resolveCallingEmployee(ctx: Context, plugin: any) {
  const values = (ctx as any).action?.params?.values || {};
  const raw =
    (ctx as any)._currentAIEmployee ||
    (ctx as any).state?.currentAIEmployee ||
    (ctx as any).runtime?.context?.currentAIEmployee ||
    values.aiEmployee;

  const direct = normalizeEmployeeUsername(raw);
  if (direct) return direct;

  const sessionId = values.sessionId || (ctx as any).action?.params?.sessionId;
  if (!sessionId) return null;

  try {
    const repo = (ctx as any).db?.getRepository?.('aiConversations') || plugin.db.getRepository('aiConversations');
    const conversation = await repo.findOne({
      filter: { sessionId },
    });
    return normalizeEmployeeUsername(conversation?.aiEmployeeUsername || conversation?.get?.('aiEmployeeUsername'));
  } catch (e) {
    plugin.app.log.warn(`[AgentOrchestrator] Failed to resolve AI employee for session "${sessionId}"`, e);
    return null;
  }
}

function truncateText(value: any, maxLen: number) {
  const text = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
  return text.length > maxLen ? `${text.slice(0, maxLen)}\n...[truncated]` : text;
}

function nowIso() {
  return new Date().toISOString();
}

function hasModelSettings(value: any): value is { llmService: string; model: string } {
  return Boolean(value?.llmService && value?.model);
}

/**
 * Cache for built delegate tool descriptors to avoid re-querying DB on every
 * core toolsManager.listTools() call (which can fire many times per chat turn).
 *
 * - TTL is a safety net in case event hooks miss an external write path.
 * - DB hooks invalidate immediately on rule/employee changes so admin edits
 *   take effect on the next request.
 */
const TOOLS_CACHE_TTL_MS = 30_000;
let toolsCacheByPlugin: WeakMap<object, { tools: any[]; expiresAt: number }> = new WeakMap();
let hooksAttached: WeakSet<object> | null = null;

function attachInvalidationHooks(plugin: any) {
  // Attach once per plugin instance (handles dev hot-reload safely).
  if (!hooksAttached) hooksAttached = new WeakSet<object>();
  if (hooksAttached.has(plugin)) return;
  hooksAttached.add(plugin);

  const invalidate = () => {
    toolsCacheByPlugin.delete(plugin);
    registeredDelegateNamesByPlugin.delete(plugin);
  };
  plugin.db.on('orchestratorConfig.afterCreate', invalidate);
  plugin.db.on('orchestratorConfig.afterUpdate', invalidate);
  plugin.db.on('orchestratorConfig.afterDestroy', invalidate);
  plugin.db.on('aiEmployees.afterCreate', invalidate);
  plugin.db.on('aiEmployees.afterUpdate', invalidate);
  plugin.db.on('aiEmployees.afterDestroy', invalidate);
}

async function buildDelegateTools(plugin: any) {
  const configRepo = plugin.db.getRepository('orchestratorConfig');
  if (!configRepo) {
    registeredDelegateNamesByPlugin.set(plugin, new Set());
    return [];
  }

  const configs = await configRepo.find({
    filter: { enabled: true },
  });
  if (!configs?.length) {
    registeredDelegateNamesByPlugin.set(plugin, new Set());
    return [];
  }

  const employeeCache = new Map<string, any>();
  const tools: any[] = [];
  // Track every generated tool name to surface sanitize() collisions
  // (e.g. "pm-1" and "pm.1" both → "pm_1"). Collisions are skipped + logged.
  const generatedNames = new Map<string, { leader: string; sub: string }>();
  const configsBySubAgent = new Map<string, any[]>();
  for (const config of configs) {
    const items = configsBySubAgent.get(config.subAgentUsername) || [];
    items.push(config);
    configsBySubAgent.set(config.subAgentUsername, items);
  }

  for (const config of configs) {
    const { leaderUsername, subAgentUsername, maxDepth, timeout, recursionLimit } = config;

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
    if (toolName.length > MAX_TOOL_NAME_LENGTH) {
      plugin.app.log.error(
        `[AgentOrchestrator] Tool name "${toolName}" exceeds the ${MAX_TOOL_NAME_LENGTH}-char limit enforced by most LLM providers. Skipping rule (${leaderUsername} → ${subAgentUsername}). Shorten one of the usernames.`,
      );
      continue;
    }
    const existing = generatedNames.get(toolName);
    if (existing) {
      const suffix = createHash('sha1').update(`${leaderUsername}::${subAgentUsername}`).digest('hex').slice(0, 6);
      plugin.app.log.error(
        `[AgentOrchestrator] Tool-name collision: rule (${leaderUsername} → ${subAgentUsername}) sanitizes to "${toolName}", same as (${existing.leader} → ${existing.sub}). Skipping duplicate registration. Rename one of the usernames or apply suffix "_${suffix}" manually.`,
      );
      continue;
    }
    generatedNames.set(toolName, { leader: leaderUsername, sub: subAgentUsername });
    tools.push(
      createDelegateToolOptions(plugin, {
        leaderUsername,
        subAgentUsername,
        subAgentEmployee,
        maxDepth,
        timeout,
        toolName,
        llmService: config.llmService,
        model: config.model,
        recursionLimit,
      }),
    );
  }

  // Compatibility for existing single-parent setups that already assigned
  // delegate_to_<sub> to the parent employee's skills.
  for (const [subAgentUsername, items] of configsBySubAgent.entries()) {
    if (items.length !== 1) {
      // Multiple leaders for the same sub-agent ⇒ alias is ambiguous.
      // Surface it so admins know why old skill assignments may stop working.
      const leaders = items.map((c: any) => c.leaderUsername).join(', ');
      plugin.app.log.warn(
        `[AgentOrchestrator] Legacy alias "delegate_to_${sanitizeToolPart(
          subAgentUsername,
        )}" is NOT registered for sub-agent "${subAgentUsername}" because it has multiple leaders (${leaders}). Leaders must use the per-rule "delegate_<leader>_to_<sub>" tool name.`,
      );
      continue;
    }
    const config = items[0];
    const subAgentEmployee = employeeCache.get(subAgentUsername);
    if (!subAgentEmployee) continue;
    const legacyToolName = `delegate_to_${sanitizeToolPart(subAgentUsername)}`;
    if (legacyToolName.length > MAX_TOOL_NAME_LENGTH) {
      plugin.app.log.error(
        `[AgentOrchestrator] Legacy alias "${legacyToolName}" exceeds the ${MAX_TOOL_NAME_LENGTH}-char limit. Skipping alias for sub-agent "${subAgentUsername}".`,
      );
      continue;
    }
    const aliasExisting = generatedNames.get(legacyToolName);
    if (aliasExisting) {
      plugin.app.log.error(
        `[AgentOrchestrator] Legacy alias "${legacyToolName}" collides with another rule (${aliasExisting.leader} → ${aliasExisting.sub}). Skipping alias registration.`,
      );
      continue;
    }
    generatedNames.set(legacyToolName, {
      leader: config.leaderUsername,
      sub: subAgentUsername,
    });
    tools.push(
      createDelegateToolOptions(plugin, {
        leaderUsername: config.leaderUsername,
        subAgentUsername,
        subAgentEmployee,
        maxDepth: config.maxDepth,
        timeout: config.timeout,
        toolName: legacyToolName,
        legacyAlias: true,
        llmService: config.llmService,
        model: config.model,
        recursionLimit: config.recursionLimit,
      }),
    );
  }

  // One dispatch fan-out tool per leader.
  const rulesByLeader = new Map<string, Map<string, DispatchRuleEntry>>();
  for (const config of configs) {
    const subAgentEmployee = employeeCache.get(config.subAgentUsername);
    if (!subAgentEmployee) continue;
    let bucket = rulesByLeader.get(config.leaderUsername);
    if (!bucket) {
      bucket = new Map<string, DispatchRuleEntry>();
      rulesByLeader.set(config.leaderUsername, bucket);
    }
    bucket.set(config.subAgentUsername, { rule: config, employee: subAgentEmployee });
  }
  for (const [leaderUsername, rulesBySubAgent] of rulesByLeader.entries()) {
    if (!rulesBySubAgent.size) continue;
    const dispatchToolName = buildDispatchToolName(leaderUsername);
    if (dispatchToolName.length > MAX_TOOL_NAME_LENGTH) {
      plugin.app.log.error(
        `[AgentOrchestrator] Dispatch tool "${dispatchToolName}" exceeds the ${MAX_TOOL_NAME_LENGTH}-char limit. Skipping for leader "${leaderUsername}".`,
      );
      continue;
    }
    const dispatchExisting = generatedNames.get(dispatchToolName);
    if (dispatchExisting) {
      plugin.app.log.error(
        `[AgentOrchestrator] Dispatch tool "${dispatchToolName}" collides with another generated tool (${dispatchExisting.leader} → ${dispatchExisting.sub}). Skipping dispatch registration for leader "${leaderUsername}".`,
      );
      continue;
    }
    generatedNames.set(dispatchToolName, { leader: leaderUsername, sub: '(dispatch)' });
    tools.push(createDispatchToolOptions(plugin, { leaderUsername, rulesBySubAgent }));
  }

  // Refresh the registry that `isDelegateToolName` consults so sub-agents
  // running concurrently filter exactly the names we just registered.
  registeredDelegateNamesByPlugin.set(plugin, new Set(generatedNames.keys()));

  return tools;
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
  attachInvalidationHooks(plugin);

  return async (register: any) => {
    try {
      let toolsCache = toolsCacheByPlugin.get(plugin);
      if (!toolsCache || toolsCache.expiresAt <= Date.now()) {
        const tools = await buildDelegateTools(plugin);
        toolsCache = { tools, expiresAt: Date.now() + TOOLS_CACHE_TTL_MS };
        toolsCacheByPlugin.set(plugin, toolsCache);
      }

      if (toolsCache.tools.length) {
        register.registerTools(toolsCache.tools);
      }
    } catch (e) {
      plugin.app.log.error('[AgentOrchestrator] Failed to register delegate tools', e);
    }
  };
}

/**
 * Test/internal helper to drop the in-memory tool cache (e.g., from a CLI op).
 */
export function invalidateDelegateToolsCache() {
  toolsCacheByPlugin = new WeakMap();
  registeredDelegateNamesByPlugin = new WeakMap();
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
    llmService?: string;
    model?: string;
    recursionLimit?: number;
    rootRunId?: string;
    parentSpanId?: string;
  },
) {
  const {
    leaderUsername,
    subAgentUsername,
    subAgentEmployee,
    task,
    context,
    maxDepth,
    timeout,
    toolCallId,
    toolName,
    llmService,
    model,
    recursionLimit,
    rootRunId: providedRootRunId,
    parentSpanId: providedParentSpanId,
  } = options;

  // --- Snapshot ctx fields up-front ---
  // Long-running agent execution (up to `timeout` ms) outlives the parent HTTP
  // request, so middleware may have cleared `ctx.auth`, `ctx.state`, or even
  // disposed the underlying socket by the time we finalize the log row.
  // Capturing the values once here keeps log/audit fields stable.
  const ctxSnapshot = captureCtxSnapshot(ctx);

  // --- P1: Depth enforcement & Circular Delegation Detection ---
  const currentDepth: number = (ctx as any)[ORCHESTRATOR_DEPTH_KEY] ?? 0;
  const currentPath: string[] = (ctx as any)[ORCHESTRATOR_PATH_KEY] ?? [leaderUsername];

  if (currentPath.includes(subAgentUsername)) {
    const loopChain = [...currentPath, subAgentUsername].join(' -> ');
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
      error: `Circular delegation detected: ${loopChain}.`,
      snapshot: ctxSnapshot,
    });
    return {
      status: 'error' as const,
      content: `Circular delegation detected: ${loopChain}. Execution aborted to prevent infinite reasoning loops.`,
    };
  }

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
      snapshot: ctxSnapshot,
    });
    return {
      status: 'error' as const,
      content: `Delegation depth limit reached (${currentDepth}/${maxDepth}). Sub-agent "${subAgentUsername}" cannot delegate further.`,
    };
  }

  const spanService = new ExecutionSpanService(plugin);
  const upstreamTraceContext = getOrchestratorTraceContext(ctx);
  const rootRunId =
    providedRootRunId || upstreamTraceContext?.rootRunId || createRootRunId(`${leaderUsername}:${subAgentUsername}`);
  const parentSpanId = providedParentSpanId || upstreamTraceContext?.spanId || upstreamTraceContext?.parentSpanId;
  const startTime = Date.now();
  const trace: TraceEvent[] = [
    {
      type: 'start',
      at: nowIso(),
      title: `Delegation started: ${leaderUsername} -> ${subAgentUsername}`,
      content: task,
    },
  ];
  const executionSpan = await spanService.create({
    rootRunId,
    parentSpanId,
    type: 'sub_agent',
    status: 'running',
    leaderUsername,
    employeeUsername: subAgentUsername,
    title: `Delegation: ${leaderUsername} -> ${subAgentUsername}`,
    input: { task, context },
    metadata: {
      depth: currentDepth,
      maxDepth,
      toolName,
      recursionLimit,
      llmOverride: llmService && model ? { llmService, model } : undefined,
    },
    userId: ctxSnapshot.userId,
  });
  const executionSpanId = executionSpan?.id ? String(executionSpan.id) : undefined;
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
    snapshot: ctxSnapshot,
  });
  if (executionSpanId && logRecord?.id) {
    await spanService.update(executionSpanId, { orchestratorLogId: logRecord.id });
  }

  try {
    const aiPlugin = ctx.app.pm.get('ai') as PluginAIServer;
    if (!aiPlugin) {
      throw new Error('Plugin AI is not installed or enabled');
    }

    // --- Step 1: Resolve LLM model from sub-agent's employee config ---
    let modelSettings = hasModelSettings(subAgentEmployee.modelSettings) ? subAgentEmployee.modelSettings : undefined;

    // Override with orchestrator config if provided
    if (llmService && model) {
      modelSettings = { llmService, model };
    }

    if (!hasModelSettings(modelSettings)) {
      // Fallback to leader's LLM model if sub-agent doesn't have one
      const leaderEmployee = await plugin.db.getRepository('aiEmployees').findOne({
        filter: { username: leaderUsername },
      });

      // The leader's model might be empty in the DB if it relies on the dynamic system default.
      // In that case, we extract the dynamic `model` passed from the frontend request.
      const dynamicModel = ctx.action?.params?.values?.model;
      modelSettings = hasModelSettings(leaderEmployee?.modelSettings)
        ? leaderEmployee.modelSettings
        : hasModelSettings(dynamicModel)
          ? dynamicModel
          : undefined;

      if (!hasModelSettings(modelSettings)) {
        throw new Error(
          `Sub-agent "${subAgentUsername}" has no LLM model configured (and leader fallback failed). Please configure a model in the Orchestrator Config or AI Employee settings.`,
        );
      }
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
    const employeeSkills: EmployeeSkillConfig[] = (subAgentEmployee.skillSettings?.skills ?? [])
      .map((s: any) =>
        typeof s === 'string'
          ? { name: s, autoCall: false }
          : { name: s?.name, autoCall: s?.autoCall === true },
      )
      .filter((s: EmployeeSkillConfig) => Boolean(s.name));
    const employeeSkillMap = new Map(employeeSkills.map((skill) => [skill.name, skill]));

    const langchainTools: DynamicStructuredTool[] = [];

    for (const toolEntry of allTools) {
      const entryName = toolEntry.definition.name;
      if (!entryName) continue;
      const employeeSkill = employeeSkillMap.get(entryName);

      // Only include tools that the sub-agent employee is configured to use.
      // Also skip our own orchestration tools to prevent circular delegation
      // (belt-and-suspenders with the depth check above).
      //
      // Headless sub-agent execution has no human confirmation surface, so we
      // require both the employee assignment and the tool definition to be
      // explicitly auto-callable. This prevents ASK/interactionSchema Skill Hub
      // tools from being executed silently by a delegated sub-agent.
      if (
        !employeeSkill ||
        isDelegateToolName(plugin, entryName) ||
        employeeSkill.autoCall !== true
      ) {
        continue;
      }

      langchainTools.push(
        new DynamicStructuredTool({
          name: entryName.replace(/[^a-zA-Z0-9_-]/g, '_'),
          description: toolEntry.definition.description || entryName,
          schema: (toolEntry.definition.schema || z.object({})) as any,
          func: async (toolArgs) => {
            // Forward the invoke with depth tracking, circular path tracking and identity overrides
            const invokeCtx = Object.create(ctx);
            (invokeCtx as any)[ORCHESTRATOR_DEPTH_KEY] = currentDepth + 1;
            (invokeCtx as any)[ORCHESTRATOR_PATH_KEY] = [...currentPath, subAgentUsername];
            (invokeCtx as any)._currentAIEmployee = subAgentUsername;
            if (ctx.state) {
              invokeCtx.state = Object.create(ctx.state);
              invokeCtx.state.currentAIEmployee = subAgentUsername;
            }
            const toolStartedAt = Date.now();
            const isSkillHubTool = entryName === 'skill_hub_execute' || entryName.startsWith('skill_hub_');
            const toolSpan = await spanService.create({
              rootRunId,
              parentSpanId: executionSpanId,
              type: isSkillHubTool ? 'skill' : 'tool',
              status: 'running',
              leaderUsername,
              employeeUsername: subAgentUsername,
              toolName: toolEntry.definition.name,
              title: isSkillHubTool ? `Skill: ${toolEntry.definition.name}` : `Tool: ${toolEntry.definition.name}`,
              input: toolArgs,
              metadata: {
                depth: currentDepth + 1,
                toolCallId: `orch-${toolCallId}`,
                defaultPermission: toolEntry.defaultPermission,
              },
              userId: ctxSnapshot.userId,
            });
            const toolSpanId = toolSpan?.id ? String(toolSpan.id) : undefined;
            setOrchestratorTraceContext(invokeCtx, {
              rootRunId,
              spanId: toolSpanId,
              parentSpanId: executionSpanId,
              toolCallId: `orch-${toolCallId}`,
              leaderUsername,
              employeeUsername: subAgentUsername,
              toolName: toolEntry.definition.name,
            });

            trace.push({
              type: 'tool_call',
              at: nowIso(),
              title: `Calling tool: ${toolEntry.definition.name}`,
              toolName: toolEntry.definition.name,
              args: toolArgs,
            });

            try {
              const res = await toolEntry.invoke(invokeCtx, toolArgs, `orch-${toolCallId}`);
              const output = truncateText(res?.content ?? res?.result ?? res, 50000);
              trace.push({
                type: 'tool_result',
                at: nowIso(),
                title: `Tool finished: ${toolEntry.definition.name}`,
                toolName: toolEntry.definition.name,
                status: res?.status || 'success',
                content: truncateText(output, 2000),
              });
              if (res?.status === 'error') {
                await spanService.finish(toolSpanId, 'error', toolStartedAt, {
                  output,
                  error: truncateText(res.content || output, 10000),
                });
                throw new Error(`Tool <${toolEntry.definition.name}> failed: ${res.content}`);
              }
              await spanService.finish(toolSpanId, 'success', toolStartedAt, {
                output,
                skillExecutionId: res?.result?.execId || res?.execId,
              });
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
              await spanService.finish(toolSpanId, 'error', toolStartedAt, {
                error: truncateText(e.message, 10000),
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
    let systemPrompt =
      subAgentEmployee.chatSettings?.systemPrompt ||
      subAgentEmployee.bio ||
      `You are an AI assistant named "${subAgentEmployee.nickname || subAgentUsername}". ${
        subAgentEmployee.about || ''
      }`;

    // --- Step 4b: Inject shared context from Knowledge Base (soft dependency) ---
    // If plugin-knowledge-base is installed, inject the session context summary
    // so the sub-agent is aware of findings from previous agents in this run.
    try {
      const kbPlugin = ctx.app.pm.get('plugin-knowledge-base') as any;
      if (kbPlugin?.sessionContext) {
        const sessionId =
          ctx.action?.params?.values?.sessionId ||
          ctx.action?.params?.sessionId ||
          ctx.state?.sessionId;

        const contextSummary = await kbPlugin.sessionContext.buildSummary(
          { rootRunId, ...(sessionId ? { sessionId } : {}) },
          6000,
        );
        if (contextSummary) {
          systemPrompt += `\n\n<shared_context>\nThe following context was shared by other agents in this workflow. Use it to avoid redundant work:\n${contextSummary}\n</shared_context>`;
        }
      }
    } catch (e: any) {
      // Graceful fallback — never block delegation due to context injection failure.
      ctx.app.log?.debug?.(`[AgentOrchestrator] Shared context injection skipped: ${e.message}`);
    }

    const combinedTask = context ? `Task: ${task}\n\nContext Provided:\n${context}` : `Task: ${task}`;

    // --- Step 5: Execute with timeout + abort ---
    // P3 FIX: AbortController signal cancels the in-flight stream on timeout,
    // preventing continued token consumption after the timeout fires.
    const effectiveRecursionLimit =
      Number.isFinite(recursionLimit) && (recursionLimit as number) > 0 ? (recursionLimit as number) : 50;
    const invokePromise = executeAgent(
      executor,
      systemPrompt,
      combinedTask,
      abortController.signal,
      effectiveRecursionLimit,
    );

    const timeoutHandle = createTimeout(timeout, subAgentUsername, abortController);
    let result: AgentExecutionResult;
    try {
      result = (await Promise.race([invokePromise, timeoutHandle.promise])) as AgentExecutionResult;
    } finally {
      // Always release the timer so it doesn't keep the event loop alive.
      timeoutHandle.cancel();
    }

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
      snapshot: ctxSnapshot,
    });
    await spanService.finish(executionSpanId, 'success', startTime, {
      output: content,
      metadata: {
        depth: currentDepth,
        maxDepth,
        toolName,
        recursionLimit,
        messages: result.messages,
        traceCount: trace.length,
      },
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
      snapshot: ctxSnapshot,
    }).catch((logErr) => {
      plugin.app.log.warn('[AgentOrchestrator] Failed to save error log for delegation', logErr);
    });
    await spanService.finish(executionSpanId, 'error', startTime, {
      error: truncateText(e.message, 10000),
      metadata: {
        depth: currentDepth,
        maxDepth,
        toolName,
        recursionLimit,
        traceCount: trace.length + 1,
      },
    });

    const diagnosticTrace = trace
      .filter((t) => t.type === 'tool_error' || t.type === 'error')
      .map((t) => `[${t.toolName ? `Tool: ${t.toolName}` : 'Sub-agent'}] Error: ${t.content || t.title}`)
      .join('\n');

    const formattedError = [
      `Sub-agent "${subAgentUsername}" failed execution: ${e.message}`,
      diagnosticTrace ? `\nDiagnostic Details of internal failures:\n${diagnosticTrace}` : '',
      `Suggestion: Review the tool parameters above or try dividing the task into simpler independent tasks.`,
    ]
      .filter(Boolean)
      .join('\n');

    return {
      status: 'error' as const,
      content: formattedError,
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
    snapshot?: CtxSnapshot;
  },
) {
  try {
    const logsRepo = plugin.db.getRepository('orchestratorLogs');
    if (!logsRepo) {
      plugin.app.log.warn('[AgentOrchestrator] orchestratorLogs repository not found — skipping log');
      return;
    }

    // Prefer the early snapshot captured in invokeDelegateTask — by the time
    // the agent finishes, ctx may already be disposed. Fall back to ctx for
    // call sites that don't pass a snapshot (e.g. authz-failure short-circuit).
    let userId: number | undefined = data.snapshot?.userId;
    if (userId == null) {
      try {
        userId = ctx.auth?.user?.id || ctx.state?.currentUser?.id;
      } catch {
        // ctx lifecycle ended — proceed without userId
      }
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
  recursionLimit = 50,
): Promise<AgentExecutionResult> {
  const config: any = { recursionLimit };
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
  const lastAIMessage = [...messages].reverse().find((m) => m.getType() === 'ai');

  if (!lastAIMessage || !lastAIMessage.content) {
    return { content: '', messages: serializeMessages(messages) };
  }

  let content = '';
  if (typeof lastAIMessage.content === 'string') {
    content = lastAIMessage.content;
  } else if (Array.isArray(lastAIMessage.content)) {
    content = lastAIMessage.content.map((c: any) => c.text || JSON.stringify(c)).join('\n');
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
 * Schedule a rejection-on-timeout that also aborts the in-flight stream.
 * Returns the promise plus a `cancel()` so callers can release the timer
 * when the race resolves successfully (otherwise the handle keeps the event
 * loop alive until `ms` elapses).
 */
function createTimeout(
  ms: number,
  agentName: string,
  abortController?: AbortController,
): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      abortController?.abort();
      reject(new Error(`Sub-agent "${agentName}" timed out after ${ms / 1000}s`));
    }, ms);
  });
  return {
    promise,
    cancel: () => {
      if (timer) clearTimeout(timer);
    },
  };
}
