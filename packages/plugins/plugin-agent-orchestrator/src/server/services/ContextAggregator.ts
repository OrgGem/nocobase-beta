import { AgentLoopPolicy } from './AgentLoopService';

function trimText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '\n...[truncated]';
}

/**
 * Estimate token count from text (rough: ~4 chars per token).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * ContextAggregator — builds structured step context for sub-agent system prompts.
 *
 * Responsibilities:
 * 1. Query completed steps of a run
 * 2. Format them as structured XML context
 * 3. Apply truncation/summarization based on policy
 * 4. Inject into sub-agent system prompt
 */
export class ContextAggregator {
  constructor(private readonly plugin: any) {}

  get db() {
    return this.plugin.db;
  }

  get app() {
    return this.plugin.app;
  }

  /**
   * Build a structured context string from completed steps of a run.
   *
   * @param runId - agentLoopRuns.id
   * @param maxTokens - Maximum tokens for the context output (default 4000)
   * @param options - Strategy options
   */
  async buildStepContext(
    runId: string | number,
    maxTokens?: number,
    options?: {
      strategy?: 'last_n' | 'all';
      includeToolResults?: boolean;
      includeStepOutputs?: boolean;
    },
  ): Promise<string> {
    const effectiveMaxTokens = maxTokens || 4000;

    let steps: any[];
    try {
      const repo = this.db.getRepository('agentLoopSteps');
      if (!repo) return '';
      steps = await repo.find({
        filter: { runId },
        sort: ['index', 'createdAt'],
        pageSize: 500,
      });
    } catch {
      return '';
    }

    if (!steps || steps.length === 0) return '';

    const completedSteps = steps.filter((s: any) => s.status === 'succeeded' || s.status === 'failed');

    if (completedSteps.length === 0) return '';

    const config = {
      strategy: options?.strategy || 'all',
      includeToolResults: options?.includeToolResults ?? false,
      includeStepOutputs: options?.includeStepOutputs ?? true,
    };

    let candidates = completedSteps;
    if (config.strategy === 'last_n') {
      // Take last 10 completed steps
      const n = Math.min(10, completedSteps.length);
      candidates = completedSteps.slice(-n);
    }

    const parts: string[] = [];

    for (const step of candidates) {
      const key = step.planKey || `step_${step.index || 0}`;
      const type = step.type || 'unknown';
      const target = step.target || '';
      const title = step.title || key;
      const status = step.status || 'unknown';

      const lines: string[] = [];
      lines.push(`<step key="${key}" type="${type}" target="${target}" status="${status}">`);
      lines.push(`  <title>${this.escapeXml(title)}</title>`);

      if (step.description) {
        lines.push(`  <description>${this.escapeXml(trimText(step.description, 500))}</description>`);
      }

      if (config.includeStepOutputs && step.output) {
        const outputStr = typeof step.output === 'string' ? step.output : this.safeStringify(step.output);
        lines.push(`  <output>${this.escapeXml(trimText(outputStr, 2000))}</output>`);
      }

      if (config.includeToolResults && step.metadata?.toolResults) {
        const toolStr = this.safeStringify(step.metadata.toolResults);
        lines.push(`  <tool_results>${this.escapeXml(trimText(toolStr, 1500))}</tool_results>`);
      }

      if (step.error) {
        lines.push(`  <error>${this.escapeXml(trimText(step.error, 1000))}</error>`);
      }

      lines.push('</step>');
      parts.push(lines.join('\n'));
    }

    let context = `<previous_steps>\n${parts.join('\n\n')}\n</previous_steps>`;

    // Truncate if exceeding token limit
    if (estimateTokens(context) > effectiveMaxTokens) {
      context = this.truncateToTokenLimit(context, effectiveMaxTokens);
    }

    return context;
  }

  /**
   * Enrich a base system prompt with step context from the run.
   * Fetches the run from DB to access policy settings (maxContextTokens, etc.).
   *
   * @param basePrompt - The original system prompt to enrich
   * @param runId - agentLoopRuns.id
   * @param _stepId - agentLoopSteps.id (reserved for future per-step context)
   */
  async enrichSystemPrompt(
    basePrompt: string,
    runId: string | number,
    _stepId?: string | number,
    options?: {
      maxContextTokens?: number;
      contextSummaryStrategy?: 'last_n' | 'all';
      includeToolResults?: boolean;
      includeStepOutputs?: boolean;
    },
  ): Promise<string> {
    // Fetch run from DB to get policy settings
    let run: any;
    try {
      const repo = this.db.getRepository('agentLoopRuns');
      if (!repo) return basePrompt;
      run = await repo.findOne({ filter: { id: runId } });
      if (!run) return basePrompt;
    } catch {
      return basePrompt;
    }

    const policy = (run.policy || {}) as AgentLoopPolicy;
    const maxCtxTokens = options?.maxContextTokens ?? policy.maxContextTokens ?? 4000;
    const strategy = options?.contextSummaryStrategy ?? policy.contextSummaryStrategy ?? 'all';
    const includeToolResults = options?.includeToolResults ?? policy.includeToolResults ?? false;
    const includeStepOutputs = options?.includeStepOutputs ?? policy.includeStepOutputs ?? true;

    const stepContext = await this.buildStepContext(runId, maxCtxTokens, {
      strategy,
      includeToolResults,
      includeStepOutputs,
    });

    if (!stepContext) return basePrompt;

    return `${basePrompt}\n\n<previous_steps_context>\n${stepContext}\n</previous_steps_context>`;
  }

  private truncateToTokenLimit(text: string, maxTokens: number): string {
    // Simple truncation: remove step details until under limit
    // Strategy: keep first and last steps, remove middle ones
    const outerMatch = text.match(/<previous_steps>\n([\s\S]*)\n<\/previous_steps>/);
    if (!outerMatch) return text;

    const inner = outerMatch[1];
    const stepBlocks = this.splitStepBlocks(inner);

    if (stepBlocks.length <= 2) {
      // Just truncate text
      const maxChars = maxTokens * 4;
      if (text.length <= maxChars) return text;
      return text.slice(0, maxChars) + '\n...[truncated]\n</previous_steps>';
    }

    // Keep first 2 and last 2 steps
    const keepFirst = stepBlocks.slice(0, 2);
    const keepLast = stepBlocks.slice(-2);
    const removed = stepBlocks.length - keepFirst.length - keepLast.length;

    const rebuilt = [
      '<previous_steps>',
      ...keepFirst,
      `  <!-- ... ${removed} intermediate step(s) omitted due to context limit ... -->`,
      ...keepLast,
      '</previous_steps>',
    ].join('\n');

    // If still over limit, do a simple text truncation
    const maxChars = maxTokens * 4;
    if (rebuilt.length <= maxChars) return rebuilt;

    return rebuilt.slice(0, maxChars) + '\n...[truncated]\n</previous_steps>';
  }

  private splitStepBlocks(text: string): string[] {
    const blocks: string[] = [];
    const regex = /<step[\s\S]*?<\/step>/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      blocks.push(match[0]);
    }
    return blocks;
  }

  private escapeXml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  private safeStringify(value: any): string {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
}
