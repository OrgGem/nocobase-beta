import type { Context } from '@nocobase/actions';

import { RegistryError } from '../contracts/errors';
import { isRecord } from '../contracts/types';
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

export function createSourceMutationPolicy(input: {
  database: RegistryDatabase;
  lockManager?: RegistryOperationLockManager;
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
          actionParams(ctx).values = normalizeSourceUpdateValues(currentSourceValues(existing), values);
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
