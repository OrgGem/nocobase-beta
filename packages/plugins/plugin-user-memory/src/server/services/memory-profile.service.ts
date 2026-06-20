/**
 * MemoryProfileService — CRUD operations for user memory profiles.
 *
 * Handles creating, reading, updating memory profiles and managing
 * the per-user toggle for memory injection.
 */

import type { Database } from '@nocobase/database';
import type { RelatedSession } from './conversation-extractor';

/** Max related sessions to retain in profile metadata. */
export const MAX_RELATED_SESSIONS = 10;

/**
 * Merge newly processed sessions into the existing list, dedupe by sessionId
 * (newest wins), sort by updatedAt desc, and keep at most MAX_RELATED_SESSIONS.
 */
export function mergeRelatedSessions(
  existing: RelatedSession[] = [],
  incoming: RelatedSession[] = [],
): RelatedSession[] {
  const byId = new Map<string, RelatedSession>();
  for (const s of existing) {
    if (s?.sessionId) byId.set(s.sessionId, s);
  }
  // Incoming entries override existing ones with the same sessionId.
  for (const s of incoming) {
    if (s?.sessionId) byId.set(s.sessionId, s);
  }
  return Array.from(byId.values())
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, MAX_RELATED_SESSIONS);
}

export interface MemoryProfile {
  id: number;
  userId: number;
  memoryContent: string;
  memoryVersion: number;
  lastSyncedAt: Date | null;
  lastConversationSessionId: string | null;
  status: 'idle' | 'processing' | 'error';
  enabled: boolean;
  metadata: Record<string, any>;
}

export class MemoryProfileService {
  constructor(private db: Database) {}

  /**
   * Get or create a memory profile for a user.
   */
  async getOrCreate(userId: number): Promise<MemoryProfile> {
    const repo = this.db.getRepository('userMemoryProfiles');

    let profile = await repo.findOne({ filter: { userId } });
    if (!profile) {
      profile = await repo.create({
        values: {
          userId,
          memoryContent: '',
          memoryVersion: 0,
          status: 'idle',
          enabled: true,
          metadata: {},
        },
      });
    }

    return profile as unknown as MemoryProfile;
  }

  /**
   * Get the memory profile for a user (null if doesn't exist or disabled).
   */
  async getActiveProfile(userId: number): Promise<MemoryProfile | null> {
    const repo = this.db.getRepository('userMemoryProfiles');
    const profile = await repo.findOne({
      filter: { userId, enabled: true },
    });

    if (!profile || !profile.memoryContent) return null;
    return profile as unknown as MemoryProfile;
  }

  /**
   * Update the memory content after a successful sync.
   */
  async updateMemory(
    userId: number,
    memoryContent: string,
    lastSessionId: string | null,
    relatedSessions?: RelatedSession[],
  ): Promise<MemoryProfile> {
    const profile = await this.getOrCreate(userId);
    const repo = this.db.getRepository('userMemoryProfiles');

    const mergedSessions = mergeRelatedSessions(
      (profile.metadata?.relatedSessions as RelatedSession[]) || [],
      relatedSessions || [],
    );

    await repo.update({
      filter: { userId },
      values: {
        memoryContent,
        memoryVersion: (profile.memoryVersion || 0) + 1,
        lastSyncedAt: new Date(),
        lastConversationSessionId: lastSessionId,
        status: 'idle',
        metadata: {
          ...profile.metadata,
          relatedSessions: mergedSessions,
          lastContentLength: memoryContent.length,
          estimatedTokens: Math.ceil(memoryContent.length / 4), // rough estimate
        },
      },
    });

    return this.getOrCreate(userId);
  }

  /**
   * Set profile status (used during sync to mark processing/error states).
   */
  async setStatus(userId: number, status: 'idle' | 'processing' | 'error', error?: string): Promise<void> {
    const repo = this.db.getRepository('userMemoryProfiles');
    const profile = await repo.findOne({ filter: { userId } });
    if (!profile) return;

    const values: Record<string, any> = { status };
    if (status === 'processing') {
      values.metadata = {
        ...profile.metadata,
        lastProcessingStartedAt: new Date().toISOString(),
      };
    }
    if (error) {
      values.metadata = {
        ...(values.metadata || profile.metadata),
        lastError: error,
        lastErrorAt: new Date().toISOString(),
      };
    }

    await repo.update({ filter: { userId }, values });
  }

  /**
   * Atomically try to acquire the processing lock for a user.
   * Uses a CAS (Compare-And-Swap) pattern to prevent race conditions
   * when multiple sync processes run concurrently.
   * Returns true if the lock was acquired, false if already processing.
   */
  async tryAcquireProcessingLock(userId: number): Promise<boolean> {
    const repo = this.db.getRepository('userMemoryProfiles');
    const model = repo.model;
    const [affectedCount] = await model.update(
      {
        status: 'processing',
        metadata: this.db.sequelize.literal(
          `jsonb_set(COALESCE(metadata, '{}'), '{lastProcessingStartedAt}', '"${new Date().toISOString()}"')`,
        ),
      } as any,
      { where: { userId, status: { [this.db.sequelize.constructor['Op'].ne]: 'processing' } } },
    );
    return affectedCount > 0;
  }

  /**
   * Check if user has synced recently (for rate limiting).
   * Returns the number of milliseconds until the user can sync again, or 0 if allowed.
   */
  async getRateLimitRemainingMs(userId: number, cooldownMs: number = 5 * 60 * 1000): Promise<number> {
    const profile = await this.getOrCreate(userId);
    if (!profile.lastSyncedAt) return 0;
    const elapsed = Date.now() - new Date(profile.lastSyncedAt).getTime();
    return Math.max(0, cooldownMs - elapsed);
  }

  /**
   * Toggle memory feature for a user.
   */
  async toggleEnabled(userId: number, enabled: boolean): Promise<void> {
    const profile = await this.getOrCreate(userId);
    const repo = this.db.getRepository('userMemoryProfiles');

    await repo.update({
      filter: { userId },
      values: { enabled },
    });
  }

  /**
   * Get all users with active memory profiles (for batch sync).
   */
  async getActiveUserIds(): Promise<number[]> {
    const repo = this.db.getRepository('userMemoryProfiles');
    const profiles = await repo.find({
      filter: { enabled: true },
      fields: ['userId'],
    });
    return profiles.map((p: any) => p.userId);
  }

  /**
   * Get all users who have had conversations (even if no profile yet).
   * Uses SELECT DISTINCT to avoid loading all rows into memory.
   */
  async getAllChatUserIds(): Promise<number[]> {
    try {
      const [results] = await this.db.sequelize.query(
        `SELECT DISTINCT "userId" FROM "aiConversations" WHERE "userId" IS NOT NULL`,
      );
      return (results as any[]).map((r: any) => r.userId).filter(Boolean);
    } catch {
      // Fallback for databases where raw query might fail (e.g., table name quoting)
      const convRepo = this.db.getRepository('aiConversations');
      const conversations = await convRepo.find({ fields: ['userId'], limit: 10000 });
      const uniqueIds = [...new Set(conversations.map((c: any) => c.userId).filter(Boolean))];
      return uniqueIds as number[];
    }
  }

  /**
   * Log a sync event.
   */
  async logSync(data: {
    userId: number;
    syncType: 'scheduled' | 'manual';
    conversationsProcessed: number;
    messagesProcessed: number;
    previousVersion: number;
    newVersion: number;
    changeSummary?: string;
    error?: string;
    status: 'success' | 'error' | 'skipped';
  }): Promise<void> {
    await this.db.getRepository('userMemorySyncLogs').create({
      values: data,
    });
  }
}
