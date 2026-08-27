// ── Shared types for Agent Orchestrator ──────────────────────────────────
// Re-export canonical types from their implementation modules.
// This file exists for backward compatibility; prefer direct imports.
export type { TokenUsage, BudgetConfig, BudgetCheckResult } from './services/TokenTracker';

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
  trace?: unknown[];
  messages?: unknown[];
  userId?: number | string;
}
