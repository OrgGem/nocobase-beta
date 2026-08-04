import { randomUUID } from 'node:crypto';
import type { Database, Model } from '@nocobase/database';
import { LoopControlService } from './LoopControlService';
import { LoopPatternService } from './LoopPatternService';

type TriggerType = 'manual' | 'cron' | 'event';

function read(record: Model | Record<string, unknown>, key: string) {
  const model = record as Model & { get?: (name: string) => unknown };
  return typeof model.get === 'function' ? model.get(key) : (record as Record<string, unknown>)[key];
}

function plain(record: Model | Record<string, unknown>) {
  return typeof (record as Model).toJSON === 'function'
    ? ((record as Model).toJSON() as Record<string, unknown>)
    : (record as Record<string, unknown>);
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Error && error.name === 'SequelizeUniqueConstraintError';
}

export class LoopTriggerService {
  private readonly control: LoopControlService;

  constructor(
    private readonly database: Database,
    private readonly patterns: LoopPatternService,
  ) {
    this.control = new LoopControlService(database);
  }

  async enqueue(input: {
    patternId: number;
    triggerType: TriggerType;
    triggerKey: string;
    triggerPayload?: Record<string, unknown>;
    userId?: number;
    goal?: string;
    perRunHarness?: unknown;
  }) {
    const triggerKey = input.triggerKey.trim();
    if (!triggerKey) throw new Error('Trigger key is required.');
    await this.control.assertCanEnqueue();
    const compiled = await this.patterns.compile(input.patternId, input.perRunHarness);
    if (compiled.pattern.triggerType !== input.triggerType && input.triggerType !== 'manual') {
      throw new Error(
        `Pattern ${compiled.pattern.key} expects ${compiled.pattern.triggerType} triggers, not ${input.triggerType}.`,
      );
    }
    const goal = (input.goal || compiled.pattern.goalTemplate).trim();
    if (!goal) throw new Error('Loop run goal is required.');

    try {
      return await this.database.sequelize.transaction(async (transaction) => {
        await this.control.assertCanEnqueue(transaction);
        const now = new Date();
        const run = await this.database.getRepository('agentLoopRuns').create({
          values: {
            rootRunId: `loop_${randomUUID()}`,
            runtimeVersion: 'control-plane-v2',
            recordMode: 'observed-execution',
            patternId: input.patternId,
            triggerType: input.triggerType,
            triggerKey,
            triggerPayload: input.triggerPayload || {},
            autonomyLevel: compiled.pattern.autonomyLevel,
            roleBindingsSnapshot: compiled.roleBindings,
            leaderHarnessSnapshot: compiled.leaderHarness,
            makerHarnessSnapshot: compiled.makerHarnesses,
            verifierHarnessSnapshot: compiled.verifierHarness,
            policySnapshot: compiled.policy,
            leaderUsername: compiled.roleBindings.leader,
            verifierUsername: compiled.roleBindings.verifier,
            goal,
            status: 'queued',
            repositoryKey: compiled.pattern.repositoryKey,
            repositoryRoot: compiled.pattern.repositoryRoot,
            baseRef: compiled.pattern.baseRef,
            actingOn: [...compiled.pattern.actingOn],
            userId: input.userId || null,
            createdAt: now,
            updatedAt: now,
          },
          transaction,
        });
        const runId = Number(read(run, 'id'));
        await this.database.getRepository('agentLoopEvents').create({
          values: {
            runId,
            type: 'run_queued',
            title: 'Run queued',
            content: `Pattern ${compiled.pattern.key} accepted ${input.triggerType} trigger ${triggerKey}.`,
            status: 'queued',
            payload: { patternKey: compiled.pattern.key, triggerType: input.triggerType },
            actorType: input.triggerType === 'manual' ? 'user' : 'system',
            actorIdentity: input.userId ? String(input.userId) : input.triggerType,
            correlationKey: `queued:${triggerKey}`,
            userId: input.userId || null,
            createdAt: now,
          },
          transaction,
        });
        return { created: true, run: plain(run) };
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const existing = await this.database.getRepository('agentLoopRuns').findOne({
        filter: { patternId: input.patternId, triggerKey },
      });
      if (!existing) throw error;
      return { created: false, run: plain(existing) };
    }
  }
}
