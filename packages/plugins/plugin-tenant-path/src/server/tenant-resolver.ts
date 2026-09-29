import type { Database } from '@nocobase/database';

export interface TenantRecord {
  id: number;
  pathPrefix: string;
  appName: string;
}

interface RequestLike {
  url?: string;
}

function normalizePublicPath(appPublicPath = '/'): string {
  const normalized = String(appPublicPath || '/').trim() || '/';
  const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`;
}

function firstSegmentAfterPublicPath(pathname: string): string | null {
  const publicPath = normalizePublicPath(process.env.APP_PUBLIC_PATH || '/');
  const rest = publicPath !== '/' && pathname.startsWith(publicPath) ? pathname.slice(publicPath.length) : pathname;
  const [segment] = rest.split('/').filter(Boolean);
  return segment || null;
}

// Maps a request URL segment to a tenant (its pathPrefix and target app). Cached in memory and lazily reloaded;
// the plugin invalidates the cache on tenant add/edit/delete so route changes take effect without a restart.
export class TenantResolver {
  private readonly db: Database;
  private cache = new Map<string, TenantRecord>();
  private loaded = false;
  private loadingPromise: Promise<void> | null = null;

  constructor(db: Database) {
    this.db = db;
  }

  invalidate() {
    this.loaded = false;
    this.loadingPromise = null;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    if (this.loadingPromise) {
      await this.loadingPromise;
      return;
    }
    this.loadingPromise = (async () => {
      const repository = this.db.getRepository('tenants');
      if (!repository) {
        return;
      }
      const rows = await repository.find({ filter: { enabled: true } });
      const next = new Map<string, TenantRecord>();
      for (const row of rows) {
        const pathPrefix = String(row.get('pathPrefix') || '')
          .trim()
          .toLowerCase();
        if (!pathPrefix) {
          continue;
        }
        const appName = String(row.get('appName') || '').trim() || pathPrefix;
        next.set(pathPrefix, { id: Number(row.get('id')), pathPrefix, appName });
      }
      this.cache = next;
      this.loaded = true;
    })();
    try {
      await this.loadingPromise;
    } finally {
      this.loadingPromise = null;
    }
  }

  async resolveFromPath(pathname: string): Promise<TenantRecord | null> {
    await this.ensureLoaded();
    const segment = firstSegmentAfterPublicPath(pathname);
    if (!segment) {
      return null;
    }
    return this.cache.get(segment.toLowerCase()) ?? null;
  }

  private pathnameFromUrl(req: RequestLike): string {
    const url = req.url || '';
    return url.split('?')[0];
  }

  // Returns the matched tenant's URL segment so the gateway can serve `/<tenant>/...`; null lets the
  // gateway fall back to the process-wide APP_MODERN_CLIENT_PREFIX (backward compatible single-prefix).
  async resolvePrefix(req: RequestLike): Promise<string | null> {
    const tenant = await this.resolveFromPath(this.pathnameFromUrl(req));
    return tenant ? tenant.pathPrefix : null;
  }

  async resolveAppName(req: RequestLike): Promise<string | null> {
    const tenant = await this.resolveFromPath(this.pathnameFromUrl(req));
    return tenant ? tenant.appName : null;
  }
}
