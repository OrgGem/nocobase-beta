/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Context, Next } from '@nocobase/actions';
import {
  WEB_CLIENT_EMBED_KB_TYPE,
  MAX_CHUNKS_PER_REQUEST,
  SAFE_IDENTIFIER_RE,
  DEFAULT_MODEL_ID,
  DEFAULT_DTYPE,
  DEFAULT_DIMENSIONS,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_BATCH_SIZE,
} from '../../shared/constants';
import { validateDimensions } from '../../shared/utils';

function assertSafeIdentifier(name: string): void {
  if (!SAFE_IDENTIFIER_RE.test(name)) {
    throw new Error(`Invalid table name: "${name}". Must be a valid SQL identifier.`);
  }
}

/**
 * GET /embedWebClient:getConfig
 *
 * Returns the plugin configuration so the browser client knows which model to load,
 * what chunk size to use, and what vector dimensions to produce.
 */
export async function getConfig(ctx: Context, next: Next) {
  const repo = ctx.db.getRepository('embedWebClientConfig');

  let config = await repo.findOne({ filter: {}, sort: ['id'] });

  if (!config) {
    // First access — seed the defaults
    config = await repo.create({
      values: {
        modelId: DEFAULT_MODEL_ID,
        dtype: DEFAULT_DTYPE,
        dimensions: DEFAULT_DIMENSIONS,
        chunkSize: DEFAULT_CHUNK_SIZE,
        chunkOverlap: DEFAULT_CHUNK_OVERLAP,
        batchSize: DEFAULT_BATCH_SIZE,
        preferWebGPU: true,
      },
    });
  }

  ctx.body = config;
  await next();
}

/**
 * POST /embedWebClient:updateConfig
 *
 * Admin-only endpoint to update the plugin configuration.
 */
export async function updateConfig(ctx: Context, next: Next) {
  const values = ctx.action.params.values || {};
  const repo = ctx.db.getRepository('embedWebClientConfig');

  // Validate dimensions if provided
  if (values.dimensions != null) {
    values.dimensions = validateDimensions(values.dimensions);
  }

  let config = await repo.findOne({ filter: {}, sort: ['id'] });

  if (!config) {
    config = await repo.create({ values });
  } else {
    await repo.update({
      filter: { id: config.id },
      values,
    });
    // Re-fetch to return a consistent model instance
    config = await repo.findOne({ filter: { id: config.id } });
  }

  ctx.body = config;
  await next();
}

/**
 * POST /embedWebClient:storeVectors
 *
 * Receives pre-computed embedding vectors from the browser and stores them directly
 * in the PGVector table, bypassing LangChain's addDocuments() (which would re-embed).
 *
 * Body (values):
 *   documentId: string
 *   chunks: Array<{
 *     text: string,
 *     embedding: number[],
 *     metadata?: Record<string, any>
 *   }>
 */
export async function storeVectors(ctx: Context, next: Next) {
  const { documentId, chunks } = ctx.action.params.values || {};

  if (!documentId) {
    ctx.throw(400, 'documentId is required');
  }
  if (!Array.isArray(chunks) || chunks.length === 0) {
    ctx.throw(400, 'chunks must be a non-empty array');
  }
  if (chunks.length > MAX_CHUNKS_PER_REQUEST) {
    ctx.throw(400, `Too many chunks: ${chunks.length} exceeds limit of ${MAX_CHUNKS_PER_REQUEST}`);
  }

  // 1. Load document with KB → vectorStore → vectorDatabase
  const docRepo = ctx.db.getRepository('aiKnowledgeBaseDocuments');
  const doc = await docRepo.findOne({
    filter: { id: documentId },
    appends: ['knowledgeBase', 'knowledgeBase.vectorStore', 'knowledgeBase.vectorStore.vectorDatabase'],
  });

  if (!doc) {
    ctx.throw(404, 'Document not found');
  }

  const kb = doc.knowledgeBase;
  if (!kb) {
    ctx.throw(404, 'Knowledge base not found');
  }

  // 2. Authorization: verify current user has permission to write to this KB.
  //    ACL already enforces 'loggedIn'. Here we add resource-level scoping:
  //    only the document creator or an admin (via ACL snippet) can store vectors.
  const currentUser = ctx.state?.currentUser;
  if (!currentUser) {
    ctx.throw(401, 'Authentication required');
  }

  // Use NocoBase's role system: check if current user has admin role via ctx.state
  const currentRole = ctx.state?.currentRole;
  const isAdmin = currentRole === 'root' || currentRole === 'admin';
  if (!isAdmin) {
    // Non-admin: must be the document creator
    const createdById = doc.get('createdById') ?? doc.get('created_by_id');
    if (!createdById || String(createdById) !== String(currentUser.id)) {
      ctx.throw(403, 'You do not have permission to store vectors for this document');
    }
  }

  // 3. Validate KB type
  if (kb.type !== WEB_CLIENT_EMBED_KB_TYPE) {
    ctx.throw(400, `storeVectors is only for ${WEB_CLIENT_EMBED_KB_TYPE} knowledge bases`);
  }

  // 4. Get vector database connection params
  const vectorStore = kb.vectorStore;
  if (!vectorStore) {
    ctx.throw(400, 'Knowledge base has no vector store configured');
  }
  const vectorDatabase = vectorStore.vectorDatabase;
  if (!vectorDatabase) {
    ctx.throw(400, 'Vector store has no vector database configured');
  }
  if (vectorDatabase.provider !== 'pgvector') {
    ctx.throw(400, 'Only pgvector vector databases are supported for storeVectors');
  }

  const connectParams = vectorDatabase.connectParams as {
    host: string;
    port: number;
    username: string;
    password: string;
    database: string;
    tableName: string;
  };

  if (!connectParams?.tableName) {
    ctx.throw(400, 'Vector database is missing connection parameters');
  }

  // 5. Validate table name against SQL injection
  assertSafeIdentifier(connectParams.tableName);

  // 6. Validate vector dimensions against plugin config
  const configRepo = ctx.db.getRepository('embedWebClientConfig');
  const pluginConfig = await configRepo.findOne({ filter: {}, sort: ['id'] });
  const expectedDimensions = validateDimensions(pluginConfig?.dimensions ?? DEFAULT_DIMENSIONS);

  const firstEmbedding = chunks[0]?.embedding;
  if (!Array.isArray(firstEmbedding)) {
    ctx.throw(400, 'Each chunk must have an embedding array');
  }
  if (firstEmbedding.length !== expectedDimensions) {
    ctx.throw(400, `Vector dimension mismatch: expected ${expectedDimensions}, got ${firstEmbedding.length}`);
  }

  // 7. Mark document as processing
  await docRepo.update({
    filter: { id: documentId },
    values: { status: 'processing' },
  });

  // 8. Insert vectors directly into pgvector table using raw pg client
  let pgClient: any;
  try {
    const { Client } = await import('pg');
    pgClient = new Client({
      host: connectParams.host,
      port: connectParams.port,
      user: connectParams.username,
      password: connectParams.password,
      database: connectParams.database,
    });
    await pgClient.connect();

    // Use quoted identifier for the table name (double-quote escaping)
    const quotedTable = `"${connectParams.tableName.replace(/"/g, '""')}"`;

    // Ensure table exists (LangChain creates it on first use; if the store was never
    // initialized via addDocuments, we create it ourselves)
    await pgClient.query(`
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
      CREATE TABLE IF NOT EXISTS ${quotedTable} (
        id uuid NOT NULL DEFAULT uuid_generate_v4() PRIMARY KEY,
        content text,
        metadata jsonb,
        embedding vector(${expectedDimensions})
      );
    `);

    // Bulk insert all chunks inside a transaction for atomicity
    await pgClient.query('BEGIN');
    try {
      // Batch inserts: insert BATCH_INSERT_SIZE rows per statement
      const BATCH_INSERT_SIZE = 50;
      for (let i = 0; i < chunks.length; i += BATCH_INSERT_SIZE) {
        const batch = chunks.slice(i, i + BATCH_INSERT_SIZE);
        const placeholders: string[] = [];
        const params: any[] = [];

        for (let j = 0; j < batch.length; j++) {
          const { text, embedding, metadata = {} } = batch[j];

          if (!Array.isArray(embedding) || embedding.length !== expectedDimensions) {
            throw new Error(`Chunk ${i + j} has wrong embedding dimension: ${embedding?.length}`);
          }

          const embeddingStr = `[${embedding.join(',')}]`;
          const chunkMeta = {
            ...metadata,
            knowledgeBaseId: kb.id,
            documentId: doc.id,
            source: doc.filename ?? doc.get('name') ?? 'unknown',
          };

          const offset = j * 3;
          placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}::vector)`);
          params.push(text, JSON.stringify(chunkMeta), embeddingStr);
        }

        await pgClient.query(
          `INSERT INTO ${quotedTable} (content, metadata, embedding) VALUES ${placeholders.join(', ')}`,
          params,
        );
      }

      await pgClient.query('COMMIT');
    } catch (insertErr) {
      await pgClient.query('ROLLBACK');
      throw insertErr;
    }

    // 9. Update document status to success
    await docRepo.update({
      filter: { id: documentId },
      values: {
        status: 'success',
        chunkCount: chunks.length,
        error: null,
      },
    });

    ctx.body = { success: true, chunkCount: chunks.length };
  } catch (err: any) {
    // Roll back document to failed state
    await docRepo.update({
      filter: { id: documentId },
      values: {
        status: 'failed',
        error: err.message ?? 'Failed to store vectors',
      },
    });
    ctx.throw(500, err.message ?? 'Failed to store vectors');
  } finally {
    if (pgClient) {
      try {
        await pgClient.end();
      } catch {
        /* ignore */
      }
    }
  }

  await next();
}
