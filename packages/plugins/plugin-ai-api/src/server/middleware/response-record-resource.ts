/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Context, Next } from '@nocobase/actions';

export const RESPONSE_RECORD_COLLECTION = 'aiApiResponseRecords';

type RepositoryAwareContext = Context & {
  getCurrentRepository?: () => { targetCollection?: { name?: string } } | null;
};

function routeCandidates(ctx: Context): string[] {
  const params = ctx.action?.params;
  const candidates = [ctx.action?.resourceName, params?.resourceName, params?.associatedName, params?.targetCollection];
  return candidates.filter((value): value is string => typeof value === 'string').flatMap((value) => value.split('.'));
}

export function targetsResponseRecordCollection(ctx: Context): boolean {
  const repositoryContext = ctx as RepositoryAwareContext;
  if (repositoryContext.getCurrentRepository) {
    try {
      if (repositoryContext.getCurrentRepository()?.targetCollection?.name === RESPONSE_RECORD_COLLECTION) return true;
    } catch {
      // Some custom resources have no repository. Fall back to the resolved route fields.
    }
  }
  return routeCandidates(ctx).includes(RESPONSE_RECORD_COLLECTION);
}

export function blockResponseRecordResource() {
  return async (ctx: Context, next: Next): Promise<void> => {
    if (targetsResponseRecordCollection(ctx)) {
      ctx.throw(404, 'Not Found');
      return;
    }
    await next();
  };
}
