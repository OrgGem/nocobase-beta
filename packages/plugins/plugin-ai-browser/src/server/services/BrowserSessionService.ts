import type { Application } from '@nocobase/server';
import type { IBrowserDriver, BrowserDriverSession, BrowserDriverSessionOptions, BrowserPolicy } from '../drivers';

/**
 * BrowserSessionService
 *
 * Manages lifecycle of browser sessions:
 * create → running → completed/failed/stopped/expired
 *
 * Holds a reference to the active IBrowserDriver and delegates
 * all browser operations through it.
 */
export class BrowserSessionService {
  private app: Application;
  private driver: IBrowserDriver;
  /** In-memory map of sessionId → last activity timestamp (epoch ms) */
  private lastActivityMap = new Map<string, number>();
  /** Idle timeout in ms — sessions with no activity for this long are expired */
  private idleTimeoutMs: number;

  constructor(app: Application, driver: IBrowserDriver) {
    (this as any).app = app;
    this.driver = driver;
    this.idleTimeoutMs = Number(process.env.AI_BROWSER_IDLE_TIMEOUT_SECONDS || 120) * 1000; // default 2 min
    this.startZombieSweeper();
  }

  /**
   * Mark a session as active (resets the idle timer).
   * Call this from every tool action.
   */
  touchSession(sessionId: string) {
    this.lastActivityMap.set(sessionId, Date.now());
  }

  private startZombieSweeper() {
    const sweep = async () => {
      try {
        const repo = (this as any).app.db.getRepository('aiBrowserSessions');
        // Make sure DB is ready
        if (!repo) return;
        const runningSessions = await repo.find({ filter: { status: 'running' } });
        const now = Date.now();
        for (const session of runningSessions) {
          const sessionId = session.get('id');
          const externalId = session.get('externalSessionId');

          // 1. Check if the browser process is still alive
          const metadata = session.get('metadata') || {};
          const activeStatus = await ((this.driver as any).ensureSession?.(externalId, metadata.driver || {}) ||
            this.driver.getSessionStatus(externalId));
          if (!activeStatus || activeStatus.status !== 'running') {
            // In clustered deployments another app process may own the in-memory
            // Playwright handle. Do not aggressively expire recoverable sessions.
            if (!metadata.driver?.browserWSEndpoint && !metadata.driver?.debugUrl) {
              this.lastActivityMap.delete(sessionId);
              await this.expireSession(sessionId);
            }
            continue;
          }

          // 2. Check idle timeout. Profiles can override the global value per user.
          const lastActivity = this.lastActivityMap.get(sessionId);
          const policy = metadata.policy || {};
          const sessionIdleTimeoutMs = Number(policy.idleTimeoutSeconds || this.idleTimeoutMs / 1000) * 1000;
          if (lastActivity && (now - lastActivity) > sessionIdleTimeoutMs) {
            (this as any).app.logger.info(
              `[ai-browser] Session ${sessionId} idle for ${Math.round((now - lastActivity) / 1000)}s (limit ${sessionIdleTimeoutMs / 1000}s), expiring`,
            );
            this.lastActivityMap.delete(sessionId);
            await this.expireSession(sessionId);
            continue;
          }
        }
      } catch (err) {
        (this as any).app.logger.error(`[ai-browser] Zombie sweeper error: ${(err as any).message}`);
      }
    };

    // Run immediately, but wait a few seconds for DB to initialize
    setTimeout(sweep, 5000);
    setInterval(sweep, 15000); // Check every 15 seconds (fast enough to enforce 2-min idle)
  }

  /**
   * Create a new browser session and persist it.
   */
  async createSession(params: {
    title?: string;
    startUrl?: string;
    profileId?: string;
    ownerId: number;
    conversationId?: string;
    policy?: BrowserPolicy;
    metadata?: Record<string, any>;
  }): Promise<any> {
    const repo = (this as any).app.db.getRepository('aiBrowserSessions');
    const profileRepo = (this as any).app.db.getRepository('aiBrowserProfiles');

    // Load the explicitly requested profile, or the latest enabled owner profile.
    // This keeps chat-created sessions on the admin's per-user policy by default.
    let profileId = params.profileId;
    if (!profileId && params.ownerId) {
      const defaultProfile = await profileRepo.findOne({
        filter: {
          ownerId: params.ownerId,
          enabled: true,
        },
        sort: ['-updatedAt'],
      });
      profileId = defaultProfile?.get?.('id') || defaultProfile?.id;
    }

    // Load profile if available
    let launchOptions: Record<string, any> = {};
    let mergedPolicy = params.policy || {};
    if (profileId) {
      const profile = await profileRepo.findById(profileId);
      if (profile) {
        launchOptions = profile.get('launchOptions') || {};
        const profilePolicy = profile.get('defaultPolicy') || {};
        mergedPolicy = { ...profilePolicy, ...mergedPolicy };
      }
    }

    // Load default policy from config
    const defaultPolicy = await this.getDefaultPolicy();
    mergedPolicy = { ...defaultPolicy, ...mergedPolicy };

    // Calculate expiry
    const maxDuration = mergedPolicy.maxDurationSeconds || Number(process.env.AI_BROWSER_SESSION_TTL_SECONDS || 1800);
    const expiresAt = new Date(Date.now() + maxDuration * 1000);

    // Create driver session
    const driverSession = await this.driver.createSession({
      startUrl: params.startUrl,
      profileId,
      launchOptions,
      policy: mergedPolicy,
    });

    // Persist to DB
    const session = await repo.create({
      values: {
        title: params.title || 'Browser Session',
        status: 'running',
        mode: 'readonly',
        driver: this.driver.name,
        externalSessionId: driverSession.externalSessionId,
        liveUrl: driverSession.liveUrl || null,
        currentUrl: params.startUrl || null,
        profileId: profileId || null,
        ownerId: params.ownerId,
        conversationId: params.conversationId || null,
        startedAt: new Date(),
        expiresAt,
        metadata: {
          ...params.metadata,
          driver: {
            debugUrl: driverSession.debugUrl || null,
            browserWSEndpoint: (driverSession as any).browserWSEndpoint || driverSession.debugUrl || null,
            targetId: (driverSession as any).targetId || null,
            browserId: (driverSession as any).browserId || null,
          },
          policy: mergedPolicy,
        },
      },
    });

    const sessionId = session.get('id');
    (this as any).app.logger.info(`[ai-browser] Session created: ${sessionId} (external: ${driverSession.externalSessionId})`);

    // Mark initial activity so idle timer starts from creation
    this.touchSession(sessionId);

    // Schedule hard max-duration expiry as a safety net
    this.scheduleExpiry(sessionId, maxDuration * 1000);

    return session;
  }

  /**
   * Stop a session.
   */
  async stopSession(sessionId: string, userId?: number): Promise<void> {
    const repo = (this as any).app.db.getRepository('aiBrowserSessions');
    const session = await repo.findById(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const externalId = session.get('externalSessionId');
    if (externalId) {
      await this.driver.stopSession(externalId).catch((e) => {
        (this as any).app.logger.warn(`[ai-browser] Failed to stop external session ${externalId}: ${e.message}`);
      });
    }

    await repo.update({
      filterByTk: sessionId,
      values: {
        status: 'stopped',
        endedAt: new Date(),
      },
    });

    this.lastActivityMap.delete(sessionId);
    (this as any).app.logger.info(`[ai-browser] Session stopped: ${sessionId}`);
  }

  /**
   * Get session details.
   */
  async getSession(sessionId: string): Promise<any> {
    const repo = (this as any).app.db.getRepository('aiBrowserSessions');
    return repo.findOne({
      filterByTk: sessionId,
      appends: ['tasks', 'profile'],
    });
  }

  /**
   * Get the active session for a specific conversation.
   */
  async getActiveSessionForConversation(conversationId: string): Promise<any> {
    const repo = (this as any).app.db.getRepository('aiBrowserSessions');
    return repo.findOne({
      filter: {
        conversationId,
        status: 'running',
      },
      sort: ['-createdAt'],
    });
  }

  /**
   * List sessions with optional filters.
   */
  async listSessions(filters?: {
    ownerId?: number;
    status?: string;
    limit?: number;
  }): Promise<any[]> {
    const repo = (this as any).app.db.getRepository('aiBrowserSessions');
    const where: any = {};
    if (filters?.ownerId) where.ownerId = filters.ownerId;
    if (filters?.status) where.status = filters.status;

    return repo.find({
      filter: where,
      sort: ['-createdAt'],
      limit: filters?.limit || 20,
    });
  }

  /**
   * Mark a session as expired.
   */
  async expireSession(sessionId: string): Promise<void> {
    const repo = (this as any).app.db.getRepository('aiBrowserSessions');
    const session = await repo.findById(sessionId);
    if (!session) return;
    if (['completed', 'failed', 'stopped', 'expired'].includes(session.get('status'))) return;

    const externalId = session.get('externalSessionId');
    if (externalId) {
      await this.driver.stopSession(externalId).catch(() => {});
    }

    await repo.update({
      filterByTk: sessionId,
      values: {
        status: 'expired',
        endedAt: new Date(),
      },
    });

    this.lastActivityMap.delete(sessionId);
    (this as any).app.logger.info(`[ai-browser] Session expired: ${sessionId}`);
  }

  /**
   * Update session's current URL.
   */
  async updateCurrentUrl(sessionId: string, url: string): Promise<void> {
    const repo = (this as any).app.db.getRepository('aiBrowserSessions');
    await repo.update({
      filterByTk: sessionId,
      values: { currentUrl: url },
    });
  }

  private scheduleExpiry(sessionId: string, delayMs: number) {
    setTimeout(() => {
      this.expireSession(sessionId).catch((e) => {
        (this as any).app.logger.error(`[ai-browser] Expiry error for session ${sessionId}: ${e.message}`);
      });
    }, delayMs);
  }

  private async getDefaultPolicy(): Promise<BrowserPolicy> {
    try {
      const configRepo = (this as any).app.db.getRepository('aiBrowserConfig');
      const row = await configRepo.findOne({ filter: { key: 'defaultPolicy' } });
      if (row) {
        return JSON.parse(row.get('value') as string);
      }
    } catch {}
    return {
      allowedDomains: [],
      deniedDomains: [],
      maxDurationSeconds: Number(process.env.AI_BROWSER_SESSION_TTL_SECONDS || 1800),
      idleTimeoutSeconds: Number(process.env.AI_BROWSER_IDLE_TIMEOUT_SECONDS || 120),
      maxTabs: 3,
      allowDownloads: false,
      allowFormSubmit: true,
      allowLogin: false,
      allowDestructiveActions: false,
    };
  }
}
