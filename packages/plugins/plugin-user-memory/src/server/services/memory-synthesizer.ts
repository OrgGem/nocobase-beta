/**
 * MemorySynthesizer — LLM-powered service that summarizes user conversations
 * into a concise markdown memory profile.
 *
 * Phase 4 changes:
 * - Synthesis prompt explicitly forbids storing KB content, tool output, business
 *   data, or customer/organization information in the memory profile.
 * - maxTokens from settings is enforced: passed as a budget hint to the LLM,
 *   and the response is truncated if it still exceeds the limit.
 */

import type { Application } from '@nocobase/server';

// Approximate characters-per-token ratio (GPT-4 style: ~4 chars/token)
const CHARS_PER_TOKEN = 4;

const SYNTHESIS_PROMPT = `You are a User Profile Analyst. Your job is to maintain a concise, privacy-safe memory profile about a user based on their chat history with AI assistants.

## Current Profile
{existingMemory}

## New Conversations to Analyze
{newConversations}

## Instructions
1. Analyze the new conversations for ONLY user-specific information:
   - Communication style and language preferences (which language do they use most?)
   - Technical skills, tools, and preferred technologies
   - Common topics and recurring questions/needs
   - Work patterns, habits, and workflows
   - Explicit preferences stated by the user
   - Personality traits observable from interactions

2. Merge findings with the existing profile:
   - ADD new observations that are clearly supported by evidence
   - UPDATE information that has changed (e.g., new tech stack, new focus areas)
   - REMOVE information that is contradicted by recent behavior
   - PRIORITIZE recent patterns over old ones
   - Keep the profile CONCISE — max {maxWords} words total

3. Output format: Return ONLY the updated markdown profile using these sections:

## Personality & Communication Style
(language preference, tone, verbosity, patience level)

## Technical Preferences
(tech stack, tools, frameworks, coding style)

## Common Topics & Interests
(what they most frequently ask about)

## Work Patterns
(active hours, workflow style, iteration patterns)

## Known Preferences
(explicit preferences they've stated)

## Recent Focus Areas
(what they've been working on lately — update frequently)

CRITICAL PRIVACY & SAFETY RULES (MUST follow — these are non-negotiable):
- ONLY store information about the USER's preferences, habits, skills, and personality.
- DO NOT store content from knowledge bases, document repositories, or RAG results.
- DO NOT store business data, customer data, organization-specific facts, or project details.
- DO NOT store tool call results, system messages, or AI-generated responses based on internal data.
- DO NOT store secrets, credentials, emails, phone numbers, or any PII.
- If a piece of information came from a knowledge base or tool output (not from the user's own words), DISCARD it.
- If you are unsure whether information is the user's preference vs. factual knowledge base content — DISCARD it.
- Be factual. Only include information DIRECTLY observed from the USER's own messages.
- Do NOT infer, speculate, or assume anything not evidenced in the user's own words.
- Keep each bullet point SHORT (1 line max).
- If the current profile is empty, create a new one from scratch.
- Output ONLY the markdown profile — no explanations, no preamble.`;

export interface SynthesisResult {
  content: string;
  success: boolean;
  error?: string;
}

/**
 * Truncate a markdown profile to at most maxChars characters, preferring to cut
 * at a '## ' section boundary, falling back to a word boundary. The returned
 * string is guaranteed to be <= maxChars.
 */
export function truncateToMaxChars(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;

  // Try to cut at the last '## ' section header before the limit
  const truncated = content.slice(0, maxChars);
  const lastSectionBoundary = truncated.lastIndexOf('\n## ');
  if (lastSectionBoundary > maxChars * 0.5) {
    return truncated.slice(0, lastSectionBoundary).trimEnd();
  }

  // Fall back to word boundary, reserving room for the suffix so the
  // total length never exceeds maxChars.
  const suffix = '\n\n*(truncated)*';
  const budget = Math.max(0, maxChars - suffix.length);
  const head = content.slice(0, budget);
  const lastSpace = head.lastIndexOf(' ');
  return (lastSpace > 0 ? head.slice(0, lastSpace) : head).trimEnd() + suffix;
}

export class MemorySynthesizer {
  constructor(private app: Application) {}

  /**
   * Synthesize a memory profile from existing memory + new conversation data.
   * Uses the LLM configured in userMemorySettings (or falls back to default).
   *
   * Phase 6: maxTokens is now used to budget the LLM output and post-truncate if needed.
   */
  async synthesize(
    existingMemory: string,
    newConversationsText: string,
    llmServiceId?: string,
    llmModel?: string,
    maxTokens?: number,
    maxChars?: number,
  ): Promise<SynthesisResult> {
    try {
      const aiPlugin = this.app.pm.get('ai') as any;
      if (!aiPlugin) {
        return { content: '', success: false, error: 'plugin-ai not available' };
      }

      // Resolve maxTokens (default 800 if not set)
      const effectiveMaxTokens = Math.max(100, Math.min(3000, maxTokens || 800));
      const maxWords = Math.floor(effectiveMaxTokens * 0.75); // tokens → approximate words

      // Build the prompt — use arrow function replacements to prevent injection of placeholders
      const prompt = SYNTHESIS_PROMPT.replace(
        '{existingMemory}',
        () => existingMemory || '(Empty — no existing profile)',
      )
        .replace('{newConversations}', () => newConversationsText)
        .replace('{maxWords}', () => String(maxWords));

      // Get LLM service from settings or use default
      const { provider, model } = await this.getLLMService(aiPlugin, llmServiceId, llmModel);
      if (!provider) {
        return { content: '', success: false, error: 'No LLM service configured for memory synthesis' };
      }

      const llmInstance = provider.createModel();

      // Call LLM for synthesis
      const response = await llmInstance.invoke([
        { role: 'system', content: prompt },
        { role: 'user', content: 'Please analyze the new conversations and update the user memory profile.' },
      ]);

      let content = this.extractResponseContent(response);

      if (!content || content.length < 10) {
        return { content: '', success: false, error: 'LLM returned empty or too short response' };
      }

      // Phase 6: Enforce maxTokens by truncating overly long responses.
      // Phase 7: A hard character cap (maxChars) takes precedence — the profile must
      // never exceed it regardless of the token budget.
      const tokenCharLimit = effectiveMaxTokens * CHARS_PER_TOKEN;
      const effectiveMaxChars = maxChars && maxChars > 0 ? maxChars : 2000;
      const maxCharsLimit = Math.min(effectiveMaxChars, tokenCharLimit);
      if (content.length > maxCharsLimit) {
        content = this.truncateProfile(content, maxCharsLimit);
        this.app.logger.debug(`[UserMemory] Synthesis output truncated to ${maxCharsLimit} chars`);
      }

      return { content: content.trim(), success: true };
    } catch (error: any) {
      this.app.logger.error('[UserMemory] Synthesis failed:', error);
      return { content: '', success: false, error: error.message };
    }
  }

  /**
   * Get the LLM service for synthesis — uses configured service or falls back.
   */
  private async getLLMService(aiPlugin: any, llmServiceId?: string, llmModel?: string) {
    try {
      if (llmServiceId) {
        return await aiPlugin.aiManager.getLLMService({
          llmService: llmServiceId,
          model: llmModel,
        });
      }

      // Try to get settings from our config
      const settings = await this.app.db.getRepository('userMemorySettings').findOne();
      if (settings?.llmService) {
        return await aiPlugin.aiManager.getLLMService({
          llmService: settings.llmService,
          model: settings.llmModel,
        });
      }

      // Fall back to any available service
      return await aiPlugin.aiManager.getLLMService({});
    } catch (error: any) {
      this.app.logger.warn('[UserMemory] Failed to get LLM service:', error.message);
      return { provider: null, model: null };
    }
  }

  /**
   * Extract text content from LLM response (handles different response formats).
   */
  private extractResponseContent(response: any): string {
    if (typeof response === 'string') return response;
    if (response?.content) {
      if (typeof response.content === 'string') return response.content;
      if (Array.isArray(response.content)) {
        return response.content
          .filter((part: any) => part.type === 'text')
          .map((part: any) => part.text)
          .join('');
      }
    }
    if (response?.text) return response.text;
    return '';
  }

  /**
   * Truncate the profile to approximately maxChars characters,
   * trying to cut at a section boundary (## heading) to keep it coherent.
   */
  private truncateProfile(content: string, maxChars: number): string {
    return truncateToMaxChars(content, maxChars);
  }
}
