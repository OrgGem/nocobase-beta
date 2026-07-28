import type { Context } from '@nocobase/actions';

import { RegistryError } from '../contracts/errors';
import { isRecord } from '../contracts/types';

export const REGISTRY_COLLECTION_RESOURCES = new Set([
  'skillRegistrySources',
  'skillRegistryPackages',
  'skillRegistrySourceItems',
  'skillRegistryVersions',
  'skillRegistryArtifacts',
  'skillRegistrySyncRuns',
  'skillRegistryDownloads',
]);

const READ_ONLY_ACTIONS = new Set(['get', 'list']);
const DIRECT_SOURCE_MUTATIONS = new Set(['create', 'destroy', 'update']);

type RepositoryAwareContext = Context & {
  getCurrentRepository?: () => {
    targetCollection?: {
      name?: string;
    };
  } | null;
};

function routeResourceCandidates(ctx: Context): string[] {
  const params = isRecord(ctx.action.params) ? ctx.action.params : {};
  return [ctx.action.resourceName, params.resourceName, params.associatedName, params.targetCollection]
    .filter((value): value is string => typeof value === 'string')
    .flatMap((value) => value.split('.'));
}

export function resolveRegistryResourceName(ctx: Context): string | null {
  const repositoryContext = ctx as RepositoryAwareContext;
  if (repositoryContext.getCurrentRepository) {
    try {
      const targetName = repositoryContext.getCurrentRepository()?.targetCollection?.name;
      if (targetName && REGISTRY_COLLECTION_RESOURCES.has(targetName)) {
        return targetName;
      }
    } catch {
      // Action resolution can run without a repository (for custom resources). Fall back
      // to the already-resolved route names in that case.
    }
  }
  return routeResourceCandidates(ctx).find((name) => REGISTRY_COLLECTION_RESOURCES.has(name)) || null;
}

function isDirectSourceMutation(ctx: Context, resourceName: string): boolean {
  const filterByTk = isRecord(ctx.action.params) ? ctx.action.params.filterByTk : undefined;
  const hasSingleTarget = (typeof filterByTk === 'string' && filterByTk.length > 0) || typeof filterByTk === 'number';
  return (
    resourceName === 'skillRegistrySources' &&
    ctx.action.resourceName === 'skillRegistrySources' &&
    DIRECT_SOURCE_MUTATIONS.has(ctx.action.actionName) &&
    (ctx.action.actionName === 'create' || hasSingleTarget)
  );
}

export function isProtectedGenericMutation(ctx: Context): boolean {
  const resourceName = resolveRegistryResourceName(ctx);
  if (!resourceName || READ_ONLY_ACTIONS.has(ctx.action.actionName)) {
    return false;
  }
  return !isDirectSourceMutation(ctx, resourceName);
}

export function createResourceMutationPolicy() {
  return async (ctx: Context, next: () => Promise<void>): Promise<void> => {
    if (isProtectedGenericMutation(ctx)) {
      throw new RegistryError(
        'GENERIC_MUTATION_DISABLED',
        405,
        'Skill Registry internal resources can only be changed through registry actions.',
      );
    }
    await next();
  };
}
