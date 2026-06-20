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

/**
 * Default pricing per 1K tokens (USD).
 * These are conservative estimates; override via env vars:
 *   ORCHESTRATOR_PRICE_PER_1K_INPUT
 *   ORCHESTRATOR_PRICE_PER_1K_OUTPUT
 */
const PRICE_PER_1K_INPUT = Number(process.env.ORCHESTRATOR_PRICE_PER_1K_INPUT || 0.003);
const PRICE_PER_1K_OUTPUT = Number(process.env.ORCHESTRATOR_PRICE_PER_1K_OUTPUT || 0.015);

/**
 * Estimate cost based on token counts.
 */
function estimateCost(inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1000) * PRICE_PER_1K_INPUT + (outputTokens / 1000) * PRICE_PER_1K_OUTPUT;
}

/**
 * Extract usage_metadata from a legacy agent final state.
 *
 * Legacy agent execution returned a final state object with a `messages` array.
 * The last AIMessage in that array carries `usage_metadata` populated by the
 * LLM provider after the final generation step. This is the standard LangChain
 * approach — no private API access needed.
 *
 * Expected message shape:
 *   AIMessage.usage_metadata = {
 *     input_tokens: number,
 *     output_tokens: number,
 *     total_tokens: number,
 *   }
 */
export function extractTokenUsage(finalState: any): TokenUsage | null {
  if (!finalState?.messages || !Array.isArray(finalState.messages)) return null;

  // Accumulate usage across all AI messages in the run (each LLM call adds usage)
  let totalInput = 0;
  let totalOutput = 0;
  let totalAll = 0;

  for (const msg of finalState.messages) {
    if (msg?.usage_metadata) {
      const um = msg.usage_metadata;
      totalInput += um.input_tokens || 0;
      totalOutput += um.output_tokens || 0;
      totalAll += um.total_tokens || 0;
    }
  }

  if (totalAll === 0) return null;

  return {
    inputTokens: totalInput,
    outputTokens: totalOutput,
    totalTokens: totalAll,
    cost: estimateCost(totalInput, totalOutput),
  };
}

/**
 * Service for tracking token consumption across agent runs and spans.
 *
 * Responsibilities:
 * 1. Parse token usage from LangGraph execution results
 * 2. Persist token counts to agentExecutionSpans
 * 3. Accumulate totals at the agentLoopRuns level
 * 4. Enforce budget limits (max tokens / max cost per run)
 */
export class TokenTracker {
  constructor(private readonly plugin: any) {}

  get db() {
    return this.plugin.db;
  }

  get app() {
    return this.plugin.app;
  }

  /**
   * Track token usage for a single execution span.
   * Updates the span record and accumulates into the parent run.
   *
   * @param spanId - The agentExecutionSpans.id to update
   * @param usage - Parsed token usage from extractTokenUsage()
   * @param runId - Optional agentLoopRuns.id to accumulate totals
   */
  async trackSpan(spanId: string | number | undefined, usage: TokenUsage, runId?: string | number): Promise<void> {
    if (!spanId) return;

    try {
      const repo = this.db.getRepository('agentExecutionSpans');
      if (!repo) return;

      await repo.update({
        filterByTk: spanId,
        values: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          cost: usage.cost,
        },
      });

      if (runId != null) {
        await this.accumulateToRun(runId);
      }
    } catch (e: any) {
      this.app.log?.warn?.('[TokenTracker] Failed to track span tokens', e);
    }
  }

  /**
   * Recalculate total token/cost for a run by summing all its spans.
   */
  async accumulateToRun(runId: string | number): Promise<void> {
    try {
      const spansRepo = this.db.getRepository('agentExecutionSpans');
      if (!spansRepo) return;

      const spans = await spansRepo.find({
        filter: { 'metadata.agentLoopRunId': String(runId) },
      });

      let totalInput = 0;
      let totalOutput = 0;
      let totalCost = 0;

      for (const span of spans) {
        totalInput += Number(span.get?.('inputTokens') || span.inputTokens || 0);
        totalOutput += Number(span.get?.('outputTokens') || span.outputTokens || 0);
        totalCost += Number(span.get?.('cost') || span.cost || 0);
      }

      const runsRepo = this.db.getRepository('agentLoopRuns');
      if (!runsRepo) return;

      await runsRepo.update({
        filterByTk: runId,
        values: {
          totalInputTokens: totalInput,
          totalOutputTokens: totalOutput,
          totalTokens: totalInput + totalOutput,
          totalCost,
        },
      });
    } catch (e: any) {
      this.app.log?.warn?.('[TokenTracker] Failed to accumulate run totals', e);
    }
  }

  /**
   * Check if a run has exceeded its budget limits.
   */
  async checkBudget(runId: string | number): Promise<BudgetCheckResult> {
    try {
      const repo = this.db.getRepository('agentLoopRuns');
      if (!repo) return { allowed: true };

      const run = await repo.findOne({ filter: { id: runId } });
      if (!run) return { allowed: true };

      const budgetMaxTokens = Number(run.get?.('budgetMaxTokens') ?? 0);
      const budgetMaxCost = Number(run.get?.('budgetMaxCost') ?? 0);

      if (budgetMaxTokens <= 0 && budgetMaxCost <= 0) return { allowed: true };

      const totalTokens = Number(run.get?.('totalTokens') || 0);
      const totalCost = Number(run.get?.('totalCost') || 0);

      if (budgetMaxTokens > 0 && totalTokens >= budgetMaxTokens) {
        return {
          allowed: false,
          reason: `Budget exceeded: ${totalTokens}/${budgetMaxTokens} tokens used. Maximum allowed tokens for this run: ${budgetMaxTokens}.`,
        };
      }

      if (budgetMaxCost > 0 && totalCost >= budgetMaxCost) {
        return {
          allowed: false,
          reason: `Budget exceeded: $${totalCost.toFixed(4)}/$${budgetMaxCost.toFixed(
            4,
          )} spent. Maximum allowed cost for this run: $${budgetMaxCost}.`,
        };
      }

      return { allowed: true };
    } catch (e: any) {
      this.app.log?.warn?.('[TokenTracker] Budget check failed, allowing', e);
      return { allowed: true };
    }
  }
}
