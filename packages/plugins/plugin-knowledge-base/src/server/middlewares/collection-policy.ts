// SPDX-License-Identifier: Apache-2.0

import type { Context, Next } from '@nocobase/actions';

const COLLECTIONS = new Set([
  'aiKnowledgeBases',
  'aiKnowledgeBaseDocuments',
  'aiKnowledgeBaseDocumentVersions',
  'aiVectorDatabases',
  'aiVectorStores',
]);

type RepositoryAwareContext = Context & {
  getCurrentRepository?: () => { targetCollection?: { name?: string } } | null;
};

/** Custom aliases enforce KB permissions and lifecycle; generic collection routes must not bypass them. */
export function targetsProtectedCollection(ctx: Context): boolean {
  const action = ctx.action;
  if (!action) return false;
  const params = action.params;
  const candidates = [action.resourceName, params?.resourceName, params?.associatedName, params?.targetCollection];
  if (
    candidates.some(
      (candidate) => typeof candidate === 'string' && candidate.split(/[.,]/).some((part) => COLLECTIONS.has(part)),
    )
  )
    return true;
  if (!action.resourceName?.includes('.')) return false;
  const [sourceName, fieldName] = action.resourceName.split('.');
  const targetName = ctx.db.getCollection(sourceName)?.getField(fieldName)?.target;
  if (typeof targetName === 'string' && COLLECTIONS.has(targetName)) return true;
  try {
    const target = (ctx as RepositoryAwareContext).getCurrentRepository?.()?.targetCollection?.name;
    return typeof target === 'string' && COLLECTIONS.has(target);
  } catch {
    return false;
  }
}

export async function blockProtectedCollectionRoutes(ctx: Context, next: Next): Promise<void> {
  if (targetsProtectedCollection(ctx)) {
    ctx.throw(404, 'Not Found');
    return;
  }
  await next();
}
