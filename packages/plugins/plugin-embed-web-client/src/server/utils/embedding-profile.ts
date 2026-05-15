/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Database } from '@nocobase/database';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_DIMENSIONS,
  DEFAULT_DTYPE,
  DEFAULT_MODEL_ID,
  OFFLINE_MODEL_SOURCE,
  VALID_MODEL_ID_RE,
} from '../../shared/constants';
import { validateDimensions } from '../../shared/utils';
import { BUNDLED_MODELS_ROOT, STORAGE_MODELS_ROOT } from '../actions/model-manager';

export interface EmbeddingProfile {
  modelId: string;
  dtype: string;
  dimensions: number;
  chunkSize: number;
  chunkOverlap: number;
  batchSize: number;
  preferWebGPU: boolean;
  modelSource: typeof OFFLINE_MODEL_SOURCE;
  knowledgeBaseId?: string;
  signature: string;
}

function toPlain(record: any): Record<string, any> {
  return record?.toJSON ? record.toJSON() : { ...(record ?? {}) };
}

function normalizePositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

function readModelDimensions(modelId: string): number | null {
  for (const root of [STORAGE_MODELS_ROOT, BUNDLED_MODELS_ROOT]) {
    const configPath = join(root, modelId, 'config.json');
    if (!existsSync(configPath)) continue;

    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      const dimension =
        config.hidden_size ??
        config.d_model ??
        config.dim ??
        config.projection_dim ??
        config.text_config?.hidden_size ??
        config.sentence_embedding_dimension;
      return dimension == null ? null : validateDimensions(dimension);
    } catch {
      return null;
    }
  }

  return null;
}

async function getOrCreateConfig(db: Database): Promise<Record<string, any>> {
  const repo = db.getRepository('embedWebClientConfig');
  let config = await repo.findOne({ filter: {}, sort: ['id'] });

  if (!config) {
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

  return toPlain(config);
}

export async function resolveEmbeddingProfile(db: Database, knowledgeBaseId?: string): Promise<EmbeddingProfile> {
  const config = await getOrCreateConfig(db);
  let kb: Record<string, any> | null = null;

  if (knowledgeBaseId) {
    const kbRecord = await db.getRepository('aiKnowledgeBases').findOne({
      filter: { id: knowledgeBaseId },
      appends: ['vectorStore'],
    });
    kb = kbRecord ? toPlain(kbRecord) : null;
  }

  const vectorStore = kb?.vectorStore ?? {};
  const modelId = kb?.embedModelId || vectorStore.localEmbedModelId || config.modelId || DEFAULT_MODEL_ID;
  if (!VALID_MODEL_ID_RE.test(modelId)) {
    throw new Error(`Invalid embedding model ID: "${modelId}"`);
  }

  const dtype = vectorStore.localEmbedDtype || config.dtype || DEFAULT_DTYPE;
  const dimensions = readModelDimensions(modelId) ?? validateDimensions(config.dimensions ?? DEFAULT_DIMENSIONS);
  const chunkSize = normalizePositiveInt(config.chunkSize, DEFAULT_CHUNK_SIZE, 100, 8000);
  const chunkOverlap = normalizePositiveInt(config.chunkOverlap, DEFAULT_CHUNK_OVERLAP, 0, Math.max(0, chunkSize - 1));
  const batchSize = normalizePositiveInt(config.batchSize, DEFAULT_BATCH_SIZE, 1, 128);

  return {
    modelId,
    dtype,
    dimensions,
    chunkSize,
    chunkOverlap,
    batchSize,
    preferWebGPU: config.preferWebGPU !== false,
    modelSource: OFFLINE_MODEL_SOURCE,
    knowledgeBaseId: kb ? String(kb.id) : undefined,
    signature: `${modelId}::${dtype}::${dimensions}`,
  };
}

export function assertClientProfileMatches(
  expected: EmbeddingProfile,
  actual: { modelId?: string; dtype?: string; dimensions?: number },
): void {
  if (!actual.modelId) {
    throw new Error('Embedding model is required');
  }
  if (!actual.dtype) {
    throw new Error('Embedding dtype is required');
  }
  if (actual.dimensions == null) {
    throw new Error('Embedding dimensions are required');
  }
  if (actual.modelId !== expected.modelId) {
    throw new Error(`Embedding model mismatch: expected ${expected.modelId}, got ${actual.modelId}`);
  }
  if (actual.dtype !== expected.dtype) {
    throw new Error(`Embedding dtype mismatch: expected ${expected.dtype}, got ${actual.dtype}`);
  }
  if (Number(actual.dimensions) !== expected.dimensions) {
    throw new Error(`Embedding dimensions mismatch: expected ${expected.dimensions}, got ${actual.dimensions}`);
  }
}
