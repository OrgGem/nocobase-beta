import type { Context } from '@nocobase/actions';

interface AIEmployeeModelOptions {
  llmService: string;
  model: string;
}

interface AIEmployeeConstructorOptions {
  ctx: Context;
  employee: unknown;
  sessionId: string;
  webSearch: boolean;
  model: AIEmployeeModelOptions;
  legacy: boolean;
}

interface AIEmployeeRuntime {
  stream(options: { userMessages: unknown[] }): Promise<void>;
  invoke(options: { userMessages: unknown[] }): Promise<unknown>;
}

export interface AgentRuntimeContext {
  ctx: Context;
  source: 'api';
  employee: unknown;
  sessionId: string;
  userId?: number;
  messages: Array<{ role: string; content: unknown }>;
  metadata: Record<string, unknown>;
}

interface AgentRuntimeLifecycle {
  runBeforeHooks(context: AgentRuntimeContext): Promise<void>;
  runAfterHooks(
    context: AgentRuntimeContext,
    result: { succeeded: boolean; value?: unknown; error?: Error },
  ): Promise<void>;
}

export function getAgentRuntimeLifecycle(ctx: Context): AgentRuntimeLifecycle | undefined {
  return (ctx.app as typeof ctx.app & { agentRuntimeLifecycle?: AgentRuntimeLifecycle }).agentRuntimeLifecycle;
}

export type AIEmployeeConstructor = new (options: AIEmployeeConstructorOptions) => AIEmployeeRuntime;

let cachedConstructor: AIEmployeeConstructor | null = null;

export async function loadAIEmployeeConstructor(): Promise<AIEmployeeConstructor> {
  if (cachedConstructor) return cachedConstructor;

  const modulePath = '@nocobase/plugin-ai/dist/server/ai-employees/ai-employee.js';
  const module = (await import(/* webpackIgnore: true */ modulePath)) as {
    AIEmployee?: AIEmployeeConstructor;
  };

  if (typeof module.AIEmployee !== 'function') {
    throw new Error('AIEmployee class is not exported by the installed plugin-ai runtime.');
  }

  cachedConstructor = module.AIEmployee;
  return cachedConstructor;
}

export function createAIEmployeeOptions(
  ctx: Context,
  employee: unknown,
  sessionId: string,
  model: AIEmployeeModelOptions,
): AIEmployeeConstructorOptions {
  return { ctx, employee, sessionId, webSearch: false, model, legacy: false };
}
