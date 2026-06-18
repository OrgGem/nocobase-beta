/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { useApp } from '@nocobase/client-v2';
import type { WorkerMessage, WorkerResponse } from '../workers/embedding-worker';
import { mainDataSourceRequest } from '../api';

// ── Types ─────────────────────────────────────────────────────────────────────

export type WorkerState = 'idle' | 'loading_model' | 'ready' | 'processing' | 'error';

export interface EmbeddingConfig {
  modelId: string;
  dtype: string;
  dimensions: number;
  chunkSize: number;
  chunkOverlap: number;
  batchSize: number;
  preferWebGPU: boolean;
  /** Private mode always fetches model files from the NocoBase server. */
  modelSource: 'server';
  signature?: string;
  knowledgeBaseId?: string;
}

interface ProcessOptions {
  documentId: string;
  text: string;
  metadata?: Record<string, any>;
  onProgress?: (embedded: number, total: number) => void;
}

interface ProcessResult {
  chunks: Array<{ text: string; embedding: number[]; metadata: any }>;
}

interface EmbeddingWorkerContextValue {
  state: WorkerState;
  modelProgress: number; // 0–100 during download
  config: EmbeddingConfig | null;
  /** Ensures model is loaded; resolves once ready. */
  ensureReady: () => Promise<void>;
  processDocument: (opts: ProcessOptions) => Promise<ProcessResult>;
  embedQuery: (text: string) => Promise<number[]>;
}

// ── Context ───────────────────────────────────────────────────────────────────

const EmbeddingWorkerContext = createContext<EmbeddingWorkerContextValue | null>(null);

export function useEmbeddingWorker(): EmbeddingWorkerContextValue {
  const ctx = useContext(EmbeddingWorkerContext);
  if (!ctx) throw new Error('useEmbeddingWorker must be used inside EmbeddingWorkerProvider');
  return ctx;
}

// ── Provider ──────────────────────────────────────────────────────────────────

export const EmbeddingWorkerProvider: React.FC<{ children: React.ReactNode; knowledgeBaseId?: string }> = ({
  children,
  knowledgeBaseId,
}) => {
  const api = useApp().apiClient;
  const workerRef = useRef<Worker | null>(null);
  const configRef = useRef<EmbeddingConfig | null>(null);
  const [state, setState] = useState<WorkerState>('idle');
  const [modelProgress, setModelProgress] = useState(0);
  const [config, setConfig] = useState<EmbeddingConfig | null>(null);

  // Pending promise resolvers keyed by documentId or requestId
  const pendingRef = useRef<
    Map<string, { resolve: (v: any) => void; reject: (e: any) => void; onProgress?: (e: number, t: number) => void }>
  >(new Map());

  // Promise that resolves when the model is ready (lazy init)
  const readyPromiseRef = useRef<Promise<void> | null>(null);
  const readyResolveRef = useRef<(() => void) | null>(null);
  const readyRejectRef = useRef<((err: Error) => void) | null>(null);

  const send = useCallback((msg: WorkerMessage) => {
    workerRef.current?.postMessage(msg);
  }, []);

  const resetReadyState = useCallback((err?: Error) => {
    if (err) {
      readyRejectRef.current?.(err);
    }
    readyPromiseRef.current = null;
    readyResolveRef.current = null;
    readyRejectRef.current = null;
  }, []);

  const failWorker = useCallback(
    (err: Error) => {
      setState('error');
      resetReadyState(err);
      pendingRef.current.forEach(({ reject }) => reject(err));
      pendingRef.current.clear();
      workerRef.current?.terminate();
      workerRef.current = null;
    },
    [resetReadyState],
  );

  // Lazy initialization — only creates the worker and loads the model when first needed
  const ensureReady = useCallback(async (): Promise<void> => {
    // If worker already exists, always return a consistent Promise<void>
    if (workerRef.current) {
      if (state === 'ready' || state === 'processing') return;
      if (readyPromiseRef.current) return readyPromiseRef.current;
      // Worker exists but no ready-promise — treat as ready (model may have loaded synchronously)
      return;
    }

    // Guard against concurrent calls: if a ready-promise already exists, return it
    if (readyPromiseRef.current) return readyPromiseRef.current;

    // Create the ready promise
    readyPromiseRef.current = new Promise<void>((resolve, reject) => {
      readyResolveRef.current = resolve;
      readyRejectRef.current = reject;
    });
    void readyPromiseRef.current.catch(() => {});

    // Load the offline embedding profile for this knowledge base.
    let cfg: EmbeddingConfig | null = null;
    try {
      const res = await api.request(
        mainDataSourceRequest({
          url: 'embedWebClient:getConfig',
          params: knowledgeBaseId ? { knowledgeBaseId } : undefined,
        }),
      );
      cfg = res?.data?.data ?? res?.data;
      if (!cfg?.modelId || !cfg?.dtype || cfg.dimensions == null) {
        throw new Error('Invalid embedding configuration returned by server');
      }
      configRef.current = cfg;
      setConfig(cfg);
    } catch (err: any) {
      const error = new Error(err?.message ?? 'Failed to load embedding configuration');
      resetReadyState(error);
      setState('error');
      throw error;
    }
    if (!cfg) {
      const error = new Error('Invalid embedding configuration returned by server');
      resetReadyState(error);
      setState('error');
      throw error;
    }

    // Create worker
    const worker = new Worker(new URL('../workers/embedding-worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;

    // Wire message handler
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;

      switch (msg.type) {
        case 'model_loading':
          setState('loading_model');
          setModelProgress(msg.progress);
          break;

        case 'model_ready':
          setState('ready');
          setModelProgress(100);
          // Resolve the ready promise
          readyResolveRef.current?.();
          resetReadyState();
          break;

        case 'embed_progress': {
          const pending = pendingRef.current.get(msg.documentId);
          pending?.onProgress?.(msg.embedded, msg.total);
          break;
        }

        case 'complete': {
          const pending = pendingRef.current.get(msg.documentId);
          if (pending) {
            pendingRef.current.delete(msg.documentId);
            setState('ready');
            pending.resolve({ chunks: msg.chunks });
          }
          break;
        }

        case 'query_result': {
          const pending = pendingRef.current.get(msg.requestId);
          if (pending) {
            pendingRef.current.delete(msg.requestId);
            pending.resolve(msg.embedding);
          }
          break;
        }

        case 'error': {
          const key = msg.documentId ?? msg.requestId;
          const error = new Error(msg.error);
          if (key) {
            const pending = pendingRef.current.get(key);
            if (pending) {
              pendingRef.current.delete(key);
              pending.reject(error);
            }
          } else {
            failWorker(error);
          }
          setState('error');
          break;
        }
      }
    };

    worker.onerror = (err) => {
      failWorker(new Error(err.message));
    };

    // Kick off model loading through the local NocoBase model server.
    setState('loading_model');
    send({
      type: 'init',
      modelId: cfg.modelId,
      dtype: cfg.dtype,
      preferWebGPU: cfg.preferWebGPU,
      modelSource: 'server',
      serverOrigin: window.location.origin,
    });

    return readyPromiseRef.current;
  }, [api, send, state, knowledgeBaseId, resetReadyState, failWorker]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      resetReadyState();
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, [resetReadyState]);

  const processDocument = useCallback(
    async ({ documentId, text, metadata = {}, onProgress }: ProcessOptions): Promise<ProcessResult> => {
      // Ensure model is initialized before processing
      await ensureReady();

      const cfg = configRef.current;
      if (!cfg) throw new Error('Config not loaded');

      return new Promise((resolve, reject) => {
        pendingRef.current.set(documentId, { resolve, reject, onProgress });
        setState('processing');
        send({
          type: 'process',
          documentId,
          text,
          chunkSize: cfg.chunkSize,
          chunkOverlap: cfg.chunkOverlap,
          batchSize: cfg.batchSize,
          metadata,
        });
      });
    },
    [send, ensureReady],
  );

  const embedQuery = useCallback(
    async (text: string): Promise<number[]> => {
      await ensureReady();

      const requestId = `query-${Date.now()}-${Math.random()}`;
      return new Promise((resolve, reject) => {
        pendingRef.current.set(requestId, { resolve, reject });
        send({ type: 'embed_query', text, requestId });
      });
    },
    [send, ensureReady],
  );

  return (
    <EmbeddingWorkerContext.Provider value={{ state, modelProgress, config, ensureReady, processDocument, embedQuery }}>
      {children}
    </EmbeddingWorkerContext.Provider>
  );
};
