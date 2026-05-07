/**
 * MemorySyncJob — Scheduled cron job that processes all active users
 * and synthesizes their memory profiles from recent chat history.
 */

import type { Application } from '@nocobase/server';
import { ConversationExtractor } from '../services/conversation-extractor';
import { MemoryProfileService } from '../services/memory-profile.service';
import { MemorySynthesizer } from '../services/memory-synthesizer';

export class MemorySyncJob {
  private extractor: ConversationExtractor;
  private profileService: MemoryProfileService;
  private synthesizer: MemorySynthesizer;

  constructor(private app: Application) {
    this.extractor = new ConversationExtractor(app.db);
    this.profileService = new MemoryProfileService(app.db);
    this.synthesizer = new MemorySynthesizer(app);
  }

  /**
   * Run sync for all active users. Called by cron job.
   */
  async syncAll(): Promise<{ processed: number; skipped: number; errors: number }> {
    const logger = this.app.logger;
    logger.info('[UserMemory] Starting scheduled memory sync for all users...');

    // Check global settings
    const settings = await this.app.db.getRepository('userMemorySettings').findOne();
    if (settings && !settings.enabled) {
      logger.info('[UserMemory] Feature is globally disabled, skipping sync');
      return { processed: 0, skipped: 0, errors: 0 };
    }

    const maxConvPerSync = settings?.maxConversationsPerSync || 50;

    // Get all users who have ever chatted
    const allUserIds = await this.profileService.getAllChatUserIds();
    let processed = 0;
    let skipped = 0;
    let errors = 0;

    for (const userId of allUserIds) {
      try {
        const result = await this.syncUser(userId, 'scheduled', maxConvPerSync, settings);
        if (result === 'processed') processed++;
        else if (result === 'skipped') skipped++;
      } catch (error: any) {
        errors++;
        logger.error(`[UserMemory] Sync failed for user ${userId}:`, error.message);
      }
    }

    logger.info(
      `[UserMemory] Sync complete: ${processed} processed, ${skipped} skipped, ${errors} errors (${allUserIds.length} total users)`,
    );

    return { processed, skipped, errors };
  }

  /**
   * Sync memory for a single user.
   */
  async syncUser(
    userId: number,
    syncType: 'scheduled' | 'manual' = 'manual',
    maxConversations?: number,
    settings?: any,
  ): Promise<'processed' | 'skipped' | 'error'> {
    const logger = this.app.logger;

    // Get or create the profile
    const profile = await this.profileService.getOrCreate(userId);

    // Check if user has disabled memory
    if (!profile.enabled) {
      logger.debug(`[UserMemory] User ${userId} has disabled memory, skipping`);
      return 'skipped';
    }

    // Recover from stale processing status (server crash during sync)
    if (profile.status === 'processing') {
      const processingStartedAt = profile.metadata?.lastProcessingStartedAt;
      const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
      if (processingStartedAt && new Date(processingStartedAt) < thirtyMinAgo) {
        logger.warn(`[UserMemory] User ${userId} stuck in processing for >30min, resetting`);
        await this.profileService.setStatus(userId, 'error', 'Processing timeout — auto-recovered');
      } else {
        logger.debug(`[UserMemory] User ${userId} already processing, skipping`);
        return 'skipped';
      }
    }

    // Atomically acquire the processing lock (CAS: idle → processing)
    const lockAcquired = await this.profileService.tryAcquireProcessingLock(userId);
    if (!lockAcquired) {
      logger.debug(`[UserMemory] User ${userId} lock not acquired (concurrent sync), skipping`);
      return 'skipped';
    }
    // Load settings if not provided
    if (!settings) {
      settings = await this.app.db.getRepository('userMemorySettings').findOne();
    }

    try {
      // Extract new conversations since last sync
      const extractionResult = await this.extractor.extract(
        userId,
        profile.lastSyncedAt || undefined,
        maxConversations || settings?.maxConversationsPerSync || 50,
      );

      if (!extractionResult.conversations.length) {
        await this.profileService.setStatus(userId, 'idle');
        await this.profileService.logSync({
          userId,
          syncType,
          conversationsProcessed: 0,
          messagesProcessed: 0,
          previousVersion: profile.memoryVersion,
          newVersion: profile.memoryVersion,
          status: 'skipped',
          changeSummary: 'No new conversations to process',
        });
        return 'skipped';
      }

      // Format conversations for summarization
      const conversationsText = this.extractor.formatForSummarization(extractionResult);

      // Synthesize via LLM (Phase 6: pass maxTokens from settings)
      const synthesisResult = await this.synthesizer.synthesize(
        profile.memoryContent || '',
        conversationsText,
        settings?.llmService,
        settings?.llmModel,
        settings?.maxTokens,
      );

      if (!synthesisResult.success) {
        await this.profileService.setStatus(userId, 'error', synthesisResult.error);
        await this.profileService.logSync({
          userId,
          syncType,
          conversationsProcessed: extractionResult.conversations.length,
          messagesProcessed: extractionResult.totalMessages,
          previousVersion: profile.memoryVersion,
          newVersion: profile.memoryVersion,
          status: 'error',
          error: synthesisResult.error,
        });
        return 'error';
      }

      // Update profile with synthesized memory
      const updatedProfile = await this.profileService.updateMemory(
        userId,
        synthesisResult.content,
        extractionResult.lastSessionId,
      );

      // Log success
      await this.profileService.logSync({
        userId,
        syncType,
        conversationsProcessed: extractionResult.conversations.length,
        messagesProcessed: extractionResult.totalMessages,
        previousVersion: profile.memoryVersion,
        newVersion: updatedProfile.memoryVersion,
        status: 'success',
        changeSummary: `Processed ${extractionResult.conversations.length} conversations, ${extractionResult.totalMessages} messages`,
      });

      logger.info(
        `[UserMemory] Synced user ${userId}: v${profile.memoryVersion} → v${updatedProfile.memoryVersion} (${extractionResult.conversations.length} convos)`,
      );

      return 'processed';
    } catch (error: any) {
      await this.profileService.setStatus(userId, 'error', error.message);
      await this.profileService.logSync({
        userId,
        syncType,
        conversationsProcessed: 0,
        messagesProcessed: 0,
        previousVersion: profile.memoryVersion,
        newVersion: profile.memoryVersion,
        status: 'error',
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Cleanup old sync logs beyond retention period.
   */
  async cleanupOldLogs(): Promise<number> {
    const settings = await this.app.db.getRepository('userMemorySettings').findOne();
    const retentionDays = settings?.syncLogRetentionDays || 30;
    const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    const deleted = await this.app.db.getRepository('userMemorySyncLogs').destroy({
      filter: {
        createdAt: { $lt: cutoffDate },
      },
    });

    return typeof deleted === 'number' ? deleted : 0;
  }
}
