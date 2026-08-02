import type { Context } from '@nocobase/actions';

import { RegistryError } from '../contracts/errors';
import { resolveRegistryResourceName } from './resource-mutation-policy';

type MethodContext = Context & {
  method?: string;
  set(name: string, value: string): void;
};

const PUBLIC_METHODS = new Map<string, readonly string[]>([
  ['list', ['GET', 'HEAD']],
  ['get', ['GET', 'HEAD']],
  ['versions', ['GET', 'HEAD']],
  ['download', ['GET']],
  ['metadata', ['GET', 'HEAD']],
]);

const ADMIN_ACTIONS = new Set([
  'discover',
  'sync',
  'retry',
  'resolve',
  'publish',
  'publishBatch',
  'yank',
  'unpublish',
  'unpublishBatch',
  'verify',
  'install',
  'rollback',
  'updateSettings',
]);

const ADMIN_READ_ACTIONS = new Set(['getSettings', 'installationStates', 'yankImpact']);

function allowedMethods(ctx: Context): readonly string[] | null {
  const { resourceName, actionName } = ctx.action;
  if (resourceName === 'skillRegistryPublic') {
    return PUBLIC_METHODS.get(actionName) || null;
  }
  if (resourceName === 'skillRegistryAdmin' && ADMIN_ACTIONS.has(actionName)) {
    return ['POST'];
  }
  if (resourceName === 'skillRegistryAdmin' && ADMIN_READ_ACTIONS.has(actionName)) {
    return ['GET', 'HEAD'];
  }
  if (resourceName === 'skillRegistryHealth' && actionName === 'readiness') {
    return ['GET', 'HEAD'];
  }
  if (resolveRegistryResourceName(ctx)) {
    return ['list', 'get'].includes(actionName) ? ['GET', 'HEAD'] : ['POST'];
  }
  return null;
}

export function createRequestMethodPolicy() {
  return async (ctx: Context, next: () => Promise<void>): Promise<void> => {
    const allowed = allowedMethods(ctx);
    if (!allowed) {
      await next();
      return;
    }
    const actionContext = ctx as MethodContext;
    const method = String(actionContext.method || '').toUpperCase();
    if (!allowed.includes(method)) {
      actionContext.set('Allow', allowed.join(', '));
      throw new RegistryError(
        'METHOD_NOT_ALLOWED',
        405,
        'This Skill Registry action does not allow the request method.',
      );
    }
    await next();
  };
}
