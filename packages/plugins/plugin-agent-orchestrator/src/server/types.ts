// ── Shared types for Agent Orchestrator ──────────────────────────────────

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
}

export interface BudgetConfig {
  budgetMaxTokens?: number;
  budgetMaxCost?: number;
}

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: string;
}

export interface CircuitState {
  failures: number;
  lastFailureTime: number;
  state: 'closed' | 'open' | 'half-open';
}

export interface TraceEvent {
  type: string;
  at: string;
  title: string;
  content?: string;
  toolName?: string;
  args?: any;
  status?: string;
}

export interface DelegationLogData {
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
  userId?: number | string;
}

export type CtxSnapshot = {
  userId?: number;
};
