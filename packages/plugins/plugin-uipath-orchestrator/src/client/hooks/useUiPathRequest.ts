import { useApp } from '@nocobase/client-v2';
import { useCurrentInstance } from '../context/InstanceContext';
import { useState, useEffect, useCallback, useRef } from 'react';

type RequestParams = Record<string, unknown>;
type ErrorLike = {
  message?: string;
  response?: {
    data?: unknown;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function getErrorMessage(error: unknown): string {
  const err = error as ErrorLike;
  const responseData = err?.response?.data;

  if (isRecord(responseData)) {
    const errors = responseData.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      const message = errors
        .map((item) => (isRecord(item) && typeof item.message === 'string' ? item.message : null))
        .filter(Boolean)
        .join('\n');
      if (message) {
        return message;
      }
    }

    for (const key of ['message', 'error']) {
      const value = responseData[key];
      if (typeof value === 'string' && value) {
        return value;
      }
    }
  }

  return err?.message || 'UiPath request failed';
}

function normalizePayload(payload: unknown) {
  if (isRecord(payload)) {
    const errors = payload.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      throw new Error(getErrorMessage({ response: { data: payload } }));
    }

    if ('data' in payload) {
      return { data: payload.data, meta: payload };
    }

    if ('value' in payload) {
      return { data: payload.value, meta: payload };
    }
  }

  return { data: payload, meta: payload };
}

function stringifyParams(params: unknown): string {
  try {
    return JSON.stringify(params);
  } catch {
    return '';
  }
}

export function toUiPathArray<T = Record<string, unknown>>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * Hook for calling UiPath proxy resource actions.
 * Automatically injects instanceId, folderId, folderKey from context.
 */
export function useUiPathRequest(resource: string, action: string, extraParams: RequestParams = {}) {
  const api = useApp().apiClient;
  const { instanceId, folderId, folderKey } = useCurrentInstance();
  const [data, setData] = useState<unknown>(null);
  const [meta, setMeta] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const extraParamsRef = useRef(extraParams);
  extraParamsRef.current = extraParams;
  const abortRef = useRef<AbortController | null>(null);
  const seqRef = useRef(0);

  const run = useCallback(
    async (overrideParams: RequestParams = {}) => {
      if (!instanceId) {
        setData(null);
        setMeta(null);
        setError(null);
        return undefined;
      }

      // Cancel any in-flight request
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const seq = ++seqRef.current;

      setLoading(true);
      setError(null);
      try {
        const res = await api.request({
          url: `${resource}:${action}`,
          params: {
            instanceId,
            folderId,
            folderKey,
            ...extraParamsRef.current,
            ...overrideParams,
          },
          signal: controller.signal,
        });
        // Stale response guard — discard if a newer request has started
        if (seq !== seqRef.current) return undefined;

        const { data: result, meta: responseMeta } = normalizePayload(res?.data);
        setData(result);
        setMeta(responseMeta);
        return result;
      } catch (err: unknown) {
        // AbortError means a newer request superseded this one — ignore silently
        if ((err as any)?.name === 'AbortError' || (err as any)?.code === 'ABORT_ERR') {
          return undefined;
        }
        if (seq !== seqRef.current) return undefined;

        const nextError = new Error(getErrorMessage(err));
        setError(nextError);
        setData(null);
        setMeta(null);
        return undefined;
      } finally {
        if (seq === seqRef.current) {
          setLoading(false);
        }
      }
    },
    [api, instanceId, folderId, folderKey, resource, action],
  );

  // Re-fetch when deps change
  const paramsKey = stringifyParams(extraParams);
  useEffect(() => {
    run();
  }, [run, paramsKey]);

  return { data, meta, loading, error, refresh: run };
}
