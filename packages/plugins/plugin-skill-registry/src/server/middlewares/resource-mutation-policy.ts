/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import actions, { type Context } from '@nocobase/actions';

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
const TARGET_COLLECTION_HANDLERS = new Set([
  actions.get,
  actions.update,
  actions.firstOrCreate,
  actions.updateOrCreate,
]);
const DIRECT_SOURCE_MUTATIONS = new Set(['create', 'destroy', 'update']);

type RepositoryAwareContext = Context & {
  getCurrentRepository?: () => {
    targetCollection?: {
      name?: string;
    };
  } | null;
};

export function resolveRegistryResourceName(ctx: Context): string | null {
  const { resourceName, params } = ctx.action;
  // These core repository actions actually forward targetCollection to the database.
  const target = params?.targetCollection;
  if (
    typeof target === 'string' &&
    REGISTRY_COLLECTION_RESOURCES.has(target) &&
    TARGET_COLLECTION_HANDLERS.has(ctx.action.getHandler())
  ) {
    return target;
  }
  if (REGISTRY_COLLECTION_RESOURCES.has(resourceName)) return resourceName;
  if (!resourceName.includes('.')) return null;
  const repositoryContext = ctx as RepositoryAwareContext;
  if (repositoryContext.getCurrentRepository) {
    try {
      const targetName = repositoryContext.getCurrentRepository()?.targetCollection?.name;
      if (targetName) {
        return REGISTRY_COLLECTION_RESOURCES.has(targetName) ? targetName : null;
      }
    } catch {
      // Action resolution can run without a repository (for custom resources). Fall back
      // to the already-resolved route names in that case.
    }
  }
  return resourceName.split('.').find((name) => REGISTRY_COLLECTION_RESOURCES.has(name)) || null;
}

function isDirectSourceMutation(ctx: Context, resourceName: string): boolean {
  const filterByTk = isRecord(ctx.action.params) ? ctx.action.params.filterByTk : undefined;
  const hasSingleTarget = (typeof filterByTk === 'string' && filterByTk.length > 0) || typeof filterByTk === 'number';
  return (
    resourceName === 'skillRegistrySources' &&
    ctx.action.resourceName === 'skillRegistrySources' &&
    (!ctx.action.params?.targetCollection || ctx.action.params.targetCollection === resourceName) &&
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
