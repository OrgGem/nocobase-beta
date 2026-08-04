import type { Model } from '@nocobase/database';
import type { Application } from '@nocobase/server';
import { AIEmployee } from '@nocobase/plugin-ai/server';
import { listSystemTools } from '@nocobase/ai';
import { getAIToolsManager } from '../utils/ai-manager';
import { decideTool } from './HarnessCompiler';
import type { CompiledHarness } from './HarnessCompiler';

// plugin-ai keeps every tool whose name is in `listSystemTools()` regardless of the constructor
// tool filter (ai-employee.ts getAIEmployeeTools). The harness `filter` cannot remove them, so a
// denied system tool would still reach the model. The adapter neutralizes them at their source
// instead: web search via the `webSearch` constructor flag, knowledge-base retrieval via the
// in-memory `enableKnowledgeBase` employee flag. This maps each system tool to the switch that
// stops plugin-ai from ever adding it.
const SYSTEM_TOOL_WEB_SEARCH = 'subAgentWebSearch';
const SYSTEM_TOOL_KNOWLEDGE_BASE = 'knowledge-base-retrieve';

export type LoopRole = 'leader' | 'maker' | 'verifier';

export type InterruptedToolCall = {
  toolCallId: string;
  toolName: string;
  args: unknown;
  interruptId: string;
};

export type InvocationOutcome = {
  sessionId: string;
  messageId: string;
  interrupted: InterruptedToolCall[];
  content: string;
};

type ConversationsManager = {
  create(input: {
    userId?: number;
    aiEmployee: { username: string };
    title?: string;
    options?: Record<string, unknown>;
    category?: string;
  }): Promise<Model>;
  getUserDecisions(messageId: string): Promise<{ interruptId?: string; decisions: unknown[] } | undefined>;
};

type EmployeesManager = {
  getEmployee(username: string): Promise<Model | null>;
  resolveModel(employee: Model, model?: unknown): Promise<{ llmService: string; model: string }>;
};

type PluginAi = {
  aiConversationsManager: ConversationsManager;
  aiEmployeesManager: EmployeesManager;
};

function read(record: Model | Record<string, unknown>, key: string) {
  const model = record as Model & { get?: (name: string) => unknown };
  return typeof model.get === 'function' ? model.get(key) : (record as Record<string, unknown>)[key];
}

function textContent(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  const last = messages[messages.length - 1] as { content?: unknown } | undefined;
  if (typeof last?.content === 'string') return last.content;
  if (Array.isArray(last?.content)) {
    return last.content
      .map((part) =>
        typeof part === 'object' && part && 'text' in part ? String((part as { text: unknown }).text) : '',
      )
      .join('');
  }
  return '';
}

function interruptedFrom(result: Record<string, unknown>): InterruptedToolCall[] {
  const interrupts = result.__interrupt__;
  if (!Array.isArray(interrupts)) return [];
  const calls: InterruptedToolCall[] = [];
  for (const interrupt of interrupts) {
    const value = (interrupt as { value?: unknown }).value ?? interrupt;
    const record = value as Record<string, unknown>;
    const toolCallId = String(record.toolCallId || record.tool_call_id || '');
    if (!toolCallId) continue;
    calls.push({
      toolCallId,
      toolName: String(record.name || record.toolName || ''),
      args: record.args ?? record.input ?? {},
      interruptId: String((interrupt as { id?: unknown }).id || record.interruptId || ''),
    });
  }
  return calls;
}

// plugin-ai reads the compiled harness through two different channels, and they disagree on shape:
//
//   1. `skillSettings.tools` on the AIEmployee constructor is a `string[]` name filter once
//      `toolsVersion` is set (ai-employee.ts `getAIEmployeeTools`).
//   2. `employee.skillSettings.tools` on the persisted record is a `{ name, autoCall }[]` that both
//      widens the candidate tool set and decides whether a call interrupts (`isAutoCall`).
//
// Passing objects to (1) silently filtered out every tool, because `string[].includes(object)` is
// always false. Both channels are populated here, from the same decision, so a tool is exposed only
// when the harness allows it and interrupts whenever the harness says `ask`.
export type HarnessToolPlan = {
  filter: string[];
  employeeTools: Array<{ name: string; autoCall: boolean }>;
  withheld: Array<{ name: string; reason: string }>;
  // System tools the harness does not grant. They ignore `filter`, so the caller has to disable
  // the feature that injects them rather than relying on the filter to drop them.
  blockedSystemTools: string[];
};

type ToolEntry = { scope?: string; defaultPermission?: string } | undefined;

// `isAutoCall` only consults the employee override for CUSTOM-scope tools; every other scope is
// governed by the tool's own `defaultPermission`. So an `ask` decision is only enforceable when one
// of those two is true. When it is not, the tool is withheld rather than exposed un-gated.
function askIsEnforceable(entry: ToolEntry) {
  return entry?.scope === 'CUSTOM' || entry?.defaultPermission !== 'ALLOW';
}

// Tool discovery must run with the same context plugin-ai uses. `DefaultToolsManager.getTools`
// only consults dynamic providers when a filter is supplied, and the MCP provider registers a
// user's context-scoped tools solely when `filter.ctx` is present. Discovering without it reports
// every MCP tool as unregistered even though `AIEmployee.getToolsMap()` would find it at call time.
export async function planHarnessTools(
  app: Application,
  harness: CompiledHarness,
  discovery?: { ctx?: unknown; sessionId?: string },
): Promise<HarnessToolPlan> {
  const toolsManager = getAIToolsManager(app);
  const candidates = Array.from(new Set([...harness.tools.allow, ...harness.tools.ask]));
  const plan: HarnessToolPlan = { filter: [], employeeTools: [], withheld: [], blockedSystemTools: [] };
  const filter = discovery ? { ctx: discovery.ctx, sessionId: discovery.sessionId } : undefined;

  for (const name of candidates.sort()) {
    const decision = decideTool(harness, name);
    if (decision === 'deny') {
      plan.withheld.push({ name, reason: 'denied by harness' });
      continue;
    }
    const entry = (await toolsManager.getTools(name, filter)) as ToolEntry;
    if (!entry) {
      plan.withheld.push({ name, reason: 'not registered with plugin-ai' });
      continue;
    }
    if (decision === 'ask' && !askIsEnforceable(entry)) {
      plan.withheld.push({ name, reason: 'approval cannot be enforced for this tool' });
      continue;
    }
    plan.filter.push(name);
    plan.employeeTools.push({ name, autoCall: decision === 'allow' });
  }

  const granted = new Set(plan.filter);
  plan.blockedSystemTools = listSystemTools()
    .filter((name) => !granted.has(name))
    .sort();
  return plan;
}

export class PluginAiRuntimeAdapter {
  constructor(private readonly app: Application) {}

  private plugin(): PluginAi {
    const plugin = this.app.pm.get('ai') as unknown as PluginAi | undefined;
    if (!plugin?.aiEmployeesManager || !plugin?.aiConversationsManager) {
      throw new Error('The official @nocobase/plugin-ai plugin is required to execute Loop Control Plane runs.');
    }
    return plugin;
  }

  async createConversation(input: { username: string; userId?: number; runId: number; title: string }) {
    const conversation = await this.plugin().aiConversationsManager.create({
      userId: input.userId,
      aiEmployee: { username: input.username },
      title: input.title,
      category: 'task',
      options: { controlPlaneRunId: input.runId },
    });
    const sessionId = String(read(conversation, 'sessionId') || '');
    if (!sessionId) throw new Error('The AI conversation was created without a session identifier.');
    return sessionId;
  }

  async invoke(input: {
    username: string;
    sessionId: string;
    userId?: number;
    systemMessage: string;
    harness: CompiledHarness;
    prompt: string;
    signal: AbortSignal;
  }): Promise<InvocationOutcome> {
    const { aiEmployee } = await this.buildEmployee(input);

    const result = (await aiEmployee.invoke({
      userMessages: [{ role: 'user', content: input.prompt }],
      signal: input.signal,
    })) as Record<string, unknown>;

    return {
      sessionId: input.sessionId,
      messageId: String(result.messageId || ''),
      interrupted: interruptedFrom(result),
      content: textContent(result.messages),
    };
  }

  // Resume mirrors the official workflow employee node: flip the persisted tool call to
  // `waiting` with a decision, then re-invoke so plugin-ai resumes its own checkpoint.
  async resume(input: {
    username: string;
    sessionId: string;
    messageId: string;
    userId?: number;
    systemMessage: string;
    harness: CompiledHarness;
    decision: { type: 'approve' | 'reject'; message?: string; editedAction?: { name: string; args: unknown } };
    signal: AbortSignal;
  }): Promise<InvocationOutcome> {
    const plugin = this.plugin();

    await this.app.db
      .getModel('aiToolMessages')
      .update(
        { userDecision: input.decision, invokeStatus: 'waiting' },
        { where: { sessionId: input.sessionId, messageId: input.messageId, invokeStatus: 'interrupted' } },
      );
    const userDecisions = await plugin.aiConversationsManager.getUserDecisions(input.messageId);
    if (!userDecisions) throw new Error('The interrupted tool calls are not all ready to resume.');

    const { aiEmployee } = await this.buildEmployee(input);

    const result = (await aiEmployee.invoke({
      messageId: input.messageId,
      userDecisions: userDecisions as { interruptId?: string; decisions: never[] },
      signal: input.signal,
    })) as Record<string, unknown>;

    return {
      sessionId: input.sessionId,
      messageId: String(result.messageId || input.messageId),
      interrupted: interruptedFrom(result),
      content: textContent(result.messages),
    };
  }

  // The employee model is re-read per invocation and mutated only in memory. `isAutoCall` reads
  // `employee.skillSettings` off the Sequelize dataValues, so `set()` without `save()` gates this
  // run's tool calls without touching the shared employee configuration.
  private async buildEmployee(input: {
    username: string;
    sessionId: string;
    userId?: number;
    systemMessage: string;
    harness: CompiledHarness;
  }) {
    const plugin = this.plugin();
    const employee = await plugin.aiEmployeesManager.getEmployee(input.username);
    if (!employee) throw new Error(`AI employee "${input.username}" was not found.`);
    const model = await plugin.aiEmployeesManager.resolveModel(employee);
    const currentRoles = await this.rolesFor(input.userId);

    const ctx = {
      app: this.app,
      db: this.app.db,
      log: this.app.log,
      logger: this.app.log,
      state: { currentRoles },
      auth: { user: { id: input.userId } },
      action: { params: { values: { sessionId: input.sessionId, model } } },
    };

    // Discovery runs with the same ctx the invocation will use, so context-scoped MCP tools
    // resolve here exactly as they will when plugin-ai builds its tool map.
    const plan = await planHarnessTools(this.app, input.harness, { ctx, sessionId: input.sessionId });

    if (plan.withheld.length) {
      this.app.logger.info(
        `[AgentOrchestrator] Harness withheld ${plan.withheld.length} tool(s) from ${input.username}.`,
        { withheld: plan.withheld },
      );
    }

    const persisted = (employee.get('skillSettings') || {}) as Record<string, unknown>;
    employee.set('skillSettings', { ...persisted, tools: plan.employeeTools });

    // plugin-ai adds `knowledge-base-retrieve` whenever the employee has knowledge base enabled,
    // and keeps it through the tool filter because it is a system tool. Clearing the in-memory flag
    // is the only way a harness that does not grant it actually keeps it out of the model's hands.
    const blockedSystemTools = new Set(plan.blockedSystemTools);
    if (blockedSystemTools.has(SYSTEM_TOOL_KNOWLEDGE_BASE)) {
      employee.set('enableKnowledgeBase', false);
    }

    const aiEmployee = new AIEmployee({
      ctx: ctx as never,
      employee,
      sessionId: input.sessionId,
      systemMessage: input.systemMessage,
      skillSettings: { skillsVersion: 2, toolsVersion: 2, skills: [], tools: plan.filter },
      // Same reasoning for web search: the flag is what injects the system tool, so it is only
      // ever enabled when the harness explicitly granted it.
      webSearch: !blockedSystemTools.has(SYSTEM_TOOL_WEB_SEARCH),
      model,
    });
    return { aiEmployee, plan };
  }

  private async rolesFor(userId?: number) {
    if (!userId) return [];
    const rows = await this.app.db.getRepository('rolesUsers').find({ filter: { userId } });
    return rows.map((row) => String(read(row, 'roleName') || '')).filter(Boolean);
  }
}
