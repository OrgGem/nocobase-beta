export type AgentRuntimeSource = 'chat-ui' | 'api' | 'workflow' | 'sub-agent';

export interface AgentRuntimeMessage {
  role: string;
  content: unknown;
}

export interface AgentRuntimeContext {
  ctx: unknown;
  source: AgentRuntimeSource;
  employee: unknown;
  sessionId: string;
  userId?: number;
  messages: AgentRuntimeMessage[];
  metadata: Record<string, unknown>;
}

export interface AgentRuntimeResult {
  succeeded: boolean;
  value?: unknown;
  error?: Error;
}

type BeforeRunHook = (context: AgentRuntimeContext) => Promise<void> | void;
type AfterRunHook = (context: AgentRuntimeContext, result: AgentRuntimeResult) => Promise<void> | void;

export class AgentRuntimeLifecycle {
  private readonly beforeRunHooks = new Map<string, BeforeRunHook>();
  private readonly afterRunHooks = new Map<string, AfterRunHook>();

  constructor(
    private readonly onHookError?: (hookType: 'beforeRun' | 'afterRun', name: string, error: Error) => void,
  ) {}

  registerBeforeRunHook(name: string, hook: BeforeRunHook): () => void {
    this.beforeRunHooks.set(name, hook);
    return () => this.beforeRunHooks.delete(name);
  }

  registerAfterRunHook(name: string, hook: AfterRunHook): () => void {
    this.afterRunHooks.set(name, hook);
    return () => this.afterRunHooks.delete(name);
  }

  async runBeforeHooks(context: AgentRuntimeContext): Promise<void> {
    for (const [name, hook] of this.beforeRunHooks) {
      try {
        await hook(context);
      } catch (error) {
        this.onHookError?.('beforeRun', name, error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  async runAfterHooks(context: AgentRuntimeContext, result: AgentRuntimeResult): Promise<void> {
    for (const [name, hook] of this.afterRunHooks) {
      try {
        await hook(context, result);
      } catch (error) {
        this.onHookError?.('afterRun', name, error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
}
