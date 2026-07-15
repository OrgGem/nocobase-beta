/**
 * plugin-user-memory — Main plugin class.
 *
 * Synthesizes user chat history into persistent memory profiles and injects them
 * into AI Employee system prompts for personalized responses.
 */

import { resolve } from 'path';
import { Plugin } from '@nocobase/server';
import { MemoryInjector } from './services/memory-injector';
import { MemorySyncJob } from './cron/memory-sync-job';
import * as userMemoryActions from './actions/user-memory';
import * as userMemoryAdminActions from './actions/user-memory-admin';
import { createRememberToolProvider } from './tools/remember-tool';
import { installUserMemoryDbSyncRaceGuard } from './utils/db-sync-race-guard';

type CronJobLike = {
  start(): void;
  stop(): void;
};

interface AgentRuntimeContext {
  userId?: number;
  messages: Array<{ role: string; content: unknown }>;
  metadata: Record<string, unknown>;
}

interface AgentRuntimeLifecycle {
  registerBeforeRunHook(name: string, hook: (context: AgentRuntimeContext) => Promise<void>): () => void;
  registerAfterRunHook(
    name: string,
    hook: (context: AgentRuntimeContext, result: { succeeded: boolean }) => Promise<void>,
  ): () => void;
}

export class PluginUserMemoryServer extends Plugin {
  memoryInjector: MemoryInjector;
  syncJob: MemorySyncJob;
  private _cronJobInstance: CronJobLike | null = null;
  private readonly autoSyncCooldownMs = 5 * 60 * 1000;
  private readonly autoSyncLastRun = new Map<number, number>();
  private runtimeHooksRegistered = false;
  private runtimeHookCleanup: Array<() => void> = [];
  private readonly registerRuntimeHooksAfterStart = () => this.registerRuntimeHooks();

  async afterAdd() {}

  async beforeLoad() {
    installUserMemoryDbSyncRaceGuard(this.db, this.app.logger);
  }

  async load() {
    await this.importCollections(resolve(__dirname, 'collections'));

    // Ensure dayjs timezone + utc plugins are loaded globally to prevent 'm.startOf is not a function' errors
    const dayjsLib = require('dayjs');
    const utcPlugin = require('dayjs/plugin/utc');
    const timezonePlugin = require('dayjs/plugin/timezone');
    dayjsLib.extend(utcPlugin);
    dayjsLib.extend(timezonePlugin);

    // 1. Initialize services
    this.memoryInjector = new MemoryInjector(this);
    this.syncJob = new MemorySyncJob(this.app);

    // 2. Register memory injection into AI system prompts via plugin-ai extension point
    this.memoryInjector.register();

    // 2b. Register the "remember" AI tool so agents can persist user facts on command
    this.registerRememberTool();

    // 3. Keep memory storage fresh after successful chats
    this.registerAutoSyncAfterChat();
    this.registerRuntimeHooks();
    this.app.on('afterStart', this.registerRuntimeHooksAfterStart);

    // 4. Define API resources
    this.defineResources();

    // 5. Set ACL permissions
    this.setPermissions();

    // 5. Schedule cron job for periodic memory sync
    await this.scheduleSyncJob();

    this.app.logger.info('[UserMemory] Plugin loaded successfully');
  }

  // ─── Public helpers (called by action handlers via plugin singleton) ────────────────

  /**
   * Invalidate the in-memory cache for a specific user (or ALL users when userId is omitted).
   * Must be called after clearMemory / toggleEnabled / syncNow / syncUser / syncAll
   * so the next chat request picks up the updated profile immediately.
   */
  invalidateMemoryCache(userId?: number): void {
    if (userId !== undefined) {
      this.memoryInjector?.invalidateCache(userId);
    } else {
      this.memoryInjector?.invalidateAll();
    }
  }

  /**
   * Reschedule the sync cron job when the admin changes syncSchedule in settings.
   */
  async rescheduleSyncJob(newCronTime: string): Promise<void> {
    await this.scheduleSyncJob(newCronTime);
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────────────

  private registerRememberTool() {
    try {
      const toolsManager = (
        this.app as typeof this.app & {
          aiManager?: { toolsManager?: { registerDynamicTools: (provider: unknown) => void } };
        }
      ).aiManager?.toolsManager;
      if (!toolsManager) {
        this.app.logger.warn('[UserMemory] plugin-ai toolsManager not available, skip remember tool.');
        return;
      }
      toolsManager.registerDynamicTools(createRememberToolProvider(this));
      this.app.logger.info('[UserMemory] remember_user_fact AI tool registered.');
    } catch (err: any) {
      this.app.logger.warn('[UserMemory] Failed to register remember tool:', err.message);
    }
  }

  private registerAutoSyncAfterChat() {
    this.app.resourceManager.use(async (ctx: any, next: () => Promise<void>) => {
      const { resourceName, actionName } = ctx.action || {};
      if (resourceName !== 'aiConversations' || actionName !== 'sendMessages') {
        return next();
      }

      await next();

      const userId = ctx.auth?.user?.id;
      if (!userId || ctx.status >= 400) {
        return;
      }

      const now = Date.now();
      const lastRun = this.autoSyncLastRun.get(userId) || 0;
      if (now - lastRun < this.autoSyncCooldownMs) {
        return;
      }

      this.autoSyncLastRun.set(userId, now);

      try {
        const result = await this.syncJob.syncUser(userId, 'manual');
        if (result !== 'error') {
          this.invalidateMemoryCache(userId);
        }
      } catch (error: any) {
        this.app.logger.warn('[UserMemory] Auto-sync after chat failed:', error.message);
      }
    });
  }

  private registerRuntimeHooks(): void {
    if (this.runtimeHooksRegistered) return;
    const lifecycle = (this.app as typeof this.app & { agentRuntimeLifecycle?: AgentRuntimeLifecycle })
      .agentRuntimeLifecycle;
    if (!lifecycle) return;

    this.runtimeHookCleanup.push(
      lifecycle.registerBeforeRunHook('user-memory', async (context) => {
        if (!context.userId || context.metadata.userMemoryInjected) return;
        const memoryContent = await this.memoryInjector.getMemoryPromptSection(context.userId);
        if (!memoryContent) return;

        context.messages.unshift({
          role: 'system',
          content: { type: 'text', content: memoryContent },
        });
        context.metadata.userMemoryInjected = true;
      }),
      lifecycle.registerAfterRunHook('user-memory-sync', async (context, result) => {
        if (!result.succeeded || !context.userId) return;
        const now = Date.now();
        const lastRun = this.autoSyncLastRun.get(context.userId) || 0;
        if (now - lastRun < this.autoSyncCooldownMs) return;

        this.autoSyncLastRun.set(context.userId, now);
        const userId = context.userId;
        setImmediate(() => {
          this.syncJob
            .syncUser(userId, 'manual')
            .then((syncResult) => {
              if (syncResult !== 'error') this.invalidateMemoryCache(userId);
            })
            .catch((error: unknown) => {
              this.app.logger.warn('[UserMemory] Background Agent API memory sync failed.', {
                error: error instanceof Error ? error : new Error(String(error)),
              });
            });
        });
      }),
    );
    this.runtimeHooksRegistered = true;
    this.app.logger.info('[UserMemory] Agent runtime lifecycle hooks registered.');
  }

  private defineResources() {
    // User-facing resource
    this.app.resourceManager.define({
      name: 'userMemory',
      actions: {
        getProfile: userMemoryActions.getProfile,
        toggleEnabled: userMemoryActions.toggleEnabled,
        syncNow: userMemoryActions.syncNow,
        getSyncLogs: userMemoryActions.getSyncLogs,
        clearMemory: userMemoryActions.clearMemory,
      },
    });

    // Admin resource
    this.app.resourceManager.define({
      name: 'userMemoryAdmin',
      actions: {
        getSettings: userMemoryAdminActions.getSettings,
        updateSettings: userMemoryAdminActions.updateSettings,
        syncAll: userMemoryAdminActions.syncAll,
        listProfiles: userMemoryAdminActions.listProfiles,
        getUserProfile: userMemoryAdminActions.getUserProfile,
        syncUser: userMemoryAdminActions.syncUser,
        cleanupLogs: userMemoryAdminActions.cleanupLogs,
      },
    });
  }

  private setPermissions() {
    // User actions — any logged-in user can manage their own memory
    this.app.acl.allow('userMemory', 'getProfile', 'loggedIn');
    this.app.acl.allow('userMemory', 'toggleEnabled', 'loggedIn');
    this.app.acl.allow('userMemory', 'syncNow', 'loggedIn');
    this.app.acl.allow('userMemory', 'getSyncLogs', 'loggedIn');
    this.app.acl.allow('userMemory', 'clearMemory', 'loggedIn');

    // Admin actions — restricted via snippet
    this.app.acl.registerSnippet({
      name: `pm.${this.name}.admin`,
      actions: ['userMemoryAdmin:*'],
    });
  }

  private async scheduleSyncJob(overrideCronTime?: string): Promise<void> {
    if (!this.app.serving()) {
      this.app.logger.info('[UserMemory] Scheduled sync job skipped in worker-only mode');
      return;
    }

    // Remove the existing job before re-adding (for reschedule support)
    if (this._cronJobInstance) {
      try {
        this.app.cronJobManager.removeJob(this._cronJobInstance);
        this._cronJobInstance = null;
      } catch {
        // No existing job — that's fine on first load
      }
    }

    // Resolve schedule: use override, then settings, then default
    let cronTime = overrideCronTime || '0 0 3 * * *'; // Default: 3 AM daily

    if (!overrideCronTime) {
      try {
        const settings = await this.db.getRepository('userMemorySettings').findOne();
        if (settings?.syncSchedule) {
          cronTime = settings.syncSchedule;
        }
      } catch {
        // Settings collection may not be synced yet during first install
      }
    }

    this._cronJobInstance = this.app.cronJobManager.addJob({
      cronTime,
      onTick: async () => {
        try {
          this.app.logger.info('[UserMemory] Running scheduled memory sync...');
          const result = await this.syncJob.syncAll();

          // Phase 5: Invalidate ALL cached profiles after a full sync
          this.invalidateMemoryCache();

          // Also cleanup old logs
          const deleted = await this.syncJob.cleanupOldLogs();
          if (deleted > 0) {
            this.app.logger.info(`[UserMemory] Cleaned up ${deleted} old sync logs`);
          }

          this.app.logger.info(
            `[UserMemory] Sync complete: ${result.processed} processed, ${result.skipped} skipped, ${result.errors} errors`,
          );
        } catch (error: any) {
          this.app.logger.error('[UserMemory] Scheduled sync failed:', error);
        }
      },
    } as any);

    this.app.logger.info(`[UserMemory] Scheduled sync job: ${cronTime}`);
  }

  async install() {
    // Create default settings on first install
    const settingsRepo = this.db.getRepository('userMemorySettings');
    const existing = await settingsRepo.findOne();
    if (!existing) {
      await settingsRepo.create({
        values: {
          enabled: true,
          syncSchedule: '0 0 3 * * *',
          maxTokens: 800,
          maxChars: 2000,
          maxConversationsPerSync: 50,
          syncLogRetentionDays: 30,
        },
      });
    }
  }

  async upgrade() {}

  async afterEnable() {}

  async afterDisable() {
    // Memory injection is handled via Koa middleware which checks settings.enabled per request.
    // Invalidate the entire cache so the disabled state is reflected immediately
    // without waiting for 5-min TTL to expire.
    this.memoryInjector?.invalidateAll();
    this.cleanupRuntimeHooks();
    this.app.logger.info('[UserMemory] Plugin disabled — memory cache cleared');
  }

  async remove() {
    this.cleanupRuntimeHooks();
    this.memoryInjector?.invalidateAll();
  }

  async beforeStop() {
    this.app.off?.('afterStart', this.registerRuntimeHooksAfterStart);
    this.app.removeListener?.('afterStart', this.registerRuntimeHooksAfterStart);
    this.cleanupRuntimeHooks();
  }

  private cleanupRuntimeHooks(): void {
    for (const cleanup of this.runtimeHookCleanup.splice(0)) cleanup();
    this.runtimeHooksRegistered = false;
  }
}

export default PluginUserMemoryServer;
