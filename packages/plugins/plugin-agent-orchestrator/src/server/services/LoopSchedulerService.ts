import type { Database, Model, Transaction } from '@nocobase/database';
import type { Application, Plugin } from '@nocobase/server';
import type { LoopPattern } from './LoopPatternSchema';
import { LoopPatternService } from './LoopPatternService';
import { LoopTriggerService } from './LoopTriggerService';

type ManagedCronJob = ReturnType<Application['cronJobManager']['addJob']>;

type ScheduledPattern = {
  job: ManagedCronJob;
  signature: string;
};

type TransactionOptions = {
  transaction?: Transaction;
};

export type LoopSchedulerSyncMessage = {
  type: 'loop-pattern-schedule-changed';
  patternId: number;
};

function read(record: Model | Record<string, unknown>, key: string) {
  const model = record as Model & { get?: (name: string) => unknown };
  return typeof model.get === 'function' ? model.get(key) : (record as Record<string, unknown>)[key];
}

function positiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function isLockAcquireError(error: unknown) {
  return error instanceof Error && error.constructor.name === 'LockAcquireError';
}

function tickDate(pattern: LoopPattern, now: Date) {
  const fields = pattern.cronExpression?.split(/\s+/).filter(Boolean).length || 5;
  const interval = fields === 6 ? 1_000 : 60_000;
  return new Date(Math.floor(now.getTime() / interval) * interval);
}

export class LoopSchedulerService {
  private readonly scheduled = new Map<number, ScheduledPattern>();
  private started = false;
  private installed = false;

  constructor(
    private readonly plugin: Plugin,
    private readonly patterns: LoopPatternService,
    private readonly triggers: LoopTriggerService,
  ) {}

  install() {
    if (this.installed) return;
    this.installed = true;
    this.plugin.db.on('agentLoopPatterns.afterCreate', this.onPatternChanged);
    this.plugin.db.on('agentLoopPatterns.afterUpdate', this.onPatternChanged);
    this.plugin.db.on('agentLoopPatterns.afterDestroy', this.onPatternChanged);
    this.plugin.app.on('afterStart', this.start);
  }

  async dispose() {
    if (!this.installed) return;
    this.installed = false;
    this.plugin.db.off('agentLoopPatterns.afterCreate', this.onPatternChanged);
    this.plugin.db.off('agentLoopPatterns.afterUpdate', this.onPatternChanged);
    this.plugin.db.off('agentLoopPatterns.afterDestroy', this.onPatternChanged);
    this.plugin.app.off('afterStart', this.start);
    this.stop();
  }

  readonly start = async () => {
    if (this.started) return;
    this.started = true;
    await this.resyncAll();
  };

  stop() {
    this.started = false;
    for (const { job } of this.scheduled.values()) this.plugin.app.cronJobManager.removeJob(job);
    this.scheduled.clear();
  }

  async handleSyncMessage(message: unknown) {
    if (!message || typeof message !== 'object') return;
    const value = message as Partial<LoopSchedulerSyncMessage>;
    if (value.type !== 'loop-pattern-schedule-changed') return;
    const patternId = positiveInteger(value.patternId);
    if (!patternId) return;
    await this.resyncPattern(patternId);
  }

  async resyncAll() {
    if (!this.started) return;
    const records = await this.plugin.db.getRepository('agentLoopPatterns').find({ fields: ['id'] });
    const patternIds = new Set<number>();
    for (const record of records) {
      const patternId = positiveInteger(read(record, 'id'));
      if (!patternId) continue;
      patternIds.add(patternId);
      await this.resyncPattern(patternId);
    }
    for (const patternId of this.scheduled.keys()) {
      if (!patternIds.has(patternId)) this.remove(patternId);
    }
  }

  async resyncPattern(patternId: number) {
    if (!this.started) return;
    const record = await this.plugin.db.getRepository('agentLoopPatterns').findOne({ filterByTk: patternId });
    if (!record || read(record, 'enabled') !== true || read(record, 'triggerType') !== 'cron') {
      this.remove(patternId);
      return;
    }

    try {
      const { pattern } = await this.patterns.get(patternId);
      const signature = JSON.stringify([pattern.cronExpression, pattern.timezone]);
      if (this.scheduled.get(patternId)?.signature === signature) return;
      this.remove(patternId);
      const job = this.plugin.app.cronJobManager.addJob({
        cronTime: pattern.cronExpression as string,
        timeZone: pattern.timezone as string,
        onTick: () => this.onTick(patternId, pattern).catch((error) => this.logTickError(patternId, error)),
      });
      this.scheduled.set(patternId, { job, signature });
      if (this.plugin.app.cronJobManager.started) job.start();
      this.plugin.app.logger.info(`[AgentOrchestrator] Scheduled loop pattern ${pattern.key}.`, {
        patternId,
        cronExpression: pattern.cronExpression,
        timezone: pattern.timezone,
      });
    } catch (error) {
      this.remove(patternId);
      this.plugin.app.logger.error(`[AgentOrchestrator] Loop pattern ${patternId} could not be scheduled.`, { error });
    }
  }

  private readonly onPatternChanged = async (record: Model, options: TransactionOptions = {}) => {
    const patternId = positiveInteger(read(record, 'id'));
    if (!patternId) return;
    const apply = async () => {
      await this.resyncPattern(patternId);
      await this.plugin.sendSyncMessage({ type: 'loop-pattern-schedule-changed', patternId });
    };
    if (options.transaction) {
      // afterCommit does not await its callback, so a rejection here would be
      // an unhandled promise. Catch and log so a failed resync/broadcast does
      // not silently drop the schedule change.
      options.transaction.afterCommit(() =>
        apply().catch((error) =>
          this.plugin.app.logger.error(
            `[AgentOrchestrator] Failed to apply schedule change for loop pattern ${patternId} after commit.`,
            { error },
          ),
        ),
      );
      return;
    }
    await apply();
  };

  private async onTick(patternId: number, pattern: LoopPattern) {
    const scheduledAt = tickDate(pattern, new Date());
    const triggerKey = `cron:${pattern.key}:${scheduledAt.toISOString()}`;
    let lock;
    try {
      lock = await this.plugin.app.lockManager.tryAcquire(
        `agent-loop:schedule:${this.plugin.app.name}:${patternId}:${triggerKey}`,
      );
    } catch (error) {
      if (isLockAcquireError(error)) return;
      throw error;
    }

    await lock.runExclusive(async () => {
      await this.triggers.enqueue({
        patternId,
        triggerType: 'cron',
        triggerKey,
        triggerPayload: { scheduledAt: scheduledAt.toISOString(), timezone: pattern.timezone },
      });
    }, 60_000);
  }

  private remove(patternId: number) {
    const existing = this.scheduled.get(patternId);
    if (!existing) return;
    this.plugin.app.cronJobManager.removeJob(existing.job);
    this.scheduled.delete(patternId);
  }

  private logTickError(patternId: number, error: unknown) {
    this.plugin.app.logger.error(`[AgentOrchestrator] Scheduled loop pattern ${patternId} failed to enqueue.`, {
      error,
    });
  }
}
