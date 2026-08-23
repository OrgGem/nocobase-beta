import { Plugin } from '@nocobase/server';
import { installCronPatch } from './cron-patch';
import { scheduleDistributedInterval } from './distributed-lock';

export class PluginHaSchedulerServer extends Plugin {
  private uninstallCronPatch?: () => void;

  async beforeLoad() {
    if (process.env.HA_SCHEDULER_ENABLED === 'false') {
      this.log.info('[ha-scheduler] disabled by HA_SCHEDULER_ENABLED=false');
      return;
    }
    this.uninstallCronPatch = installCronPatch(this.app);
  }

  public scheduleDistributedInterval(
    key: string,
    task: () => Promise<void> | void,
    intervalMs: number,
    ttlMs?: number,
  ): NodeJS.Timeout {
    return scheduleDistributedInterval(this.app, key, task, intervalMs, ttlMs);
  }

  async afterDisable() {
    this.uninstallCronPatch?.();
    this.uninstallCronPatch = undefined;
  }

  async beforeStop() {
    this.uninstallCronPatch?.();
    this.uninstallCronPatch = undefined;
  }
}

export default PluginHaSchedulerServer;
