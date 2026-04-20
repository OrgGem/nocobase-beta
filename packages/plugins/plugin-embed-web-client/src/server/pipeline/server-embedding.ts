/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Server-side embedding pipeline using @huggingface/transformers in Node.js.
 *
 * Used when a Knowledge Base has embedMode = 'server'.
 * Runs ONNX inference locally on the server — zero API cost, no internet needed.
 *
 * Model files must be present in:
 *   <plugin>/public/models/{modelId}/   (bundled)
 * or
 *   storage/plugin-embed-web-client/models/{modelId}/  (user-uploaded)
 */

import { resolve, join } from 'path';
import { existsSync } from 'fs';
import type { Database } from '@nocobase/database';
import { BUNDLED_MODELS_ROOT, STORAGE_MODELS_ROOT } from '../actions/model-manager';
import {
  SAFE_IDENTIFIER_RE,
  DEFAULT_MODEL_ID,
  DEFAULT_DTYPE,
  DEFAULT_DIMENSIONS,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_BATCH_SIZE,
} from '../../shared/constants';
import { validateDimensions } from '../../shared/utils';

// Re-export for convenience
export { BUNDLED_MODELS_ROOT, STORAGE_MODELS_ROOT };

// Lazy-loaded pipeline instances (one per modelId+dtype combination)
const pipelineCache = new Map<string, any>();

function resolveModelRoot(modelId: string): string {
  // Prefer user-uploaded over bundled
  const storagePath = join(STORAGE_MODELS_ROOT, modelId);
  if (existsSync(storagePath)) return storagePath;

  const bundledPath = join(BUNDLED_MODELS_ROOT, modelId);
  if (existsSync(bundledPath)) return bundledPath;

  throw new Error(`Model "${modelId}" not found. Download it via the plugin settings.`);
}

/**
 * Embed an array of texts using the specified model.
 * Returns one float32 vector per input text.
 */
export async function embedTexts(texts: string[], modelId: string, dtype: string): Promise<number[][]> {
  if (!texts.length) return [];

  const cacheKey = `${modelId}::${dtype}`;

  if (!pipelineCache.has(cacheKey)) {
    const { pipeline, env } = await import('@huggingface/transformers');

    const modelRoot = resolveModelRoot(modelId);

    // Point to the exact directory — transformers will find files by name inside it.
    // localModelPath must end with '/'; the library appends "{modelId}/" to it,
    // so we strip the modelId suffix from the resolved path to get the parent.
    const parentRoot = resolve(modelRoot, '..'); // e.g. public/models/Xenova/
    const grandParentRoot = resolve(parentRoot, '..'); // e.g. public/models/

    env.localModelPath = grandParentRoot + '/';
    env.allowLocalModels = true;
    env.allowRemoteModels = false;

    const pipe = await pipeline('feature-extraction', modelId, {
      dtype,
      device: 'cpu',
    });
    pipelineCache.set(cacheKey, pipe);
  }

  const pipe = pipelineCache.get(cacheKey)!;
  const output = await pipe(texts, { pooling: 'mean', normalize: true });

  // output is a batch Tensor — extract each row as a plain number[]
  if (texts.length === 1) {
    return [Array.from(output.data as Float32Array)];
  }

  return Array.from({ length: texts.length }, (_, i) => Array.from(output[i].data as Float32Array));
}

/**
 * Full document processing pipeline for server-mode KBs.
 * Reads doc → chunks → embeds → stores in PGVector.
 */
export class ServerEmbeddingPipeline {
  constructor(private db: Database) {}

  async processDocument(documentId: string): Promise<void> {
    const docRepo = this.db.getRepository('aiKnowledgeBaseDocuments');
    const doc = await docRepo.findOne({
      filter: { id: documentId },
      appends: ['knowledgeBase', 'knowledgeBase.vectorStore', 'knowledgeBase.vectorStore.vectorDatabase'],
    });

    if (!doc) throw new Error(`Document ${documentId} not found`);

    const kb = doc.knowledgeBase;
    if (!kb) throw new Error('Knowledge base not found');

    // Get model config — use KB-level override or plugin global config
    const configRepo = this.db.getRepository('embedWebClientConfig');
    const globalConfig = await configRepo.findOne({ filter: {}, sort: ['id'] });

    const modelId: string = kb.embedModelId ?? globalConfig?.modelId ?? DEFAULT_MODEL_ID;
    const dtype: string = globalConfig?.dtype ?? DEFAULT_DTYPE;
    const chunkSize: number = globalConfig?.chunkSize ?? DEFAULT_CHUNK_SIZE;
    const chunkOverlap: number = globalConfig?.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;
    const batchSize: number = globalConfig?.batchSize ?? DEFAULT_BATCH_SIZE;
    const expectedDimensions = validateDimensions(globalConfig?.dimensions ?? DEFAULT_DIMENSIONS);

    // Mark as processing
    await docRepo.update({ filter: { id: documentId }, values: { status: 'processing' } });

    try {
      // Extract text
      const text: string = doc.textContent ?? (await this.readDocumentText(doc));
      if (!text?.trim()) {
        await docRepo.update({ filter: { id: documentId }, values: { status: 'success', chunkCount: 0 } });
        return;
      }

      // Chunk text — import from the shared location
      const { RecursiveCharacterTextSplitter } = await import('../../shared/text-splitter');
      const splitter = new RecursiveCharacterTextSplitter({ chunkSize, chunkOverlap });
      const chunks = splitter.splitText(text);

      if (!chunks.length) {
        await docRepo.update({ filter: { id: documentId }, values: { status: 'success', chunkCount: 0 } });
        return;
      }

      // Embed in batches
      const embedded: Array<{ text: string; embedding: number[] }> = [];
      for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        const vectors = await embedTexts(batch, modelId, dtype);
        for (let j = 0; j < batch.length; j++) {
          embedded.push({ text: batch[j], embedding: vectors[j] });
        }
      }

      // Validate dimensions
      if (embedded[0].embedding.length !== expectedDimensions) {
        throw new Error(
          `Dimension mismatch: model produced ${embedded[0].embedding.length}, expected ${expectedDimensions}`,
        );
      }

      // Store in PGVector via the storeVectors logic
      await this.storeInPGVector(kb, doc, embedded, expectedDimensions);

      await docRepo.update({
        filter: { id: documentId },
        values: { status: 'success', chunkCount: embedded.length, error: null },
      });
    } catch (err: any) {
      const currentDoc = await docRepo.findOne({ filter: { id: documentId } });
      const currentRetryCount = currentDoc?.retryCount ?? 0;
      await docRepo.update({
        filter: { id: documentId },
        values: {
          status: 'failed',
          error: err.message ?? 'Server embedding failed',
          retryCount: currentRetryCount + 1,
        },
      });
      throw err;
    }
  }

  private async readDocumentText(doc: any): Promise<string> {
    // Fallback: read from file path (reuse VectorizationPipeline's approach)
    if (!doc.fileId) return '';
    const fileRepo = this.db.getRepository('attachments');
    const file = await fileRepo.findOne({ filter: { id: doc.fileId } });
    if (!file?.path) return '';

    const absPath = resolve(process.cwd(), file.path.replace(/^\//, ''));
    const { readFileSync } = await import('fs');
    try {
      return readFileSync(absPath, 'utf-8');
    } catch {
      return '';
    }
  }

  private async storeInPGVector(
    kb: any,
    doc: any,
    chunks: Array<{ text: string; embedding: number[] }>,
    dimensions: number,
  ): Promise<void> {
    const vectorDatabase = kb.vectorStore?.vectorDatabase;
    if (!vectorDatabase) throw new Error('No vector database configured');

    const connectParams = vectorDatabase.connectParams as any;
    if (!connectParams?.tableName) throw new Error('Missing vector database connection params');

    // Validate table name
    if (!SAFE_IDENTIFIER_RE.test(connectParams.tableName)) {
      throw new Error('Invalid table name');
    }

    const validDimensions = validateDimensions(dimensions);

    const { Client } = await import('pg');
    const client = new Client({
      host: connectParams.host,
      port: connectParams.port,
      user: connectParams.username,
      password: connectParams.password,
      database: connectParams.database,
    });
    await client.connect();

    try {
      const quotedTable = `"${connectParams.tableName.replace(/"/g, '""')}"`;
      await client.query(`
        CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
        CREATE TABLE IF NOT EXISTS ${quotedTable} (
          id uuid NOT NULL DEFAULT uuid_generate_v4() PRIMARY KEY,
          content text,
          metadata jsonb,
          embedding vector(${validDimensions})
        );
      `);

      // Batch inserts inside a transaction
      await client.query('BEGIN');
      const BATCH_SIZE = 50;
      for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const batch = chunks.slice(i, i + BATCH_SIZE);
        const placeholders: string[] = [];
        const params: any[] = [];

        for (let j = 0; j < batch.length; j++) {
          const offset = j * 3;
          placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}::vector)`);
          params.push(
            batch[j].text,
            JSON.stringify({
              knowledgeBaseId: kb.id,
              documentId: doc.id,
              source: doc.filename ?? 'unknown',
            }),
            `[${batch[j].embedding.join(',')}]`,
          );
        }

        await client.query(
          `INSERT INTO ${quotedTable} (content, metadata, embedding) VALUES ${placeholders.join(', ')}`,
          params,
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    } finally {
      try {
        await client.end();
      } catch {
        /* ignore */
      }
    }
  }
}
