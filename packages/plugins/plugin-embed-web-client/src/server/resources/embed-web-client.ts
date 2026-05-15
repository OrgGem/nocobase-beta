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
  OFFLINE_MODEL_SOURCE,
} from '../../shared/constants';
import { validateDimensions } from '../../shared/utils';
import { assertClientProfileMatches, resolveEmbeddingProfile } from '../utils/embedding-profile';

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
  const knowledgeBaseId =
    ctx.action.params?.knowledgeBaseId ?? ctx.action.params?.values?.knowledgeBaseId ?? ctx.request.query?.knowledgeBaseId;
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
        modelSource: OFFLINE_MODEL_SOURCE,
        storageMode: 'local',
      },
    });
  }

  const profile = await resolveEmbeddingProfile(ctx.db, knowledgeBaseId ? String(knowledgeBaseId) : undefined);

  // Never expose S3 secret to the browser — mask it
  const safeConfig = config?.toJSON ? config.toJSON() : { ...(config ?? {}) };
  if (safeConfig.s3SecretAccessKey) {
    safeConfig.s3SecretAccessKey = '***';
  }

  ctx.body = {
    ...safeConfig,
    ...profile,
    modelSource: OFFLINE_MODEL_SOURCE,
    cdnBaseUrl: undefined,
    cdnModelFileName: undefined,
  };
  await next();
}

/**
 * POST /embedWebClient:updateConfig
 *
 * Admin-only endpoint to update the plugin configuration.
 */
export async function updateConfig(ctx: Context, next: Next) {
  const values = {
    ...(ctx.action.params.values || {}),
    modelSource: OFFLINE_MODEL_SOURCE,
    cdnBaseUrl: null,
  };
  const repo = ctx.db.getRepository('embedWebClientConfig');

  // Validate dimensions if provided
  if (values.dimensions != null) {
    values.dimensions = validateDimensions(values.dimensions);
  }
  if (values.chunkSize != null || values.chunkOverlap != null) {
    const chunkSize = Number(values.chunkSize ?? DEFAULT_CHUNK_SIZE);
    const chunkOverlap = Number(values.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP);
    if (!Number.isFinite(chunkSize) || chunkSize < 100) {
      ctx.throw(400, 'chunkSize must be at least 100');
    }
    if (!Number.isFinite(chunkOverlap) || chunkOverlap < 0 || chunkOverlap >= chunkSize) {
      ctx.throw(400, 'chunkOverlap must be greater than or equal to 0 and less than chunkSize');
    }
  }

  // If admin sends '***' for the secret, preserve the existing value
  if (values.s3SecretAccessKey === '***') {
    delete values.s3SecretAccessKey;
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

  // Mask secret before returning
  const safeConfig = config?.toJSON ? config.toJSON() : { ...(config ?? {}) };
  if (safeConfig.s3SecretAccessKey) {
    safeConfig.s3SecretAccessKey = '***';
  }

  ctx.body = safeConfig;
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
  const { documentId, chunks, modelId, dtype, dimensions } = ctx.action.params.values || {};

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
    // Non-admin: must be the document uploader (uploadedById is set explicitly in the
    // document create handler — createdById is auto-managed by NocoBase and may not exist)
    const uploadedById = doc.get('uploadedById') ?? doc.get('uploaded_by_id');
    if (!uploadedById || String(uploadedById) !== String(currentUser.id)) {
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

  // 6. Validate the client used the same offline embedding profile the server
  // will use for RAG query embeddings.
  const expectedProfile = await resolveEmbeddingProfile(ctx.db, String(kb.id));
  try {
    assertClientProfileMatches(expectedProfile, { modelId, dtype, dimensions });
  } catch (err: any) {
    ctx.throw(400, err.message);
  }
  const expectedDimensions = validateDimensions(expectedProfile.dimensions);

  // Validate ALL chunks' embeddings before starting any DB transaction to prevent partial inserts
  for (let i = 0; i < chunks.length; i++) {
    const embedding = chunks[i]?.embedding;
    if (!Array.isArray(embedding)) {
      ctx.throw(400, `Chunk ${i} is missing an embedding array`);
    }
    if (embedding.length !== expectedDimensions) {
      ctx.throw(400, `Chunk ${i} dimension mismatch: expected ${expectedDimensions}, got ${embedding.length}`);
    }
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
          // Dimensions were already validated above — no partial-insert risk here
          const embeddingStr = `[${embedding.join(',')}]`;
          const chunkMeta = {
            ...metadata,
            knowledgeBaseId: kb.id,
            knowledgeBaseOuterId: kb.id,
            documentId: doc.id,
            embeddingModelId: expectedProfile.modelId,
            embeddingDtype: expectedProfile.dtype,
            embeddingDimensions: expectedProfile.dimensions,
            embeddingProfile: expectedProfile.signature,
            source: doc.filename ?? doc.get('name') ?? 'unknown',
            userId: doc.get('uploadedById') ?? doc.get('uploaded_by_id') ?? null,
            accessLevel: kb.accessLevel ?? 'PUBLIC',
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
