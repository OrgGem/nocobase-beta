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
  DEFAULT_MODEL_ID,
  DEFAULT_DTYPE,
  DEFAULT_DIMENSIONS,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_BATCH_SIZE,
  OFFLINE_MODEL_SOURCE,
} from '../../shared/constants';
import { validateDimensions } from '../../shared/utils';

/**
 * GET /embedWebClient:getConfig
 *
 * Returns the plugin configuration for model management and browser model
 * loading. Knowledge Base vectorization no longer uses this endpoint.
 */
export async function getConfig(ctx: Context, next: Next) {
  const repo = ctx.db.getRepository('embedWebClientConfig');

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

  const safeConfig = config?.toJSON ? config.toJSON() : { ...(config ?? {}) };
  if (safeConfig.s3SecretAccessKey) {
    safeConfig.s3SecretAccessKey = '***';
  }

  ctx.body = {
    ...safeConfig,
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
    config = await repo.findOne({ filter: { id: config.id } });
  }

  const safeConfig = config?.toJSON ? config.toJSON() : { ...(config ?? {}) };
  if (safeConfig.s3SecretAccessKey) {
    safeConfig.s3SecretAccessKey = '***';
  }

  ctx.body = safeConfig;
  await next();
}
