import { AsyncLocalStorage } from 'async_hooks';

export type AgentExecutionIdentity = {
  rootRunId?: string;
  spanId?: string;
  parentSpanId?: string;
  toolCallId?: string;
  leaderUsername?: string;
  employeeUsername?: string;
  sessionId?: string;
  agentLoopRunId?: string;
  agentLoopStepId?: string;
};

const storage = new AsyncLocalStorage<AgentExecutionIdentity>();

export function runWithAgentExecutionContext<T>(identity: AgentExecutionIdentity, callback: () => T): T {
  return storage.run(identity, callback);
}

export function getAgentExecutionContext(): AgentExecutionIdentity | undefined {
  return storage.getStore();
}
