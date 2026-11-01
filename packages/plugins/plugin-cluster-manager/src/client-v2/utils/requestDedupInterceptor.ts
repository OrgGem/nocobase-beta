/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { APIClient } from '@nocobase/client-v2';
import type { AxiosResponse } from 'axios';

const CLIENT_CACHE_TTL_MS = 60 * 1000;
const CACHE_KEY_PREFIX = 'nb_cache';

const wrappedClients = new WeakSet<APIClient>();
const clientScopes = new WeakMap<APIClient, { id: number; token: unknown; role: unknown; generation: number }>();
let nextClientId = 0;
const cacheSessionId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

interface RequestConfig {
  url?: string;
  method?: string;
  resource?: string;
  resourceOf?: unknown;
  action?: string;
  params?: unknown;
  data?: unknown;
  headers?: unknown;
  baseURL?: string;
  signal?: unknown;
}

interface CacheScope {
  prefix: string;
}

interface CacheEntry {
  expiresAt: number;
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
    let computedUrl = cfg.resource.split('.').join(of != null ? `/${encodeURIComponent(String(of))}/` : '/');
    computedUrl += `:${cfg.action}`;
    url = computedUrl;
    method = ['get', 'list', 'listMeta', 'getJsonSchema'].includes(cfg.action) ? 'get' : 'post';
  }

  return { url, method, params };
}

function stringifyParams(params: unknown) {
  try {
    return JSON.stringify(params || {}, (_key, value: unknown) => {
      if (['function', 'symbol', 'bigint'].includes(typeof value)) throw new Error('Unsupported cache key');
      return value;
    });
  } catch {
    return undefined;
  }
}

function isCacheableSchemaRequest(url: string) {
  return /(?:^|\/)(?:collections:listMeta|uiSchemas:getJsonSchema)(?:\?|$)/.test(url);
}

function getCacheScope(apiClient: APIClient): CacheScope {
  const appName = apiClient.app?.getName?.() || 'main';
  const role = apiClient.auth?.role || 'anonymous';
  const token = apiClient.auth?.token || 'anonymous';
  let state = clientScopes.get(apiClient);
  if (!state) {
    state = { id: ++nextClientId, token, role, generation: 0 };
    clientScopes.set(apiClient, state);
  } else if (state.token !== token || state.role !== role) {
    state.token = token;
    state.role = role;
    state.generation += 1;
  }
  // Credentials stay in memory; each client and auth generation owns a separate namespace.
  const scope = `${appName}:${cacheSessionId}:client-${state.id}:${state.generation}`;

  return {
    prefix: `${CACHE_KEY_PREFIX}:${scope}:`,
  };
}

export function invalidateClientMetadata(apiClient: APIClient) {
  const state = clientScopes.get(apiClient);
  if (state) state.generation += 1;
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

  const originalRequest: APIClient['request'] = apiClient.request.bind(apiClient);
  const pendingRequests = new Map<string, Promise<unknown>>();
  const responseCache = new Map<string, CacheEntry>();

  apiClient.request = async <T = unknown, R = AxiosResponse<T>, D = unknown>(
    config: Parameters<APIClient['request']>[0],
  ): Promise<R> => {
    const { url, method, params } = getRequestInfo(config as string | RequestConfig);

    if (method !== 'get') {
      const response = await originalRequest<T, R, D>(config);
      if (isSuccessfulResponse(response)) {
        invalidateClientMetadata(apiClient);
      }
      return response;
    }

    // Only cache/deduplicate listMeta and uiSchemas to avoid altering standard operations
    const requestConfig = typeof config === 'object' && config ? (config as RequestConfig) : undefined;
    // A caller-owned cancellation signal must never cancel another caller's request.
    if (
      !url ||
      !isCacheableSchemaRequest(url) ||
      requestConfig?.signal ||
      (requestConfig &&
        Object.keys(requestConfig).some(
          (key) => !['url', 'method', 'resource', 'resourceOf', 'action', 'params', 'headers', 'baseURL'].includes(key),
        ))
    ) {
      return originalRequest<T, R, D>(config);
    }

    const scope = getCacheScope(apiClient);
    const paramsKey = stringifyParams({ params, headers: requestConfig?.headers, baseURL: requestConfig?.baseURL });
    if (paramsKey === undefined) return originalRequest<T, R, D>(config);

    const cacheKey = `${scope.prefix}${url}:${paramsKey}`;

    const cached = responseCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.response as R;
    responseCache.delete(cacheKey);

    const dedupKey = `${scope.prefix}${url}:${paramsKey}`;
    if (pendingRequests.has(dedupKey)) {
      return pendingRequests.get(dedupKey) as Promise<R>;
    }

    const promise = originalRequest<T, R, D>(config).then(
      (response) => {
        pendingRequests.delete(dedupKey);

        // 3. Cache successful responses
        if (
          response &&
          typeof response === 'object' &&
          'status' in response &&
          response.status === 200 &&
          'data' in response &&
          response.data
        ) {
          try {
            const entry: CacheEntry = {
              expiresAt: Date.now() + CLIENT_CACHE_TTL_MS,
              response,
            };
            // Axios config can contain credentials; keep complete responses in memory only.
            if (responseCache.size >= 128) responseCache.clear();
            if (getCacheScope(apiClient).prefix === scope.prefix) responseCache.set(cacheKey, entry);
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
