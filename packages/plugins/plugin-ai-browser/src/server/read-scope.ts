/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Context, Next } from '@nocobase/actions';
import { publicLiveUrl } from './public-live-url';

const ownerFields: Record<string, string> = {
  aiBrowserProfiles: 'ownerId',
  aiBrowserSessions: 'ownerId',
  aiBrowserWorkflowCaches: 'ownerId',
  aiBrowserTasks: 'session.ownerId',
  aiBrowserActionEvents: 'session.ownerId',
};

export async function scopeBrowserReads(ctx: Context, next: Next) {
  if (!ctx.action.resourceName.startsWith('aiBrowser')) return next();
  const repository = ctx.getCurrentRepository();
  const collection = repository?.targetCollection || repository?.collection;
  const name = collection?.name || ctx.action.resourceName;
  const ownerField = ownerFields[name];
  if (!ownerField) return next();

  const roles = ctx.state.currentRoles?.length ? ctx.state.currentRoles : [ctx.state.currentRole];
  if (ctx.app.acl.can({ roles, resource: 'aiBrowser', action: 'setConfig' })) return next();
  const userId = ctx.state.currentUser?.id;
  if (!userId) ctx.throw(403);

  const params = ctx.action.params;
  params.filter = { $and: [params.filter || {}, { [ownerField]: userId }] };
  // Generic reads expose scalar data only. Associated records require their own owner check.
  const associations = [...(collection?.getFields?.().values() || [])]
    .filter((field) => field.isRelationField())
    .map((field) => field.name);
  const excluded = new Set([...(params.except || []), ...associations, 'cookies', 'localStorage']);
  if (name === 'aiBrowserSessions') excluded.add('metadata');
  params.appends = [];
  params.except = [...excluded];
  if (params.fields) params.fields = params.fields.filter((field: string) => !excluded.has(field.split('.')[0]));
  await next();
  if (name === 'aiBrowserSessions') {
    const clean = (record: { toJSON?: () => Record<string, unknown>; liveUrl?: unknown }) => {
      if (!record) return record;
      const data = record.toJSON ? record.toJSON() : { ...record };
      if ('liveUrl' in data) data.liveUrl = publicLiveUrl(data.liveUrl);
      return data;
    };
    if (Array.isArray(ctx.body)) ctx.body = ctx.body.map(clean);
    else if (Array.isArray(ctx.body?.rows)) ctx.body.rows = ctx.body.rows.map(clean);
    else if (ctx.body) ctx.body = clean(ctx.body);
  }
}
