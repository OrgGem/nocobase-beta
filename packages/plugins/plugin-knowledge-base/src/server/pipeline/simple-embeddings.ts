/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import axios from 'axios';

/**
 * Simple HTTP-based embeddings that calls the OpenAI-compatible /embeddings endpoint directly.
 * Avoids the encoding_format issue in langchain's OpenAIEmbeddings + OpenAI SDK v4,
 * which causes 400 errors with providers like Nvidia on OpenRouter.
 *
 * Fix #6: embedDocuments() now uses batched HTTP requests instead of N serial calls.
 * Most OpenAI-compatible APIs accept an array as `input`, dramatically reducing round-trips.
 */
export class SimpleHTTPEmbeddings {
  private baseURL: string;
  private apiKey: string;
  private modelName: string;

  /** Max texts per API request. Keep conservative for providers with lower limits. */
  private static readonly BATCH_SIZE = 20;

  constructor(opts: { baseURL: string; apiKey: string; model: string }) {
    this.baseURL = opts.baseURL.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.modelName = opts.model;
  }

  /**
   * Embed multiple texts using batched HTTP requests.
   * Processes texts in chunks of BATCH_SIZE to avoid overwhelming the API,
   * and falls back to single-text requests if batch fails (e.g. provider doesn't support arrays).
   */
  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const results: number[][] = new Array(texts.length);
    const batchSize = SimpleHTTPEmbeddings.BATCH_SIZE;

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);

      try {
        // Attempt batch call with array input
        const res = await axios.post(
          `${this.baseURL}/embeddings`,
          { model: this.modelName, input: batch },
          {
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
            },
            timeout: 60000,
          },
        );

        const data: { index: number; embedding: number[] }[] = res.data?.data ?? [];
        if (data.length !== batch.length) {
          throw new Error(`Batch response length mismatch: expected ${batch.length}, got ${data.length}`);
        }

        for (const item of data) {
          results[i + item.index] = item.embedding;
        }
      } catch (batchErr: any) {
        // Batch failed — fall back to individual requests for this chunk
        for (let j = 0; j < batch.length; j++) {
          results[i + j] = await this.embedQuery(batch[j]);
        }
      }
    }

    return results;
  }

  async embedQuery(text: string): Promise<number[]> {
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const res = await axios.post(
          `${this.baseURL}/embeddings`,
          { model: this.modelName, input: text },
          {
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
            },
            timeout: 30000,
          },
        );
        const embedding = res.data?.data?.[0]?.embedding;
        if (!embedding) {
          throw new Error(
            `Embedding API returned no data: ${JSON.stringify(res.data?.error || res.data).substring(0, 200)}`,
          );
        }
        return embedding;
      } catch (err: any) {
        const status = err?.response?.status;
        const isRetryable =
          !status || // network error
          status === 429 || // rate limited
          status >= 500; // server error

        if (!isRetryable || attempt === maxRetries) {
          // Fix P2-3: Sanitize axios errors to prevent API key leakage in logs.
          // err.config.headers contains 'Authorization: Bearer <key>' which would
          // be serialized into error logs by default error handlers.
          const status = err?.response?.status;
          const errMsg = err?.response?.data?.error?.message || err?.message || String(err);
          throw new Error(
            `Embedding API error${status ? ` (HTTP ${status})` : ''}: ${String(errMsg).substring(0, 300)}`,
          );
        }

        // Exponential backoff: 1s, 2s, 4s
        const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw new Error('Unreachable');
  }
}
