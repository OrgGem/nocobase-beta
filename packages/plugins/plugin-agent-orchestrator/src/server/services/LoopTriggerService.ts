import { randomUUID } from 'node:crypto';
import type { Database, Model } from '@nocobase/database';
import { LoopControlService } from './LoopControlService';
import { LoopPatternService } from './LoopPatternService';
import type { CompiledPatternSnapshot, HarnessSnapshot } from './LoopPatternService';
import { read } from '../utils/record-utils';

type TriggerType = 'manual' | 'cron' | 'event';

function plain(record: Model | Record<string, unknown>) {
  return typeof (record as Model).toJSON === 'function'
    ? ((record as Model).toJSON() as Record<string, unknown>)
    : (record as Record<string, unknown>);
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Error && error.name === 'SequelizeUniqueConstraintError';
}

// One audit row per role naming the exact profile version the run was frozen with. The snapshot
// on the run row is authoritative for execution; these events make the application itself auditable
// without diffing snapshots.
function harnessAppliedEvents(compiled: CompiledPatternSnapshot) {
  const roles: Array<{ role: 'leader' | 'maker' | 'verifier'; username: string; snapshot: HarnessSnapshot }> = [
    { role: 'leader', username: compiled.roleBindings.leader, snapshot: compiled.leaderHarness },
    ...compiled.roleBindings.makers.map((username) => ({
      role: 'maker' as const,
      username,
      snapshot: compiled.makerHarnesses[username],
    })),
    { role: 'verifier', username: compiled.roleBindings.verifier, snapshot: compiled.verifierHarness },
  ];
  return roles.filter((entry) => entry.snapshot);
}

export class LoopTriggerService {
  private readonly control: LoopControlService;

  constructor(
    private readonly database: Database,
    private readonly patterns: LoopPatternService,
    private readonly logger?: { info?: (...args: unknown[]) => void; debug?: (...args: unknown[]) => void },
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
        for (const entry of harnessAppliedEvents(compiled)) {
          await this.database.getRepository('agentLoopEvents').create({
            values: {
              runId,
              type: 'harness_applied',
              title: `Harness ${entry.snapshot.tag}@v${entry.snapshot.version} applied to ${entry.role}`,
              content: `${entry.role} ${entry.username} executes under harness profile ${entry.snapshot.tag} version ${entry.snapshot.version}.`,
              status: 'queued',
              payload: {
                role: entry.role,
                username: entry.username,
                tag: entry.snapshot.tag,
                version: entry.snapshot.version,
                versionId: entry.snapshot.versionId,
                schemaVersion: entry.snapshot.schemaVersion,
              },
              actorType: input.triggerType === 'manual' ? 'user' : 'system',
              actorIdentity: input.userId ? String(input.userId) : input.triggerType,
              correlationKey: `harness:${entry.role}:${entry.username}`,
              userId: input.userId || null,
              createdAt: now,
            },
            transaction,
          });
        }
        return { created: true, run: plain(run) };
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const existing = await this.database.getRepository('agentLoopRuns').findOne({
        filter: { patternId: input.patternId, triggerKey },
      });
      if (!existing) throw error;
      this.logger?.debug?.(
        `[LoopTrigger] Deduplicated trigger key "${triggerKey}" for pattern ${input.patternId}: run ${Number(
          existing.get?.('id') || (existing as Record<string, unknown>).id,
        )} already exists.`,
      );
      return { created: false, run: plain(existing) };
    }
  }
}
