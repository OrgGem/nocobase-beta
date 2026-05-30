import { APIClient } from '@nocobase/client';

const pendingRequests = new Map<string, Promise<any>>();

interface RequestConfig {
  url?: string;
  method?: string;
  resource?: string;
  resourceOf?: any;
  action?: string;
  params?: any;
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
    let computedUrl = cfg.resource.split('.').join(of ? `/${encodeURIComponent(of)}/` : '/');
    computedUrl += `:${cfg.action}`;
    url = computedUrl;
    method = ['get', 'list'].includes(cfg.action) ? 'get' : 'post';
  }

  return { url, method, params };
}

export function setupRequestDedupAndCache(apiClient: APIClient) {
  if (!apiClient) return;

  const originalRequest = apiClient.request.bind(apiClient);

  apiClient.request = async (config) => {
    const { url, method, params } = getRequestInfo(config as any);

    // Only intercept GET requests
    if (method !== 'get') {
      return originalRequest(config);
    }

    // Only cache/deduplicate listMeta and uiSchemas to avoid altering standard operations
    if (!url || (!url.includes('collections:listMeta') && !url.includes('uiSchemas:getJsonSchema'))) {
      return originalRequest(config);
    }

    const appName = apiClient.app?.getName() || 'main';
    const role = apiClient.auth?.role || 'anonymous';
    const token = apiClient.auth?.token || 'anonymous';

    // 1. Try reading from Session Storage Cache first
    const safeToken = typeof token === 'string' ? token.slice(-8) : 'anonymous';
    const cacheKey = `nb_cache:${appName}:${safeToken}:${role}:${url}:${JSON.stringify(params)}`;

    try {
      const cached = sessionStorage.getItem(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch {
      // Fallback on sessionStorage failures
    }

    // 2. In-flight Request Deduplication
    const dedupKey = `${appName}:${role}:${url}:${JSON.stringify(params)}`;
    if (pendingRequests.has(dedupKey)) {
      return pendingRequests.get(dedupKey);
    }

    const promise = originalRequest(config).then(
      (response) => {
        pendingRequests.delete(dedupKey);

        // 3. Cache successful responses
        if (response && response.status === 200 && response.data) {
          try {
            sessionStorage.setItem(cacheKey, JSON.stringify(response));
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
