const PLAN_KEYWORDS = [
  'kế hoạch',
  'lập kế hoạch',
  'lên kế hoạch',
  'kế hoạch hóa',
  'lập plan',
  'tạo kế hoạch',
  'xây dựng kế hoạch',
  'planning',
  'make a plan',
  'create a plan',
];

// Word-boundary pattern for the standalone word "plan" to avoid matching
// "plane", "plank", "supplant", "explanation", etc.
const PLAN_WORD_PATTERN = /\bplan\b/i;

const PLANNING_PREFIX = `[PLAN MODE] The user's request may need a structured plan. First, analyze the request:

STEP 0 — Evaluate: Does this request truly require 3+ distinct steps (building, creating, deploying, researching, etc.)?
  - NO  → The user mentioned "plan" but this is a simple question or single action. Respond directly WITHOUT calling any agent_loop tools.
  - YES → Proceed with the plan workflow below.

PLAN WORKFLOW (only if truly multi-step):
1. Call \`agent_loop_start\` with a concrete step-by-step plan. Use small, executable steps with clear planKey values and proper dependsOn chains. Structure the user's goal clearly in the "goal" field.
2. After the plan is approved, execute each step by calling \`agent_loop_update_step\` with status="running" before the action, then status="succeeded" or "failed" after.
3. If execution diverges, call \`agent_loop_replan\` to update remaining steps.
4. When all steps complete, call \`agent_loop_finish\`.

User request:
`;

export class PlanningPromptService {
  static getMessageText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (content && typeof content === 'object' && 'content' in content) {
      const nested = (content as { content?: unknown }).content;
      return typeof nested === 'string' ? nested : '';
    }
    return '';
  }

  shouldInjectPlanningPrompt(text: string): boolean {
    if (!text) return false;
    const normalized = text.toLowerCase();
    if (PLAN_WORD_PATTERN.test(normalized)) return true;
    return PLAN_KEYWORDS.some((keyword) => normalized.includes(keyword));
  }

  getPlanningPrefix(): string {
    return PLANNING_PREFIX;
  }

  getPlanningInstructions(): string {
    return PLANNING_PREFIX.replace(/User request:\s*$/, '').trim();
  }

  applyPlanningContext(messages: Array<{ role: string; content: unknown }>): boolean {
    const shouldInject = messages.some(
      (message) =>
        message.role === 'user' &&
        this.shouldInjectPlanningPrompt(PlanningPromptService.getMessageText(message.content)),
    );
    if (!shouldInject) return false;

    messages.unshift({
      role: 'system',
      content: { type: 'text', content: this.getPlanningInstructions() },
    });
    return true;
  }
}
