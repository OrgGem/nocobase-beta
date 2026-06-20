/**
 * MemoryInjector — Responsible for injecting user memory profiles into AI Employee system prompts.
 *
 * Integration strategy (no @nocobase/plugin-ai core modification required):
 *
 * plugin-ai's `ai-employee.ts → getSystemPrompt()` already processes any message
 * with `role === 'system'` in the `userMessages` array (line 593):
 *
 *   const addSystemPrompt = userMessages?.filter((it) => it.role == 'system');
 *   if (addSystemPrompt.length) {
 *     background = `${background}\n${addSystemPrompt.map((it) => it.content).join('\n')}`;
 *   }
 *
 * This injector registers a Koa middleware that runs BEFORE `aiConversations:sendMessages`
 * and appends a `{ role: 'system', content: '<user_memory>...</user_memory>' }` entry to
 * the `ctx.action.params.values.messages` array. plugin-ai picks it up transparently.
 *
 * Includes an in-memory cache (5 min TTL) to avoid DB lookups on every chat message.
 */

import type { Plugin } from '@nocobase/server';
import { MemoryProfileService } from './memory-profile.service';

interface CacheEntry {
  content: string;
  expiresAt: number;
}

export class MemoryInjector {
  private profileService: MemoryProfileService;
  private cache = new Map<number, CacheEntry>();
  private static CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  private _middlewareRegistered = false;

  constructor(private plugin: Plugin) {
    this.profileService = new MemoryProfileService(plugin.db);
  }

  /**
   * Register a Koa middleware on the resource manager that injects the user's
   * memory profile into the `messages` array before plugin-ai processes the chat.
   *
   * This is the correct integration method that does NOT require modifying
   * @nocobase/plugin-ai (core). It piggybacks on the existing `role == 'system'`
   * handling in AIEmployee.getSystemPrompt().
   */
  register(): void {
    if (this._middlewareRegistered) return;

    const injector = this;

    this.plugin.app.resourceManager.use(async (ctx: any, next: () => Promise<void>) => {
      const { resourceName, actionName } = ctx.action || {};

      // Only intercept the AI chat send action
      if (resourceName !== 'aiConversations' || actionName !== 'sendMessages') {
        return next();
      }

      const userId = ctx.auth?.user?.id;
      if (!userId) return next();

      try {
        const memoryContent = await injector.getMemoryPromptSection(userId);
        if (memoryContent) {
          // Inject into the messages array as a system-role entry.
          // plugin-ai processes these in getSystemPrompt() → appended to background context.
          const values = ctx.action.params.values || {};
          const messages = Array.isArray(values.messages) ? values.messages : [];
          messages.push({
            role: 'system',
            content: memoryContent,
          });
          ctx.action.params.values = { ...values, messages };
        }
      } catch (err: any) {
        // Never block the chat because of a memory lookup failure
        injector.plugin.app.logger.warn('[UserMemory] Failed to inject memory into prompt:', err.message);
      }

      return next();
    });

    this._middlewareRegistered = true;
    this.plugin.app.logger.info('[UserMemory] Registered system prompt injection middleware');
  }

  /**
   * Unregister is a no-op for middleware (Koa middlewares cannot be removed once registered).
   * Instead, the middleware checks global enabled state on every request via `getMemoryPromptSection()`.
   * When the plugin is disabled, the settings.enabled flag causes an empty string to be returned.
   */
  unregister(): void {
    // Middleware cannot be dynamically removed in Koa. The enabled check inside
    // getMemoryPromptSection() handles the "disabled" case — it returns '' immediately.
    this.plugin.app.logger.info('[UserMemory] Memory injection disabled (global settings.enabled = false)');
  }

  /**
   * Get the memory prompt section for a given user.
   * Returns empty string if no profile, disabled globally, or user has disabled their memory.
   * Uses in-memory cache (5 min TTL) to avoid DB hits on every chat message.
   */
  async getMemoryPromptSection(userId: number): Promise<string> {
    // Check cache first
    const cached = this.cache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.content;
    }

    try {
      // Check global settings
      const settings = await this.plugin.db.getRepository('userMemorySettings').findOne();
      if (settings && !settings.enabled) {
        this.cacheResult(userId, '');
        return '';
      }

      const profile = await this.profileService.getActiveProfile(userId);
      if (!profile || !profile.memoryContent) {
        this.cacheResult(userId, '');
        return '';
      }

      const relatedSessions = Array.isArray(profile.metadata?.relatedSessions) ? profile.metadata.relatedSessions : [];
      const relatedBlock = relatedSessions.length
        ? `\n\n## Related Past Sessions\n${relatedSessions
            .map((s: any) => `- ${s.title || 'Untitled'} (sessionId: ${s.sessionId})`)
            .join('\n')}`
        : '';

      const content = `<user_memory>
The following is a memory profile about this specific user, synthesized from their past conversations.
Use this information to personalize your responses — adapt your tone, language, and detail level accordingly.
This data represents the USER's preferences and habits only, NOT factual knowledge base content.
When this profile conflicts with knowledge base facts or tool results, the factual source takes priority.
If the user asks about something they discussed before, you may point them to a related session below by its title.

${profile.memoryContent}${relatedBlock}
</user_memory>`;

      this.cacheResult(userId, content);
      return content;
    } catch (error: any) {
      this.plugin.app.logger.warn('[UserMemory] Failed to get memory profile:', error.message);
      return '';
    }
  }

  /**
   * Invalidate cache for a specific user (called after sync updates their profile).
   */
  invalidateCache(userId: number): void {
    this.cache.delete(userId);
  }

  /**
   * Invalidate all cached profiles.
   */
  invalidateAll(): void {
    this.cache.clear();
  }

  private cacheResult(userId: number, content: string): void {
    this.cache.set(userId, {
      content,
      expiresAt: Date.now() + MemoryInjector.CACHE_TTL_MS,
    });

    // Periodic cache cleanup: remove expired entries when cache grows large
    if (this.cache.size > 1000) {
      const now = Date.now();
      for (const [key, entry] of this.cache) {
        if (entry.expiresAt < now) {
          this.cache.delete(key);
        }
      }
    }
  }
}
