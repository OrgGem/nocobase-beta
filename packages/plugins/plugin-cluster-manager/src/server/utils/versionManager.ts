import { getRedisClient } from './redis';

const localCounters = new Map<string, number>();

async function getVersion(app: any, key: string): Promise<number> {
  const redis = getRedisClient(app);
  if (redis) {
    try {
      const val = await redis.sendCommand(['GET', key]);
      return val ? parseInt(val, 10) : 1;
    } catch {
      // Fallback to local
    }
  }
  return localCounters.get(key) || 1;
}

async function incrementVersion(app: any, key: string): Promise<number> {
  const redis = getRedisClient(app);
  if (redis) {
    try {
      const val = await redis.sendCommand(['INCR', key]);
      return parseInt(val, 10);
    } catch {
      // Fallback to local
    }
  }
  const next = (localCounters.get(key) || 1) + 1;
  localCounters.set(key, next);
  return next;
}

export const cacheVersionManager = {
  async getCollectionVersion(app: any): Promise<number> {
    return getVersion(app, 'nocobase:version:collections');
  },

  async incrementCollectionVersion(app: any): Promise<number> {
    app.logger.info('[ClusterManager] Incrementing collections cache version due to schema change');
    return incrementVersion(app, 'nocobase:version:collections');
  },

  async getSchemaVersion(app: any): Promise<number> {
    return getVersion(app, 'nocobase:version:schemas');
  },

  async incrementSchemaVersion(app: any): Promise<number> {
    app.logger.info('[ClusterManager] Incrementing uiSchemas cache version due to UI change');
    return incrementVersion(app, 'nocobase:version:schemas');
  },

  async getAclVersion(app: any, roleName: string): Promise<number> {
    return getVersion(app, `nocobase:version:acl:role:${roleName}`);
  },

  async incrementAclVersion(app: any, roleName: string): Promise<number> {
    app.logger.info(`[ClusterManager] Incrementing ACL cache version for role: ${roleName}`);
    return incrementVersion(app, `nocobase:version:acl:role:${roleName}`);
  },

  async incrementAllAclVersions(app: any): Promise<number> {
    app.logger.info('[ClusterManager] Incrementing global ACL cache version');
    return incrementVersion(app, 'nocobase:version:acl:global');
  },

  async getGlobalAclVersion(app: any): Promise<number> {
    return getVersion(app, 'nocobase:version:acl:global');
  },
};
