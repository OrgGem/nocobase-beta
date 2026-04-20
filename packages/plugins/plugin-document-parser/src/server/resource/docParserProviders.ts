/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Context, Next } from '@nocobase/actions';
import { testOcrProviderConnection } from '../services/external-ocr-client';
import { DEFAULT_SETTINGS } from '../../shared/defaults';

/**
 * Extra actions for the docParserProviders resource.
 * Standard CRUD (list/create/update/destroy/get) is handled by NocoBase's
 * default resource manager — we only need to add the custom `testConnection`.
 */

export async function testConnection(ctx: Context, next: Next) {
  const { filterByTk } = ctx.action.params;

  const repo = ctx.db.getRepository('docParserProviders');
  const record = await repo.findOne({ filterByTk });

  if (!record) {
    ctx.throw(404, 'Provider not found');
    return;
  }

  const result = await testOcrProviderConnection({
    apiEndpoint: record.get('apiEndpoint'),
    authType: record.get('authType'),
    apiKey: record.get('apiKey'),
    authConfig: record.get('authConfig') ?? {},
    requestFormat: record.get('requestFormat'),
    requestConfig: record.get('requestConfig') ?? {},
    timeout: Math.min(record.get('timeout') ?? 10000, 15000), // cap at 15s for test
  });

  ctx.body = result;
  await next();
}

/**
 * Get/update the single global settings record.
 * Returns existing record or auto-creates with defaults.
 */
export async function getSettings(ctx: Context, next: Next) {
  const repo = ctx.db.getRepository('docParserSettings');
  let record = await repo.findOne({});
  if (!record) {
    record = await repo.create({
      values: { ...DEFAULT_SETTINGS },
    });
  }
  ctx.body = record;
  await next();
}

export async function saveSettings(ctx: Context, next: Next) {
  const repo = ctx.db.getRepository('docParserSettings');
  const body = ctx.request.body as Record<string, any>;

  let record = await repo.findOne({});
  if (!record) {
    record = await repo.create({ values: body });
  } else {
    await repo.update({ filter: { id: record.get('id') }, values: body });
    record = await repo.findOne({});
  }

  // Invalidate the router's settings cache
  const plugin = ctx.app.pm.get('@nocobase/plugin-document-parser') as any;
  plugin?.parseRouter?.invalidateSettingsCache?.();

  ctx.body = record;
  await next();
}
