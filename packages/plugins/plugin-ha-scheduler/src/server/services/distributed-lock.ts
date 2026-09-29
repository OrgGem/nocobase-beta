/**
 * Public entry point for custom plugins that need coordinated scheduling.
 *
 * The implementation lives in `../distributed-lock` so the cron patch and the
 * exported helper always share one code path. This module only re-exports it.
 */
export {
  cronLockKey,
  isDistributedLockConfigured,
  runWithDistributedLock,
  scheduleDistributedInterval,
  type RunWithLockResult,
  type SchedulerLockOptions,
} from '../distributed-lock';
