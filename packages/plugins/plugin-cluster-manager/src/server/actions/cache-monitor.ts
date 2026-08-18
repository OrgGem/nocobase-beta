import { Context } from '@nocobase/actions';
import { getRedis } from '../utils/redis';
import { promises as fsp } from 'fs';
import path from 'path';
import { exec } from 'child_process';
import http from 'http';
import https from 'https';
import dns from 'dns';
import net from 'net';

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Allowlist check: the target must be (or live under) a cache path that was
 * detected in the nginx configuration. A denylist of "dangerous" paths is
 * bypassable (e.g. /var/www/html slipped past the old /var$ pattern), so we
 * fail closed instead.
 */
function isAllowedCachePath(dirPath: string, allowedPaths: string[]): boolean {
  if (!dirPath || allowedPaths.length === 0) return false;
  const resolved = path.resolve(dirPath);
  return allowedPaths.some((allowed) => {
    const allowedResolved = path.resolve(allowed);
    return resolved === allowedResolved || resolved.startsWith(allowedResolved + path.sep);
  });
}

async function findNginxConfig(): Promise<string | null> {
  const nginxConfPath = await new Promise<string | null>((resolve) => {
    exec('nginx -V', (err, stdout, stderr) => {
      if (err) return resolve(null);
      const output = stdout + stderr;
      const match = output.match(/--conf-path=([^\s]+)/);
      if (match && match[1]) {
        resolve(match[1]);
      } else {
        resolve(null);
      }
    });
  });
  if (nginxConfPath && (await exists(nginxConfPath))) {
    return nginxConfPath;
  }

  const searchPaths = [
    '/etc/nginx/nginx.conf',
    '/usr/local/nginx/conf/nginx.conf',
    '/usr/local/etc/nginx/nginx.conf',
    '/opt/homebrew/etc/nginx/nginx.conf',
    'C:\\nginx\\conf\\nginx.conf',
  ];
  for (const p of searchPaths) {
    if (await exists(p)) {
      return p;
    }
  }
  return null;
}

async function readConfigRecursive(configPath: string, visited: Set<string> = new Set()): Promise<string> {
  const resolvedPath = path.resolve(configPath);
  if (visited.has(resolvedPath)) return '';
  visited.add(resolvedPath);

  try {
    const content = await fsp.readFile(resolvedPath, 'utf8');
    const lines = content.split(/\r?\n/);
    let fullText = content + '\n';

    const configDir = path.dirname(resolvedPath);

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) continue;

      const includeMatch = trimmed.match(/^include\s+([^\s;]+)/);
      if (includeMatch && includeMatch[1]) {
        let includePattern = includeMatch[1].trim().replace(/^["']|["']$/g, '');

        if (!path.isAbsolute(includePattern)) {
          includePattern = path.join(configDir, includePattern);
        }

        if (includePattern.includes('*')) {
          try {
            const patternDir = path.dirname(includePattern);
            const ext = path.extname(includePattern);
            if (await exists(patternDir)) {
              const files = await fsp.readdir(patternDir);
              for (const file of files) {
                if (file.endsWith(ext) || includePattern.endsWith('*')) {
                  const filePath = path.join(patternDir, file);
                  fullText += (await readConfigRecursive(filePath, visited)) + '\n';
                }
              }
            }
          } catch {
            // Ignore include directory read failures
          }
        } else {
          if (await exists(includePattern)) {
            fullText += (await readConfigRecursive(includePattern, visited)) + '\n';
          }
        }
      }
    }
    return fullText;
  } catch {
    return '';
  }
}

function extractCachePaths(configText: string): string[] {
  const paths: string[] = [];
  const lines = configText.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^(?:proxy|fastcgi|scgi|uwsgi)_cache_path\s+([^\s;]+)/);
    if (match && match[1]) {
      const p = match[1].trim();
      const cleanPath = p.replace(/^["']|["']$/g, '');
      if (cleanPath && !paths.includes(cleanPath)) {
        paths.push(cleanPath);
      }
    }
  }
  return paths;
}

async function emptyDirectory(
  dirPath: string,
  allowedPaths: string[],
): Promise<{ success: boolean; clearedCount: number; error?: string }> {
  if (!isAllowedCachePath(dirPath, allowedPaths)) {
    return { success: false, clearedCount: 0, error: 'Directory is not a detected nginx cache path' };
  }

  try {
    if (!(await exists(dirPath))) {
      return { success: false, clearedCount: 0, error: 'Directory does not exist' };
    }

    const stats = await fsp.stat(dirPath);
    if (!stats.isDirectory()) {
      return { success: false, clearedCount: 0, error: 'Path is not a directory' };
    }

    const files = await fsp.readdir(dirPath);
    let clearedCount = 0;
    for (const file of files) {
      const fullPath = path.join(dirPath, file);
      await fsp.rm(fullPath, { recursive: true, force: true });
      clearedCount++;
    }

    return { success: true, clearedCount };
  } catch (err: any) {
    return { success: false, clearedCount: 0, error: err.message };
  }
}

async function detectNginxCachePaths(): Promise<{
  nginxInstalled: boolean;
  mainConfigPath: string | null;
  detectedPaths: string[];
}> {
  let nginxInstalled = false;
  let mainConfigPath: string | null = null;
  let detectedPaths: string[] = [];

  try {
    // 1. Try running "nginx -T" to get fully resolved configuration
    const configText = await new Promise<string | null>((resolve) => {
      exec('nginx -T', { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
        if (err) {
          resolve(null);
        } else {
          nginxInstalled = true;
          resolve(stdout);
        }
      });
    });

    if (configText) {
      detectedPaths = extractCachePaths(configText);
      mainConfigPath = await findNginxConfig();
    } else {
      // Fallback: search main config and manually trace includes
      mainConfigPath = await findNginxConfig();
      if (mainConfigPath) {
        nginxInstalled = true;
        detectedPaths = extractCachePaths(await readConfigRecursive(mainConfigPath));
      }
    }
  } catch {
    // Detection failed — report nothing and let callers fail closed
  }

  return { nginxInstalled, mainConfigPath, detectedPaths };
}

const ALLOWED_PURGE_METHODS = new Set(['PURGE', 'GET', 'HEAD']);
const BLOCKED_METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata.goog']);

function isBlockedAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    // The link-local range holds the cloud metadata endpoint (169.254.169.254).
    return address.startsWith('169.254.');
  }
  const lower = address.toLowerCase();
  // fe80::/10 is IPv6 link-local; the other forms are IPv4-mapped 169.254.x.x.
  return lower.startsWith('fe80') || lower.includes('ffff:a9fe') || lower.includes('ffff:169.254');
}

/**
 * DNS lookup hook that rejects link-local/metadata addresses. Runs at connect
 * time on the actually-resolved addresses, so it cannot be bypassed by DNS
 * rebinding or multi-A-record responses. Private ranges (nginx legitimately
 * runs on RFC1918/loopback) remain allowed.
 */
const safeLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err || !addresses || addresses.length === 0) {
      callback(err || new Error(`DNS lookup failed for ${hostname}`), []);
      return;
    }
    for (const entry of addresses) {
      if (isBlockedAddress(entry.address)) {
        callback(new Error(`Blocked request to reserved address ${entry.address}`), []);
        return;
      }
    }
    callback(null, addresses);
  });
};

function makePurgeRequest(
  urlStr: string,
  method = 'PURGE',
  headers: Record<string, string> = {},
): Promise<{ success: boolean; status?: number; data?: string; error?: string }> {
  return new Promise((resolve) => {
    try {
      const url = new URL(urlStr);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        resolve({ success: false, error: 'Only http and https URLs are allowed' });
        return;
      }
      const normalizedMethod = String(method || 'PURGE').toUpperCase();
      if (!ALLOWED_PURGE_METHODS.has(normalizedMethod)) {
        resolve({ success: false, error: `HTTP method ${method} is not allowed (use PURGE, GET or HEAD)` });
        return;
      }
      // IP literals bypass the lookup hook, so check them here as well.
      const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      if (BLOCKED_METADATA_HOSTS.has(hostname) || (net.isIP(hostname) !== 0 && isBlockedAddress(hostname))) {
        resolve({ success: false, error: 'Requests to cloud metadata endpoints are blocked' });
        return;
      }

      const isHttps = url.protocol === 'https:';
      const client = isHttps ? https : http;

      const reqHeaders = { ...headers };

      const req = client.request(
        urlStr,
        {
          method: normalizedMethod,
          headers: reqHeaders,
          timeout: 10000,
          lookup: safeLookup,
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => {
            resolve({
              success: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
              status: res.statusCode,
              data: body,
            });
          });
        },
      );

      req.on('error', (err) => {
        resolve({
          success: false,
          error: err.message,
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({
          success: false,
          error: 'Request timed out after 10 seconds',
        });
      });

      req.end();
    } catch (err: any) {
      resolve({
        success: false,
        error: err.message,
      });
    }
  });
}

export const cacheMonitorActions = {
  /**
   * GET /clusterManagerCacheMgr:stores
   * List all registered cache stores and their config
   */
  async stores(ctx: Context, next: () => Promise<void>) {
    const cm = ctx.app.cacheManager;
    if (!cm) {
      ctx.throw(503, 'Cache manager is not available');
    }

    const stores: any[] = [];

    // storeTypes is a Map of registered store type configs
    const storeTypes = (cm as any).storeTypes as Map<string, any>;
    if (storeTypes) {
      for (const [name, config] of storeTypes.entries()) {
        const storeType = config.store === 'memory' ? 'memory' : 'redis';
        stores.push({
          name,
          type: storeType,
          isDefault: name === cm.defaultStore,
        });
      }
    }

    ctx.body = { data: stores, meta: { count: stores.length, defaultStore: cm.defaultStore } };
    await next();
  },

  /**
   * GET /clusterManagerCacheMgr:caches
   * List all created named caches
   */
  async caches(ctx: Context, next: () => Promise<void>) {
    const cm = ctx.app.cacheManager;
    if (!cm) {
      ctx.throw(503, 'Cache manager is not available');
    }

    const caches: any[] = [];
    const cacheMap = (cm as any).caches as Map<string, any>;
    if (cacheMap) {
      for (const [name, cache] of cacheMap.entries()) {
        caches.push({
          name,
          prefix: (cache as any).prefix || null,
        });
      }
    }

    ctx.body = { data: caches, meta: { count: caches.length } };
    await next();
  },

  /**
   * GET /clusterManagerCacheMgr:redisMemory
   * Get Redis memory usage for cache keys
   */
  async redisMemory(ctx: Context, next: () => Promise<void>) {
    const redis = getRedis(ctx);
    if (!redis) {
      ctx.body = { available: false };
      await next();
      return;
    }

    try {
      const info = await redis.sendCommand(['INFO', 'memory']);
      const lines = String(info).split(/\r?\n/);
      const memInfo: Record<string, string> = {};
      for (const line of lines) {
        const idx = line.indexOf(':');
        if (idx > 0) {
          memInfo[line.slice(0, idx)] = line.slice(idx + 1).trim();
        }
      }

      // Count keys by prefix pattern
      const dbSize = await redis.sendCommand(['DBSIZE']);

      ctx.body = {
        available: true,
        usedMemory: memInfo.used_memory_human,
        usedMemoryBytes: Number(memInfo.used_memory || 0),
        totalKeys: Number(dbSize) || 0,
      };
    } catch (e: any) {
      ctx.body = { available: false, error: e.message };
    }
    await next();
  },

  /**
   * POST /clusterManagerCacheMgr:flushAll
   * Flush all caches via CacheManager
   */
  async flushAll(ctx: Context, next: () => Promise<void>) {
    const cm = ctx.app.cacheManager;
    if (!cm) {
      ctx.throw(503, 'Cache manager is not available');
    }

    const user = ctx.state?.currentUser?.nickname || ctx.state?.currentUser?.id || 'unknown';
    ctx.app.logger.warn(`[cluster-manager] Flushing all caches by user ${user}`);

    await cm.flushAll();

    ctx.body = { success: true };
    await next();
  },

  /**
   * GET /clusterManagerCacheMgr:nginxCacheStatus
   * Detect if Nginx is installed, locate conf, and auto-load cache paths
   */
  async nginxCacheStatus(ctx: Context, next: () => Promise<void>) {
    const { nginxInstalled, mainConfigPath, detectedPaths } = await detectNginxCachePaths();

    ctx.body = {
      nginxInstalled,
      mainConfigPath,
      detectedPaths,
    };
    await next();
  },

  /**
   * POST /clusterManagerCacheMgr:clearNginxCache
   * Clear physical cache files or send an HTTP Purge request
   */
  async clearNginxCache(ctx: Context, next: () => Promise<void>) {
    const { method = 'directory', directory, url, httpMethod = 'PURGE', headers = {} } = ctx.action.params.values || {};

    if (method === 'directory') {
      if (!directory) {
        ctx.throw(400, 'Directory path is required for physical cache clearing');
      }

      // Only directories detected in the nginx config may be emptied (fail closed).
      const { detectedPaths } = await detectNginxCachePaths();
      const result = await emptyDirectory(directory, detectedPaths);
      if (!result.success) {
        ctx.throw(400, result.error || 'Failed to clear cache directory');
      }

      ctx.body = {
        success: true,
        message: `Successfully cleared physical cache directory`,
        clearedCount: result.clearedCount,
      };
    } else if (method === 'purgeRequest') {
      if (!url) {
        ctx.throw(400, 'Purge URL is required for HTTP Purge request method');
      }

      const result = await makePurgeRequest(url, httpMethod, headers);
      if (!result.success) {
        ctx.throw(400, result.error || `HTTP Purge request failed with status: ${result.status}`);
      }

      ctx.body = {
        success: true,
        message: `HTTP Purge request sent successfully`,
        status: result.status,
        data: result.data,
      };
    } else {
      ctx.throw(400, `Unknown clearing method: ${method}`);
    }

    await next();
  },
};
