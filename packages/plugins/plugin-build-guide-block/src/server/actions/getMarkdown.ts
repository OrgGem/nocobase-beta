/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Context, Next } from '@nocobase/actions';
import { readGuide } from './readGuide';

export async function getMarkdown(ctx: Context, next: Next) {
  ctx.body = await readGuide(ctx, 'generatedMarkdown');
  ctx.withoutDataWrapping = true;

  ctx.set({
    'Content-Type': 'text/markdown; charset=UTF-8',
  });

  await next();
}
