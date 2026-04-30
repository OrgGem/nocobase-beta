/**
 * MemorySynthesizer — LLM-powered service that summarizes user conversations
 * into a concise markdown memory profile.
 *
 * Uses the configured LLM from plugin-ai to analyze conversation history
 * and merge findings with existing memory content.
 */

import type { Application } from '@nocobase/server';

const SYNTHESIS_PROMPT = `You are a User Profile Analyst. Your job is to maintain a concise memory profile about a user based on their chat history with AI assistants.

## Current Profile
{existingMemory}

## New Conversations to Analyze
{newConversations}

## Instructions
1. Analyze the new conversations for:
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
   - Keep the profile CONCISE — max 500 words total

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

CRITICAL RULES:
- Be factual. Only include information DIRECTLY observed from conversations.
- Do NOT infer, speculate, or assume anything not evidenced in the chat.
- Do NOT include sensitive personal data (passwords, emails, phone numbers).
- Keep each bullet point SHORT (1 line max).
- If the current profile is empty, create a new one from scratch.
- Output ONLY the markdown profile — no explanations, no preamble.`;

export interface SynthesisResult {
  content: string;
  success: boolean;
  error?: string;
}

export class MemorySynthesizer {
  constructor(private app: Application) {}

  /**
   * Synthesize a memory profile from existing memory + new conversation data.
   * Uses the LLM configured in userMemorySettings (or falls back to default).
   */
  async synthesize(
    existingMemory: string,
    newConversationsText: string,
    llmServiceId?: string,
    llmModel?: string,
  ): Promise<SynthesisResult> {
    try {
      const aiPlugin = this.app.pm.get('ai') as any;
      if (!aiPlugin) {
        return { content: '', success: false, error: 'plugin-ai not available' };
      }

      // Build the prompt — use arrow functions to prevent replacement pattern injection
      // (prevents existingMemory containing '{newConversations}' from being expanded)
      const prompt = SYNTHESIS_PROMPT
        .replace('{existingMemory}', () => existingMemory || '(Empty — no existing profile)')
        .replace('{newConversations}', () => newConversationsText);

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

      const content = this.extractResponseContent(response);

      if (!content || content.length < 10) {
        return { content: '', success: false, error: 'LLM returned empty or too short response' };
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
}
