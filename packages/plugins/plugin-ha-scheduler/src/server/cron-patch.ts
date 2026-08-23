import type { Application } from '@nocobase/server';
import type { CronJobParameters } from 'cron';
import { cronLockKey, runWithDistributedLock } from './distributed-lock';

const PATCH_STATE = Symbol.for('plugin-ha-scheduler.cron-patch');
type CronManager = Application['cronJobManager'];
type AddJob = CronManager['addJob'];
type CronOptions = CronJobParameters & { onTick?: unknown; cronTime?: unknown };
type WrappedAddJob = AddJob & { [PATCH_STATE]?: { original: AddJob; owner: symbol } };

function getExpression(options: CronOptions): string | undefined {
  return typeof options.cronTime === 'string' ? options.cronTime : undefined;
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
  let jobIndex = 0;

  const patched = function patchedAddJob(this: CronManager, options: CronJobParameters) {
    const typed = options as CronOptions;
    const key = cronLockKey(getExpression(typed), jobIndex);
    jobIndex += 1;
    return original.call(this, withWrappedTick(app, typed, key) as CronJobParameters);
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
