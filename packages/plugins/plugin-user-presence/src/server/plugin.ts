import { Plugin } from '@nocobase/server';

/**
 * PluginUserPresenceServer — Tracks user online status via WS heartbeats.
 *
 * Uses NocoBase CacheManager for fast presence lookups and broadcasts
 * status changes to relevant channels.
 */
export class PluginUserPresenceServer extends Plugin {
  private presenceMap: Map<string, { userId: string; lastSeen: number; clientId: string }> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;

  async load() {
    const PRESENCE_TIMEOUT = 60000; // 60s without heartbeat = offline

    // Listen for presence heartbeats from comm-core WS handler
    this.app.on('comm:presence:heartbeat', async ({ clientId, userId }) => {
      const previous = this.presenceMap.get(userId);
      const wasOffline = !previous || (Date.now() - previous.lastSeen > PRESENCE_TIMEOUT);

      this.presenceMap.set(userId, {
        userId,
        lastSeen: Date.now(),
        clientId,
      });

      // If user just came online, broadcast
      if (wasOffline) {
        await this.broadcastStatusChange(userId, 'online');
        await this.updateDbStatus(userId, 'online');
      }
    });

    // Register API to get online users
    this.app.resourceManager.registerActionHandler('commUserStatus:onlineUsers', async (ctx, next) => {
      const now = Date.now();
      const onlineUserIds: string[] = [];

      this.presenceMap.forEach((entry, uId) => {
        if (now - entry.lastSeen < PRESENCE_TIMEOUT) {
          onlineUserIds.push(uId);
        }
      });

      ctx.body = onlineUserIds;
      await next();
    });

    this.app.acl.allow('commUserStatus', 'onlineUsers', 'loggedIn');

    // Periodic cleanup — mark stale users as offline
    this.cleanupInterval = setInterval(async () => {
      const now = Date.now();
      const offlineUsers: string[] = [];

      this.presenceMap.forEach((entry, uId) => {
        if (now - entry.lastSeen > PRESENCE_TIMEOUT) {
          offlineUsers.push(uId);
          this.presenceMap.delete(uId);
        }
      });

      for (const userId of offlineUsers) {
        await this.broadcastStatusChange(userId, 'offline');
        await this.updateDbStatus(userId, 'offline');
      }
    }, 30000); // check every 30s

    this.app.logger.info('[user-presence] Plugin loaded successfully');
  }

  private async broadcastStatusChange(userId: string, status: string) {
    this.app.emit('ws:sendToCurrentApp', {
      message: {
        type: 'comm:user:status',
        payload: { userId, status },
      },
    });
  }

  private async updateDbStatus(userId: string, status: string) {
    try {
      const repo = this.db.getRepository('commUserStatus');
      const existing = await repo.findOne({ filter: { userId } });

      if (existing) {
        await repo.update({
          filterByTk: existing.id,
          values: { status, lastSeenAt: new Date() },
        });
      } else {
        await repo.create({
          values: { userId, status, lastSeenAt: new Date() },
        });
      }
    } catch (err) {
      this.app.logger.error('[user-presence] DB update failed:', err);
    }
  }

  async remove() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

export default PluginUserPresenceServer;
