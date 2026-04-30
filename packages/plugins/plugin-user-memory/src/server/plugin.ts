/**
 * plugin-user-memory — Main plugin class.
 *
 * Synthesizes user chat history into persistent memory profiles and injects them
 * into AI Employee system prompts for personalized responses.
 */

import { Plugin } from '@nocobase/server';
import { MemoryInjector } from './services/memory-injector';
import { MemorySyncJob } from './cron/memory-sync-job';
import * as userMemoryActions from './actions/user-memory';
import * as userMemoryAdminActions from './actions/user-memory-admin';

export class PluginUserMemoryServer extends Plugin {
  memoryInjector: MemoryInjector;
  syncJob: MemorySyncJob;

  async afterAdd() {}

  async beforeLoad() {}

  async load() {
    // 1. Initialize services
    this.memoryInjector = new MemoryInjector(this);
    this.syncJob = new MemorySyncJob(this.app);

    // 2. Register memory injection into AI system prompts
    this.memoryInjector.register();

    // 3. Define API resources
    this.defineResources();

    // 4. Set ACL permissions
    this.setPermissions();

    // 5. Schedule cron job for periodic memory sync
    await this.scheduleSyncJob();

    this.app.logger.info('[UserMemory] Plugin loaded successfully');
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

  private async scheduleSyncJob() {
    // Get schedule from settings or use default
    let cronTime = '0 0 3 * * *'; // Default: 3 AM daily

    try {
      const settings = await this.db.getRepository('userMemorySettings').findOne();
      if (settings?.syncSchedule) {
        cronTime = settings.syncSchedule;
      }
    } catch {
      // Settings collection may not be synced yet during first install
    }

    this.app.cronJobManager.addJob({
      cronTime,
      onTick: async () => {
        try {
          this.app.logger.info('[UserMemory] Running scheduled memory sync...');
          await this.syncJob.syncAll();

          // Also cleanup old logs
          const deleted = await this.syncJob.cleanupOldLogs();
          if (deleted > 0) {
            this.app.logger.info(`[UserMemory] Cleaned up ${deleted} old sync logs`);
          }
        } catch (error: any) {
          this.app.logger.error('[UserMemory] Scheduled sync failed:', error);
        }
      },
    });

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
          maxConversationsPerSync: 50,
          syncLogRetentionDays: 30,
        },
      });
    }
  }

  async upgrade() {}

  async afterEnable() {}

  async afterDisable() {}

  async remove() {}
}

export default PluginUserMemoryServer;
