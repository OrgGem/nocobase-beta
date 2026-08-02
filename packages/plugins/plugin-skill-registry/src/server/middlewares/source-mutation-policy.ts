import type { Context } from '@nocobase/actions';

import { RegistryError } from '../contracts/errors';
import {
  asJsonValue,
  isRecord,
  type RegistrySourceAccessContext,
  type RegistrySourceDescriptor,
  type RegistrySourceProvider,
} from '../contracts/types';
import {
  sourceOperationLockKey,
  tryRunRegistryOperation,
  type RegistryOperationLockManager,
} from '../services/operation-lock';
import type { RegistryDatabase } from '../services/repository-types';
import {
  normalizeSourceCreateValues,
  normalizeSourceUpdateValues,
  type RegistrySourceValues,
} from '../services/validation';

const SOURCE_CONFIGURATION_FIELDS = [
  'name',
  'providerType',
  'namespace',
  'providerConfig',
  'enabled',
  'syncPolicy',
  'syncIntervalMinutes',
] as const;

function positiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

function sourceMutationLockTtlMs(): number {
  return positiveInteger(process.env.SKILL_REGISTRY_SYNC_LOCK_TTL_MS, 10 * 60 * 1000, 60 * 60 * 1000);
}

function actionParams(ctx: Context): Record<string, unknown> {
  return isRecord(ctx.action.params) ? ctx.action.params : {};
}

function mutationValues(ctx: Context): RegistrySourceValues {
  const values = actionParams(ctx).values;
  if (!isRecord(values)) {
    throw new RegistryError('INVALID_MANIFEST', 422, 'Source values are required.');
  }
  return values;
}

function sourceId(ctx: Context): string | number {
  const filterByTk = actionParams(ctx).filterByTk;
  if (
    (typeof filterByTk !== 'string' || !filterByTk.trim() || filterByTk.length > 128) &&
    (typeof filterByTk !== 'number' || !Number.isSafeInteger(filterByTk))
  ) {
    throw new RegistryError('INVALID_REQUEST', 400, 'A valid source filterByTk is required.');
  }
  return typeof filterByTk === 'string' ? filterByTk.trim() : filterByTk;
}

function currentSourceValues(source: { get(attribute: string): unknown }): RegistrySourceValues {
  const values: RegistrySourceValues = {};
  for (const field of SOURCE_CONFIGURATION_FIELDS) {
    values[field] = source.get(field);
  }
  return values;
}

function currentSourceAccess(ctx: Context): RegistrySourceAccessContext {
  const roles = ctx.state && Array.isArray(ctx.state.currentRoles) ? ctx.state.currentRoles : [];
  if (!roles.every((role): role is string => typeof role === 'string')) {
    throw new RegistryError('FORBIDDEN', 403, 'Source configuration requires a valid user role context.');
  }
  const user = (ctx.auth as unknown as { user?: { id?: string | number } } | undefined)?.user;
  return {
    kind: 'user',
    ...(user?.id === undefined ? {} : { userId: user.id }),
    roles,
  };
}

function sourceDescriptor(values: RegistrySourceValues, id: string): RegistrySourceDescriptor {
  const providerType = values.providerType;
  if (providerType !== 'git-manager' && providerType !== 'skill-hub') {
    throw new RegistryError('INVALID_MANIFEST', 422, 'Source provider type is invalid.');
  }
  if (typeof values.namespace !== 'string') {
    throw new RegistryError('INVALID_MANIFEST', 422, 'Source namespace is invalid.');
  }
  return {
    id,
    providerType,
    namespace: values.namespace,
    providerConfig: asJsonValue(values.providerConfig, {}),
  };
}

type GitSourceBinding = {
  repositoryId: string | number;
  ref: string;
  rootPath: string;
};

function gitSourceBinding(values: RegistrySourceValues): GitSourceBinding | null {
  if (values.providerType !== 'git-manager' || !isRecord(values.providerConfig)) {
    return null;
  }
  const { repositoryId, ref, rootPath } = values.providerConfig;
  if (
    (typeof repositoryId !== 'string' && typeof repositoryId !== 'number') ||
    typeof ref !== 'string' ||
    typeof rootPath !== 'string'
  ) {
    return null;
  }
  return { repositoryId, ref, rootPath };
}

function gitSourceBindingChanged(current: RegistrySourceValues, next: RegistrySourceValues): boolean {
  const nextBinding = gitSourceBinding(next);
  if (!nextBinding) {
    return false;
  }
  const currentBinding = gitSourceBinding(current);
  return (
    !currentBinding ||
    currentBinding.repositoryId !== nextBinding.repositoryId ||
    currentBinding.ref !== nextBinding.ref ||
    currentBinding.rootPath !== nextBinding.rootPath
  );
}

function hasGitSourceAccessAuthorization(source: { get(attribute: string): unknown }): boolean {
  const authorizedAt = source.get('providerAccessAuthorizedAt');
  return authorizedAt instanceof Date && Number.isFinite(authorizedAt.getTime());
}

async function authorizeSourceConfiguration(input: {
  providers?: Map<string, RegistrySourceProvider>;
  values: RegistrySourceValues;
  sourceId: string;
  ctx: Context;
}): Promise<RegistrySourceValues> {
  const descriptor = sourceDescriptor(input.values, input.sourceId);
  const provider = input.providers?.get(descriptor.providerType);
  if (descriptor.providerType !== 'git-manager') {
    return {};
  }
  if (!provider || typeof provider.assertAccess !== 'function') {
    throw new RegistryError(
      'SOURCE_PROVIDER_UNAVAILABLE',
      424,
      'Git Manager does not expose source authorization for Skill Registry.',
    );
  }
  const access = currentSourceAccess(input.ctx);
  if (access.userId === undefined) {
    throw new RegistryError('AUTHENTICATION_REQUIRED', 401, 'Source configuration requires an authenticated user.');
  }
  await provider.assertAccess(descriptor, access);
  return {
    providerAccessAuthorizedAt: new Date(),
    providerAccessAuthorizedById: String(access.userId),
  };
}

export function createSourceMutationPolicy(input: {
  database: RegistryDatabase;
  lockManager?: RegistryOperationLockManager;
  providers?: Map<string, RegistrySourceProvider>;
}) {
  return async (ctx: Context, next: () => Promise<void>): Promise<void> => {
    if (ctx.action.resourceName !== 'skillRegistrySources') {
      await next();
      return;
    }
    const actionName = ctx.action.actionName;
    if (actionName === 'create') {
      const params = actionParams(ctx);
      params.values = normalizeSourceCreateValues(mutationValues(ctx));
      params.values = {
        ...params.values,
        ...(await authorizeSourceConfiguration({
          providers: input.providers,
          values: params.values,
          sourceId: 'new-source',
          ctx,
        })),
      };
      await next();
      return;
    }
    if (actionName !== 'update' && actionName !== 'destroy') {
      await next();
      return;
    }

    const id = sourceId(ctx);
    const values = actionName === 'update' ? mutationValues(ctx) : null;
    const attempted = await tryRunRegistryOperation(
      input.lockManager,
      sourceOperationLockKey(String(id)),
      sourceMutationLockTtlMs(),
      async () => {
        // The nullable unique activeKey is the database fence when two replicas
        // use different/local lock adapters. Do not mutate provider config while
        // a sync still owns this source.
        const activeSync = await input.database
          .getRepository('skillRegistrySyncRuns')
          .findOne({ filter: { activeKey: String(id) } });
        if (activeSync) {
          throw new RegistryError(
            'REGISTRY_OPERATION_BUSY',
            409,
            'The source is currently being synchronized. Retry the request after sync completes.',
          );
        }
        if (values) {
          const existing = await input.database.getRepository('skillRegistrySources').findOne({ filterByTk: id });
          if (!existing) {
            throw new RegistryError('SOURCE_NOT_FOUND', 404, 'Skill registry source was not found.');
          }
          const currentValues = currentSourceValues(existing);
          const normalizedValues = normalizeSourceUpdateValues(currentValues, values);
          const completeValues = { ...currentValues, ...normalizedValues };
          actionParams(ctx).values = {
            ...normalizedValues,
            ...(gitSourceBindingChanged(currentValues, completeValues) ||
            (gitSourceBinding(completeValues) && !hasGitSourceAccessAuthorization(existing))
              ? await authorizeSourceConfiguration({
                  providers: input.providers,
                  values: completeValues,
                  sourceId: String(id),
                  ctx,
                })
              : {}),
          };
        }
        await next();
      },
    );
    if (!attempted.acquired) {
      throw new RegistryError(
        'REGISTRY_OPERATION_BUSY',
        409,
        'The source is currently being synchronized or published. Retry the request.',
      );
    }
  };
}
