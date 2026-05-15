/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Embedding Web Worker
 *
 * Runs in a dedicated Web Worker thread. Handles:
 * 1. Model loading via @huggingface/transformers (cached in IndexedDB after first download)
 * 2. Text chunking with RecursiveCharacterTextSplitter
 * 3. Batch embedding of chunks
 * 4. Query embedding for search
 *
 * Message protocol — see WorkerMessage / WorkerResponse types below.
 */

import { RecursiveCharacterTextSplitter } from './text-splitter';

// Typed self for DedicatedWorkerGlobalScope
declare const self: any;

// ── Message Types ────────────────────────────────────────────────────────────

export type WorkerMessage =
  | {
      type: 'init';
      modelId: string;
      dtype: string;
      preferWebGPU: boolean;
      /** Private mode always fetches model files from the NocoBase server. */
      modelSource: 'server';
      /** Origin of the NocoBase server — used when modelSource = 'server' */
      serverOrigin: string;
    }
  | { type: 'load_model'; modelId: string; dtype: string; serverOrigin?: string }
  | {
      type: 'process';
      documentId: string;
      text: string;
      chunkSize: number;
      chunkOverlap: number;
      batchSize: number;
      metadata: Record<string, any>;
    }
  | { type: 'embed_query'; text: string; requestId: string };

export type WorkerResponse =
  | { type: 'model_loading'; progress: number; message?: string }
  | { type: 'model_ready' }
  | { type: 'chunk_progress'; documentId: string; chunked: number; total: number }
  | { type: 'embed_progress'; documentId: string; embedded: number; total: number }
  | {
      type: 'complete';
      documentId: string;
      chunks: Array<{ text: string; embedding: number[]; metadata: any }>;
    }
  | { type: 'query_result'; requestId: string; embedding: number[] }
  | { type: 'error'; documentId?: string; requestId?: string; error: string };

// ── Worker State ─────────────────────────────────────────────────────────────

let pipe: any = null; // HuggingFace feature-extraction pipeline
let modelId = 'Xenova/all-MiniLM-L6-v2';
let currentServerOrigin = ''; // Stored from init, reused by load_model

// Maximum time to wait for model pipeline initialisation (10 minutes for very large models)
const MODEL_LOAD_TIMEOUT_MS = 10 * 60 * 1000;

function send(msg: WorkerResponse) {
  self.postMessage(msg);
}

// ── Model Loading ─────────────────────────────────────────────────────────────


async function loadModel(
  id: string,
  dtype: string,
  preferWebGPU: boolean,
  serverOrigin: string,
) {
  modelId = id;
  currentServerOrigin = serverOrigin;

  // Dynamically import @huggingface/transformers — not bundled into main thread
  const { pipeline, env } = await import('@huggingface/transformers');

  // Route ALL model file requests through this NocoBase server.
  env.remoteHost = `${serverOrigin}/`;
  env.remotePathTemplate = 'embed-web-client/models/{model}/';
  env.allowRemoteModels = true;
  env.allowLocalModels = false;

  // Attempt WebGPU if requested, fall back to WASM automatically
  const device = preferWebGPU ? 'webgpu' : 'wasm';

  const pipeOptions: any = {
    dtype,
    device,
    progress_callback: (progressInfo: any) => {
      // progressInfo: { status, name, file, progress, loaded, total }
      if (progressInfo.status === 'downloading' || progressInfo.status === 'progress') {
        const pct = progressInfo.progress ?? 0;
        send({ type: 'model_loading', progress: Math.round(pct), message: progressInfo.file });
      }
    },
  };

  // Wrap pipeline() in a timeout so a stalled model fetch doesn't hang forever
  pipe = await Promise.race([
    pipeline('feature-extraction', id, pipeOptions),
    new Promise<never>((_resolve, reject) =>
      setTimeout(
        () => reject(new Error(`Model load timed out after ${MODEL_LOAD_TIMEOUT_MS / 60000} minutes`)),
        MODEL_LOAD_TIMEOUT_MS,
      ),
    ),
  ]);

  send({ type: 'model_ready' });
}

// ── Document Processing ───────────────────────────────────────────────────────

async function processDocument(
  documentId: string,
  text: string,
  chunkSize: number,
  chunkOverlap: number,
  batchSize: number,
  metadata: Record<string, any>,
) {
  if (!pipe) {
    send({ type: 'error', documentId, error: 'Model not loaded. Send init message first.' });
    return;
  }

  try {
    // 1. Chunk the text
    const splitter = new RecursiveCharacterTextSplitter({ chunkSize, chunkOverlap });
    const textChunks = splitter.splitText(text);
    const total = textChunks.length;

    send({ type: 'chunk_progress', documentId, chunked: total, total });

    if (total === 0) {
      send({ type: 'complete', documentId, chunks: [] });
      return;
    }

    // 2. Embed in batches
    const result: Array<{ text: string; embedding: number[]; metadata: any }> = [];

    for (let i = 0; i < textChunks.length; i += batchSize) {
      const batch = textChunks.slice(i, i + batchSize);

      // feature-extraction with mean pooling + normalization
      const output = await pipe(batch, { pooling: 'mean', normalize: true });

      for (let j = 0; j < batch.length; j++) {
        // output is a Tensor — convert to plain float32 array
        const embedding = Array.from(output[j].data as Float32Array) as number[];
        result.push({
          text: batch[j],
          embedding,
          metadata: { ...metadata },
        });
      }

      send({ type: 'embed_progress', documentId, embedded: Math.min(i + batchSize, total), total });
    }

    send({ type: 'complete', documentId, chunks: result });
  } catch (err: any) {
    send({ type: 'error', documentId, error: err?.message ?? 'Embedding failed' });
  }
}

// ── Query Embedding ───────────────────────────────────────────────────────────

async function embedQuery(text: string, requestId: string) {
  if (!pipe) {
    send({ type: 'error', requestId, error: 'Model not loaded' });
    return;
  }

  try {
    const output = await pipe([text], { pooling: 'mean', normalize: true });
    const embedding = Array.from(output[0].data as Float32Array) as number[];
    send({ type: 'query_result', requestId, embedding });
  } catch (err: any) {
    send({ type: 'error', requestId, error: err?.message ?? 'Query embedding failed' });
  }
}

// ── Message Dispatcher ────────────────────────────────────────────────────────

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const msg = event.data;

  switch (msg.type) {
    case 'init':
      try {
        await loadModel(msg.modelId, msg.dtype, msg.preferWebGPU, msg.serverOrigin);
      } catch (err: any) {
        send({ type: 'error', error: err?.message ?? 'Failed to load model' });
      }
      break;

    case 'load_model':
      // Swap to a different model (for per-KB model support)
      try {
        const { pipeline, env } = await import('@huggingface/transformers');
        // Re-apply env settings so model files are fetched from the local server
        const origin = msg.serverOrigin ?? currentServerOrigin;
        if (origin) {
          env.remoteHost = `${origin}/`;
          env.remotePathTemplate = 'embed-web-client/models/{model}/';
          env.allowRemoteModels = true;
          env.allowLocalModels = false;
        }
        pipe = await pipeline('feature-extraction', msg.modelId, {
          dtype: msg.dtype as any,
          device: (pipe as any)?._device ?? 'wasm',
        });
        modelId = msg.modelId;
        send({ type: 'model_ready' });
      } catch (err: any) {
        send({ type: 'error', error: err?.message ?? 'Failed to swap model' });
      }
      break;

    case 'process':
      await processDocument(msg.documentId, msg.text, msg.chunkSize, msg.chunkOverlap, msg.batchSize, msg.metadata);
      break;

    case 'embed_query':
      await embedQuery(msg.text, msg.requestId);
      break;

    default:
      send({ type: 'error', error: `Unknown message type: ${(msg as any).type}` });
  }
};
