import type { Application } from '@nocobase/server';
import type { CronJobParameters } from 'cron';
import { cronLockKey, runWithDistributedLock } from './distributed-lock';

/**
 * Cron options extended with the ha-scheduler-only `haLockKey`.
 *
 * Core's `cronJobManager.addJob` is typed as `CronJobParameters`, which has no
 * job-name field, so callers cannot pass `haLockKey` without a cast. Use this
 * type (and `addHaCronJob` below) to supply a stable, cross-node lock identity
 * in a type-safe way. `haLockKey` is stripped before the options reach core, so
 * the underlying `cron` constructor never sees an unknown parameter.
 */
export type HaCronJobParameters = CronJobParameters & { haLockKey?: string };

const PATCH_STATE = Symbol.for('plugin-ha-scheduler.cron-patch');
type CronManager = Application['cronJobManager'];
type AddJob = CronManager['addJob'];
// `haLockKey` is an ha-scheduler extension: core's CronJobParameters has no job
// name, so callers that need a guaranteed-stable identity supply it here.
type CronOptions = CronJobParameters & { onTick?: unknown; cronTime?: unknown; haLockKey?: unknown };
type WrappedAddJob = AddJob & { [PATCH_STATE]?: { original: AddJob; owner: symbol } };

function getExpression(options: CronOptions): string | undefined {
  return typeof options.cronTime === 'string' ? options.cronTime : undefined;
}

function getExplicitKey(options: CronOptions): string | undefined {
  return typeof options.haLockKey === 'string' ? options.haLockKey : undefined;
}

function getTickSource(options: CronOptions): string | undefined {
  return typeof options.onTick === 'function' ? options.onTick.toString() : undefined;
}

function withWrappedTick(app: Application, options: CronOptions, key: string): CronOptions {
  const original = options.onTick;
  if (typeof original !== 'function') return options;

  const wrapped = async function wrappedCronTick(this: unknown, ...args: unknown[]) {
    await runWithDistributedLock(
      app,
      { key, ttlMs: Number(process.env.HA_SCHEDULER_CRON_TTL_MS || 300_000) },
      async () => {
        await Promise.resolve(Reflect.apply(original, this, args));
      },
    );
  };

  return { ...options, onTick: wrapped };
}

export function installCronPatch(app: Application): () => void {
  const manager = app.cronJobManager as CronManager & { addJob: WrappedAddJob };
  const existing = manager.addJob as WrappedAddJob;
  const state = existing[PATCH_STATE];
  if (state) return () => undefined;

  const owner = Symbol('plugin-ha-scheduler');
  const original = existing.bind(manager) as AddJob;

  const patched = function patchedAddJob(this: CronManager, options: CronJobParameters) {
    const typed = options as CronOptions;
    const key = cronLockKey({
      expression: getExpression(typed),
      tickSource: getTickSource(typed),
      explicitKey: getExplicitKey(typed),
    });
    // Drop the ha-scheduler-only `haLockKey` before handing options to core so
    // the underlying `cron` constructor never sees an unknown parameter.
    const { haLockKey: _haLockKey, ...coreOptions } = typed;
    return original.call(this, withWrappedTick(app, coreOptions as CronOptions, key) as CronJobParameters);
  } as WrappedAddJob;

  patched[PATCH_STATE] = { original, owner };
  manager.addJob = patched;
  app.logger.info('[ha-scheduler] distributed cron coordination enabled');

  return () => {
    const current = manager.addJob as WrappedAddJob;
    if (current[PATCH_STATE]?.owner === owner) {
      manager.addJob = original as WrappedAddJob;
    }
  };
}

/**
 * Type-safe way to register a cron job with an explicit HA lock identity.
 *
 * Prefer this over calling `app.cronJobManager.addJob(... as any)` when a job
 * needs a guaranteed-stable, cross-node lock key (for example jobs built from a
 * shared factory whose closures are structurally identical). `installCronPatch`
 * must already be active; the returned job is the same one core creates.
 */
export function addHaCronJob(app: Application, options: HaCronJobParameters) {
  return app.cronJobManager.addJob(options as CronJobParameters);
}
