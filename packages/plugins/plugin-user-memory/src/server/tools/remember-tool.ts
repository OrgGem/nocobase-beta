/**
 * Remember AI Tool
 *
 * Lets an AI employee persist a concise, durable fact about the CURRENT user
 * into their memory profile when the user explicitly asks to be remembered
 * (e.g. "remember that I prefer Vietnamese").
 *
 * Per-user isolation: the tool only ever reads/writes the profile of the user
 * who owns the chat session (ctx.auth.user.id). It can never touch another
 * user's memory.
 *
 * Registered by plugin-user-memory as a dynamic tool via toolsManager.
 */

import { z } from 'zod';
import type { PluginUserMemoryServer } from '../plugin';
import { MemoryProfileService } from '../services/memory-profile.service';
import { MemorySynthesizer, truncateToMaxChars } from '../services/memory-synthesizer';

const USER_NOTES_HEADING = '## User Notes';

/**
 * Append a user-stated fact under a "## User Notes" section of the existing
 * markdown profile. Creates the section if it does not exist. Skips exact
 * duplicate lines. Pure function — no DB access — so it is unit-testable.
 */
export function appendUserNote(existing: string, fact: string): string {
  const trimmedFact = fact.trim();
  if (!trimmedFact) return existing;

  const bullet = `- ${trimmedFact}`;
  const content = existing || '';

  if (content.includes(USER_NOTES_HEADING)) {
    const lines = content.split('\n');
    // Avoid duplicating the same note verbatim.
    if (lines.some((l) => l.trim() === bullet)) {
      return content;
    }
    const headingIndex = lines.findIndex((l) => l.trim() === USER_NOTES_HEADING);
    // Find the end of the User Notes section (next '## ' heading or EOF).
    let insertAt = lines.length;
    for (let i = headingIndex + 1; i < lines.length; i++) {
      if (lines[i].startsWith('## ')) {
        insertAt = i;
        break;
      }
    }
    lines.splice(insertAt, 0, bullet);
    return lines.join('\n');
  }

  const prefix = content.trim() ? `${content.trimEnd()}\n\n` : '';
  return `${prefix}${USER_NOTES_HEADING}\n${bullet}`;
}

export function createRememberToolProvider(plugin: PluginUserMemoryServer) {
  return async (register: { registerTools: (tools: any) => void }) => {
    register.registerTools({
      scope: 'CUSTOM' as const,
      execution: 'backend' as const,
      defaultPermission: 'ALLOW' as const,

      introduction: {
        title: 'Remember about user',
        about:
          'Save a concise, durable fact about the current user (preferences, habits, language, ' +
          'how they like to work) so future conversations are personalized.',
      },

      definition: {
        name: 'remember_user_fact',
        description: `Save a concise, durable fact about THE CURRENT USER into their personal memory.

Use this when the user explicitly asks you to remember something about them, or states a clear,
lasting preference (e.g. "I prefer Vietnamese", "always answer concisely", "I work mostly with React").

Rules:
- ONLY store the user's own preferences, habits, language, skills, or personality.
- DO NOT store knowledge base content, business/customer data, secrets, or PII.
- Keep the fact to one short sentence.

The fact is appended to the user's memory profile and auto-compacted if the profile grows too long.`,
        schema: z.object({
          fact: z
            .string()
            .min(1)
            .describe('One concise fact about the user to remember (e.g. "Prefers Vietnamese responses").'),
        }),
      },

      invoke: async (ctx: any, args: { fact: string }) => {
        try {
          const userId = ctx?.auth?.user?.id || ctx?.state?.currentUser?.id;
          if (!userId) {
            return {
              status: 'error' as const,
              content: 'Cannot determine the current user. This tool only works inside an authenticated chat session.',
            };
          }

          const fact = (args?.fact || '').trim();
          if (!fact) {
            return { status: 'error' as const, content: 'No fact provided to remember.' };
          }

          const settings = await plugin.db.getRepository('userMemorySettings').findOne();
          if (settings && settings.enabled === false) {
            return {
              status: 'error' as const,
              content: 'User memory is currently disabled by the administrator.',
            };
          }
          const maxChars = settings?.maxChars && settings.maxChars > 0 ? settings.maxChars : 2000;
          const maxTokens = settings?.maxTokens || 800;

          const service = new MemoryProfileService(plugin.db);
          const profile = await service.getOrCreate(Number(userId));

          if (!profile.enabled) {
            return {
              status: 'error' as const,
              content: 'You have disabled your memory. Enable it first to store new facts.',
            };
          }

          let newContent = appendUserNote(profile.memoryContent || '', fact);

          // Auto-compact when the appended content exceeds the hard cap.
          if (newContent.length > maxChars) {
            const synthesizer = new MemorySynthesizer(plugin.app as any);
            const result = await synthesizer.synthesize(
              newContent,
              '',
              settings?.llmService,
              settings?.llmModel,
              maxTokens,
              maxChars,
            );
            if (result.success && result.content) {
              newContent = result.content;
            } else {
              // LLM compaction unavailable — fall back to a hard truncation so
              // the cap always holds.
              newContent = truncateToMaxChars(newContent, maxChars);
            }
          }

          await service.updateMemory(Number(userId), newContent, profile.lastConversationSessionId);
          plugin.invalidateMemoryCache(Number(userId));

          return {
            status: 'success' as const,
            content: `Got it — I'll remember that: "${fact}".`,
          };
        } catch (e: any) {
          return { status: 'error' as const, content: `Failed to save memory: ${e.message}` };
        }
      },
    });
  };
}
