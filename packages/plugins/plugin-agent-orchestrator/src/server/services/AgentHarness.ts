import { z } from 'zod';
import { createHash } from 'crypto';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ExecutionSpanService, setOrchestratorTraceContext } from './ExecutionSpanService';
import { AgentRegistryService } from './AgentRegistryService';

const ORCHESTRATOR_DEPTH_KEY = '__orchestratorDepth';
const ORCHESTRATOR_PATH_KEY = '__orchestratorPath';

function toPlain(record: any) {
  return record?.toJSON?.() || record;
}

function asObject(value: any) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function trimText(value: any, max = 50000) {
  let text = '';
  if (typeof value === 'string') {
    text = value;
  } else if (value != null) {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > max ? `${text.slice(0, max)}\n...[truncated]` : text;
}

function sanitizeToolPart(value: string) {
  return (value || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function buildDelegateToolName(leaderUsername: string, subAgentUsername: string) {
  return `delegate_${sanitizeToolPart(leaderUsername)}_to_${sanitizeToolPart(subAgentUsername)}`;
}

function nowIso() {
  return new Date().toISOString();
}

type TraceEvent = {
  type: string;
  at: string;
  title: string;
  content?: string;
  toolName?: string;
  args?: any;
  status?: string;
};

export class AgentHarness {
  private readonly spanService: ExecutionSpanService;

  constructor(
    private readonly plugin: any,
    private readonly registryService: AgentRegistryService
  ) {
    this.spanService = new ExecutionSpanService(plugin);
  }

  get db() {
    return this.plugin.db;
  }

  get app() {
    return this.plugin.app;
  }

  async executeStep(
    run: any,
    step: any,
    options: { userId?: string | number; ctx?: any } = {}
  ): Promise<any> {
    const harnessTag = asObject(run.metadata).harnessTag || asObject(step.metadata).harnessTag || 'default';
    const profile = await this.registryService.getHarnessProfile(harnessTag);
    const settings = asObject(profile?.settings);

    if (step.type === 'sub_agent') {
      if (settings.allowSubAgents === false) {
        throw new Error(`Harness profile "${harnessTag}" does not allow sub-agent execution.`);
      }
      return this.invokeSubAgentStep(run, step, settings, options);
    }

    if ((step.type === 'tool' || step.type === 'skill') && step.target) {
      if (settings.allowToolCalls === false) {
        throw new Error(`Harness profile "${harnessTag}" does not allow tool/skill execution.`);
      }
      return this.invokeNamedTool(run, step, step.target, step.input || {}, settings, options);
    }

    if (step.type === 'verification') {
      return {
        passed: true,
        summary: 'Verification completed by orchestrator controller.',
        checkedDependencies: Array.isArray(step.dependsOn) ? step.dependsOn.map(String) : [],
        harnessTag,
      };
    }

    return {
      summary: `${step.title || step.planKey} completed by orchestrator controller.`,
      description: step.description || '',
      input: step.input || {},
      harnessTag,
    };
  }

  private async invokeSubAgentStep(
    run: any,
    step: any,
    settings: any,
    options: { userId?: string | number; ctx?: any }
  ) {
    const target = step.target || asObject(step.metadata).subAgentUsername || step.input?.subAgentUsername;
    if (!target) {
      throw new Error(`Sub-agent step "${step.planKey}" is missing target sub-agent username.`);
    }
    if (!run.leaderUsername) {
      throw new Error(`Sub-agent step "${step.planKey}" requires a leader AI employee username.`);
    }

    const toolName = String(target).startsWith('delegate_')
      ? String(target)
      : buildDelegateToolName(run.leaderUsername, target);

    const task = step.description || step.title || run.goal;
    const context = trimText(
      {
        goal: run.goal,
        input: step.input || {},
        harnessTag: asObject(run.metadata).harnessTag || asObject(step.metadata).harnessTag || 'default',
        agentLoopRunId: String(run.id),
        agentLoopStepId: String(step.id),
      },
      20000
    );

    return this.invokeNamedTool(run, step, toolName, { task, context }, settings, options);
  }

  private async invokeNamedTool(
    run: any,
    step: any,
    toolName: string,
    args: any,
    settings: any,
    options: { userId?: string | number; ctx?: any }
  ) {
    if (String(toolName).startsWith('orchestrator_')) {
      throw new Error(`Tool step "${step.planKey}" cannot call internal orchestrator control tool "${toolName}".`);
    }

    if (Array.isArray(settings.allowTools) && settings.allowTools.length > 0) {
      if (!settings.allowTools.includes(toolName)) {
        throw new Error(`Tool "${toolName}" is not on the allowed list for harness profile.`);
      }
    }
    if (Array.isArray(settings.denyTools) && settings.denyTools.length > 0) {
      if (settings.denyTools.includes(toolName)) {
        throw new Error(`Tool "${toolName}" is on the denied list for harness profile.`);
      }
    }

    const toolsManager = this.app?.aiManager?.toolsManager;
    const tool = await toolsManager?.getTools?.(toolName);
    if (!tool?.invoke) {
      throw new Error(`Tool "${toolName}" was not found or is missing standard invoke handler.`);
    }

    const isDelegationTool = await this.registryService.isRegisteredDelegationTool(toolName);
    const isStepAlreadyApproved = step?.approval?.approved === true;

    if (!isDelegationTool && !isStepAlreadyApproved && (tool.defaultPermission === 'ASK' || (settings.requireApprovalRiskLevel && tool.riskLevel && tool.riskLevel >= settings.requireApprovalRiskLevel))) {
      throw new Error('requires_approval');
    }

    const ctx = options.ctx || {};
    const previousEmployee = ctx._currentAIEmployee;
    const previousStateEmployee = ctx.state?.currentAIEmployee;

    if (run.leaderUsername) {
      ctx._currentAIEmployee = run.leaderUsername;
      ctx.state = { ...(ctx.state || {}), currentAIEmployee: run.leaderUsername };
    }

    try {
      const result = await tool.invoke(ctx, args, `agent-loop-${run.id}-${step.id}`);
      if (result?.status === 'error') {
        throw new Error(result.content || `Tool "${toolName}" returned an error.`);
      }
      return {
        toolName,
        args,
        result,
      };
    } finally {
      if (previousEmployee === undefined) {
        delete ctx._currentAIEmployee;
      } else {
        ctx._currentAIEmployee = previousEmployee;
      }
      if (ctx.state) {
        if (previousStateEmployee === undefined) {
          delete ctx.state.currentAIEmployee;
        } else {
          ctx.state.currentAIEmployee = previousStateEmployee;
        }
      }
    }
  }

  async runSubAgent(
    ctx: any,
    options: {
      leaderUsername: string;
      subAgentUsername: string;
      subAgentEmployee: any;
      task: string;
      context?: string;
      currentDepth?: number;
      currentPath?: string[];
      maxDepth: number;
      timeout: number;
      toolCallId: string;
      toolName: string;
      llmService?: string;
      model?: string;
      recursionLimit?: number;
      rootRunId?: string;
      parentSpanId?: string;
      agentLoopRunId?: string;
      agentLoopStepId?: string;
    }
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
      rootRunId,
      parentSpanId,
      agentLoopRunId,
      agentLoopStepId,
    } = options;

    const startTime = Date.now();
    const currentDepth = options.currentDepth ?? 0;
    const currentPath = options.currentPath ?? [leaderUsername];
    const trace: TraceEvent[] = [
      {
        type: 'start',
        at: nowIso(),
        title: `Delegation started: ${leaderUsername} -> ${subAgentUsername}`,
        content: task,
      },
    ];

    const executionSpan = await this.spanService.create({
      rootRunId: rootRunId || `run_${Date.now()}`,
      parentSpanId,
      type: 'sub_agent',
      status: 'running',
      leaderUsername,
      employeeUsername: subAgentUsername,
      title: `Delegation: ${leaderUsername} -> ${subAgentUsername}`,
      input: { task, context },
      metadata: {
        depth: maxDepth,
        toolName,
        recursionLimit,
        agentLoopRunId,
        agentLoopStepId,
      },
      userId: ctx?.auth?.user?.id || ctx?.state?.currentUser?.id,
    });
    const executionSpanId = executionSpan?.id ? String(executionSpan.id) : undefined;

    const logRecord = await this.logDelegation(ctx, {
      leaderUsername,
      subAgentUsername,
      toolName,
      task,
      context,
      result: '',
      status: 'running',
      depth: maxDepth,
      durationMs: 0,
      trace,
    });

    if (executionSpanId && logRecord?.id) {
      await this.spanService.update(executionSpanId, { orchestratorLogId: logRecord.id });
    }

    try {
      const aiPlugin = ctx.app.pm.get('ai');
      if (!aiPlugin) {
        throw new Error('Plugin AI is not enabled.');
      }

      const modelSettings = await this.registryService.resolveModelSettings(
        subAgentUsername,
        leaderUsername,
        llmService && model ? { llmService, model } : undefined
      );

      if (!modelSettings) {
        throw new Error(`Sub-agent "${subAgentUsername}" has no LLM model configured.`);
      }

      const { provider } = await aiPlugin.aiManager.getLLMService({
        llmService: modelSettings.llmService,
        model: modelSettings.model,
      });
      const chatModel = provider.createModel();

      const coreToolsManager = ctx.app.aiManager.toolsManager;
      const allTools = await coreToolsManager.listTools();

      const employeeSkills = (subAgentEmployee.skillSettings?.skills ?? [])
        .map((s: any) =>
          typeof s === 'string' ? { name: s, autoCall: false } : { name: s?.name, autoCall: s?.autoCall === true }
        )
        .filter((s: any) => Boolean(s.name));
      const employeeSkillMap = new Map<string, any>(employeeSkills.map((s: any) => [s.name, s]));

      const langchainTools: DynamicStructuredTool[] = [];

      for (const toolEntry of allTools) {
        const entryName = toolEntry.definition.name;
        if (!entryName) continue;
        const employeeSkill = employeeSkillMap.get(entryName);

        if (
          !employeeSkill ||
          employeeSkill.autoCall !== true ||
          toolEntry.defaultPermission !== 'ALLOW'
        ) {
          continue;
        }

        langchainTools.push(
          new DynamicStructuredTool({
            name: entryName.replace(/[^a-zA-Z0-9_-]/g, '_'),
            description: toolEntry.definition.description || entryName,
            schema: (toolEntry.definition.schema || z.object({})) as any,
            func: async (toolArgs) => {
              const invokeCtx = Object.create(ctx);
              invokeCtx._currentAIEmployee = subAgentUsername;
              invokeCtx[ORCHESTRATOR_DEPTH_KEY] = currentDepth + 1;
              invokeCtx[ORCHESTRATOR_PATH_KEY] = [...currentPath, subAgentUsername];
              if (ctx.state) {
                invokeCtx.state = Object.create(ctx.state);
                invokeCtx.state.currentAIEmployee = subAgentUsername;
              }

              const toolStartedAt = Date.now();
              const isSkillHubTool = entryName === 'skill_hub_execute' || entryName.startsWith('skill_hub_');
              const toolSpan = await this.spanService.create({
                rootRunId: rootRunId || `run_${Date.now()}`,
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
                  agentLoopRunId,
                  agentLoopStepId,
                },
                userId: ctx?.auth?.user?.id || ctx?.state?.currentUser?.id,
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
                agentLoopRunId,
                agentLoopStepId,
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
                const output = trimText(res?.content ?? res?.result ?? res, 50000);
                trace.push({
                  type: 'tool_result',
                  at: nowIso(),
                  title: `Tool finished: ${toolEntry.definition.name}`,
                  toolName: toolEntry.definition.name,
                  status: res?.status || 'success',
                  content: trimText(output, 2000),
                });
                if (res?.status === 'error') {
                  await this.spanService.finish(toolSpanId, 'error', toolStartedAt, {
                    output,
                    error: trimText(res.content || output, 10000),
                  });
                  throw new Error(`Tool <${toolEntry.definition.name}> failed: ${res.content}`);
                }
                await this.spanService.finish(toolSpanId, 'success', toolStartedAt, {
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
                await this.spanService.finish(toolSpanId, 'error', toolStartedAt, {
                  error: trimText(e.message, 10000),
                });
                throw e;
              }
            },
          })
        );
      }

      const abortController = new AbortController();
      const executor = createReactAgent({
        llm: chatModel,
        tools: langchainTools,
      });

      let systemPrompt =
        subAgentEmployee.chatSettings?.systemPrompt ||
        subAgentEmployee.bio ||
        `You are an AI assistant named "${subAgentEmployee.nickname || subAgentUsername}". ${
          subAgentEmployee.about || ''
        }`;

      try {
        const kbPlugin = ctx.app.pm.get('plugin-knowledge-base');
        if (kbPlugin?.sessionContext) {
          const sessionId =
            ctx.action?.params?.values?.sessionId || ctx.action?.params?.sessionId || ctx.state?.sessionId;
          const contextSummary = await kbPlugin.sessionContext.buildSummary(
            { rootRunId, ...(sessionId ? { sessionId } : {}) },
            6000
          );
          if (contextSummary) {
            systemPrompt += `\n\n<shared_context>\nThe following context was shared by other agents in this workflow:\n${contextSummary}\n</shared_context>`;
          }
        }
      } catch {}

      const combinedTask = context ? `Task: ${task}\n\nContext:\n${context}` : `Task: ${task}`;
      const effectiveLimit = recursionLimit && recursionLimit > 0 ? recursionLimit : 50;

      let timeoutId: any;
      const timeoutMs = Number(timeout) > 0 ? Number(timeout) : 120000;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          abortController.abort();
          reject(new Error(`Sub-agent execution timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
      });

      const invokePromise = executor.invoke(
        {
          messages: [new SystemMessage(systemPrompt), new HumanMessage(combinedTask)],
        },
        { recursionLimit: effectiveLimit, signal: abortController.signal }
      );

      let finalState: any;
      try {
        finalState = await Promise.race([invokePromise, timeoutPromise]);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }

      const messages = finalState?.messages || [];
      const lastAIMessage = [...messages].reverse().find((m) => m.getType() === 'ai');
      let content = '';
      if (lastAIMessage) {
        content = typeof lastAIMessage.content === 'string'
          ? lastAIMessage.content
          : Array.isArray(lastAIMessage.content)
          ? lastAIMessage.content.map((c: any) => c.text || JSON.stringify(c)).join('\n')
          : String(lastAIMessage.content);
      }

      trace.push({
        type: 'finish',
        at: nowIso(),
        title: `Delegation finished: ${subAgentUsername}`,
        status: 'success',
        content: trimText(content, 2000),
      });

      await this.logDelegation(ctx, {
        id: logRecord?.id,
        leaderUsername,
        subAgentUsername,
        toolName,
        task,
        context,
        result: content,
        status: 'success',
        depth: maxDepth,
        durationMs: Date.now() - startTime,
        trace,
      });

      await this.spanService.finish(executionSpanId, 'success', startTime, {
        output: content,
        metadata: {
          depth: currentDepth,
          toolName,
          recursionLimit,
          agentLoopRunId,
          agentLoopStepId,
        },
      });

      return {
        status: 'success' as const,
        content,
      };
    } catch (e: any) {
      trace.push({
        type: 'error',
        at: nowIso(),
        title: `Delegation failed: ${subAgentUsername}`,
        status: 'error',
        content: e.message,
      });

      await this.logDelegation(ctx, {
        id: logRecord?.id,
        leaderUsername,
        subAgentUsername,
        toolName,
        task,
        context,
        result: '',
        status: 'error',
        depth: maxDepth,
        durationMs: Date.now() - startTime,
        error: e.message,
        trace,
      });

      await this.spanService.finish(executionSpanId, 'error', startTime, {
        error: trimText(e.message, 10000),
        metadata: {
          depth: currentDepth,
          toolName,
          recursionLimit,
          agentLoopRunId,
          agentLoopStepId,
        },
      });
      return {
        status: 'error' as const,
        content: e.message,
      };
    }
  }

  private async logDelegation(
    ctx: any,
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
    }
  ) {
    try {
      const logsRepo = this.db.getRepository('orchestratorLogs');
      if (!logsRepo) return null;

      const userId = ctx?.auth?.user?.id || ctx?.state?.currentUser?.id;
      const values = {
        leaderUsername: data.leaderUsername,
        subAgentUsername: data.subAgentUsername,
        toolName: data.toolName,
        task: trimText(data.task, 10000),
        context: trimText(data.context || '', 10000),
        result: trimText(data.result || '', 50000),
        status: data.status,
        depth: data.depth,
        durationMs: data.durationMs,
        error: trimText(data.error || '', 10000),
        trace: data.trace || [],
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
      return toPlain(record);
    } catch {
      return null;
    }
  }
}
