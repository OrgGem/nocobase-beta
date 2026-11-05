/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Context } from '@nocobase/actions';
import { NoPermissionError } from '@nocobase/acl';

export async function readGuide(ctx: Context, field: 'generatedHtml' | 'generatedMarkdown') {
  const { resourceName } = ctx.action;
  const dataSource = ctx.app.dataSourceManager.get('main');
  const resolved = await dataSource.acl
    .resolveActionParams(ctx, {
      resourceName,
      actionName: 'get',
      params: { filterByTk: ctx.action.params.filterByTk },
    })
    .catch((error: unknown) => {
      if (error instanceof NoPermissionError) ctx.throw(403);
      throw error;
    });
  const fields: string[] | undefined = resolved.parsedParams?.fields;
  const except: string[] = resolved.parsedParams?.except || [];
  if ((fields && !fields.includes(field)) || except.includes(field)) ctx.throw(403);
  const model = await ctx.db.getRepository(resourceName).findOne({
    ...resolved.mergedParams,
    fields: ['status', field],
    appends: [],
  });
  if (!model) ctx.throw(404, ctx.t('User Guide not found', { ns: 'plugin-build-guide-block' }));
  if (model.get('status') !== 'completed') {
    ctx.throw(400, ctx.t('User Guide is not ready yet', { ns: 'plugin-build-guide-block' }));
  }
  return model.get(field) || '';
}
