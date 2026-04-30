/**
 * MemoryInjector — Responsible for injecting user memory profiles into AI Employee system prompts.
 *
 * Registers a system prompt enhancer with plugin-ai so that each time an AI Employee
 * builds its system prompt, the user's memory profile is automatically included.
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

  constructor(private plugin: Plugin) {
    this.profileService = new MemoryProfileService(plugin.db);
  }

  /**
   * Register the system prompt enhancer with plugin-ai.
   * This is called during plugin load().
   */
  register(): void {
    const aiPlugin = this.plugin.app.pm.get('ai') as any;
    if (!aiPlugin) {
      this.plugin.app.logger.warn('[UserMemory] plugin-ai not found, skipping memory injection registration');
      return;
    }

    // Register system prompt enhancer
    if (typeof aiPlugin.registerSystemPromptEnhancer === 'function') {
      aiPlugin.registerSystemPromptEnhancer('user-memory', async (ctx: any, userId: number) => {
        return this.getMemoryPromptSection(userId);
      });
      this.plugin.app.logger.info('[UserMemory] Registered system prompt enhancer with plugin-ai');
    } else {
      this.plugin.app.logger.warn(
        '[UserMemory] plugin-ai does not support registerSystemPromptEnhancer API. ' +
        'Please ensure plugin-ai has been updated with the extension point.',
      );
    }
  }

  /**
   * Get the memory prompt section for a given user.
   * Returns empty string if no profile or disabled.
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

      const content = `<user_memory>
The following is a memory profile about this specific user, synthesized from their past conversations.
Use this information to personalize your responses — adapt your language, detail level, and approach accordingly.

${profile.memoryContent}
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
