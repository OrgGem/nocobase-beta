import { APIClient } from '@nocobase/client';

const CLIENT_CACHE_TTL_MS = 60 * 1000;
const CACHE_KEY_PREFIX = 'nb_cache';
const CACHE_VERSION_PREFIX = 'nb_cache_version';

const pendingRequests = new Map<string, Promise<unknown>>();
const wrappedClients = new WeakSet<APIClient>();

interface RequestConfig {
  url?: string;
  method?: string;
  resource?: string;
  resourceOf?: unknown;
  action?: string;
  params?: unknown;
  data?: unknown;
}

interface CacheScope {
  prefix: string;
  versionKey: string;
}

interface CacheEntry {
  expiresAt: number;
  scopeVersion: number;
  response: unknown;
}

function getRequestInfo(config: string | RequestConfig) {
  if (typeof config === 'string') {
    return {
      url: config,
      method: 'get',
      params: {},
    };
  }

  const cfg = config as RequestConfig;
  let url = cfg.url || '';
  let method = (cfg.method || 'get').toLowerCase();
  const params = cfg.params || {};

  if (cfg.resource && cfg.action) {
    const of = cfg.resourceOf;
    let computedUrl = cfg.resource.split('.').join(of ? `/${encodeURIComponent(String(of))}/` : '/');
    computedUrl += `:${cfg.action}`;
    url = computedUrl;
    method = ['get', 'list', 'listMeta', 'getJsonSchema'].includes(cfg.action) ? 'get' : 'post';
  }

  return { url, method, params };
}

function getStorage() {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function stringifyParams(params: unknown) {
  try {
    return JSON.stringify(params || {});
  } catch {
    return '[unserializable]';
  }
}

function isCacheableSchemaRequest(url: string) {
  return url.includes('collections:listMeta') || url.includes('uiSchemas:getJsonSchema');
}

function getCacheScope(apiClient: APIClient): CacheScope {
  const appName = apiClient.app?.getName() || 'main';
  const role = apiClient.auth?.role || 'anonymous';
  const token = apiClient.auth?.token || 'anonymous';
  const safeToken = typeof token === 'string' ? token.slice(-8) : 'anonymous';
  const scope = `${appName}:${safeToken}:${role}`;

  return {
    prefix: `${CACHE_KEY_PREFIX}:${scope}:`,
    versionKey: `${CACHE_VERSION_PREFIX}:${scope}`,
  };
}

function getScopeVersion(storage: Storage, scope: CacheScope) {
  try {
    const raw = storage.getItem(scope.versionKey);
    const version = raw ? Number(raw) : 0;
    return Number.isFinite(version) ? version : 0;
  } catch {
    return 0;
  }
}

function clearByPrefix(storage: Storage, prefix: string) {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(prefix)) {
      keys.push(key);
    }
  }

  for (const key of keys) {
    storage.removeItem(key);
  }
}

function bumpScopeVersion(apiClient: APIClient) {
  const storage = getStorage();
  if (!storage) return;

  try {
    const scope = getCacheScope(apiClient);
    const nextVersion = getScopeVersion(storage, scope) + 1;
    storage.setItem(scope.versionKey, String(nextVersion));
    clearByPrefix(storage, scope.prefix);
  } catch {
    // Ignore storage failures; the network response remains authoritative.
  }
}

function isSuccessfulResponse(response: unknown) {
  const status =
    response && typeof response === 'object' && 'status' in response
      ? (response as { status?: unknown }).status
      : undefined;
  return typeof status !== 'number' || (status >= 200 && status < 400);
}

export function setupRequestDedupAndCache(apiClient: APIClient) {
  if (!apiClient) return;
  if (wrappedClients.has(apiClient)) return;
  wrappedClients.add(apiClient);

  const originalRequest = apiClient.request.bind(apiClient);

  apiClient.request = async (config) => {
    const { url, method, params } = getRequestInfo(config as string | RequestConfig);

    if (method !== 'get') {
      const response = await originalRequest(config);
      if (isSuccessfulResponse(response)) {
        bumpScopeVersion(apiClient);
      }
      return response;
    }

    // Only cache/deduplicate listMeta and uiSchemas to avoid altering standard operations
    if (!url || !isCacheableSchemaRequest(url)) {
      return originalRequest(config);
    }

    const storage = getStorage();
    const scope = getCacheScope(apiClient);
    const scopeVersion = storage ? getScopeVersion(storage, scope) : 0;
    const paramsKey = stringifyParams(params);

    const cacheKey = `${scope.prefix}v${scopeVersion}:${url}:${paramsKey}`;

    if (storage) {
      try {
        const cached = storage.getItem(cacheKey);
        if (cached) {
          const entry = JSON.parse(cached) as CacheEntry;
          if (entry.expiresAt > Date.now() && entry.scopeVersion === scopeVersion) {
            return entry.response;
          }
          storage.removeItem(cacheKey);
        }
      } catch {
        // Fallback to the network on sessionStorage or JSON failures.
      }
    }

    const dedupKey = `${scope.prefix}v${scopeVersion}:${url}:${paramsKey}`;
    if (pendingRequests.has(dedupKey)) {
      return pendingRequests.get(dedupKey);
    }

    const promise = originalRequest(config).then(
      (response) => {
        pendingRequests.delete(dedupKey);

        // 3. Cache successful responses
        if (storage && response && response.status === 200 && response.data) {
          try {
            const entry: CacheEntry = {
              expiresAt: Date.now() + CLIENT_CACHE_TTL_MS,
              scopeVersion,
              response,
            };
            storage.setItem(cacheKey, JSON.stringify(entry));
          } catch {
            // Ignore quota errors
          }
        }
        return response;
      },
      (error) => {
        pendingRequests.delete(dedupKey);
        throw error;
      },
    );

    pendingRequests.set(dedupKey, promise);
    return promise;
  };
}
