import { createHash, randomUUID } from 'node:crypto';
import type { Database, Model } from '@nocobase/database';
import type { Application } from '@nocobase/server';
import { DurableCircuitBreakerService } from './DurableCircuitBreakerService';
import type { CompiledHarness } from './HarnessCompiler';
import { LoopBudgetService } from './LoopBudgetService';
import { LoopControlService } from './LoopControlService';
import { loopPatternPolicySchema } from './LoopPatternSchema';
import type { LoopPatternPolicy } from './LoopPatternSchema';
import { LoopRunStateMachine } from './LoopRunStateMachine';
import type { ClaimedLoopRun } from './LoopRunStateMachine';
import { PathLockService } from './PathLockService';
import { PluginAiRuntimeAdapter } from './PluginAiRuntimeAdapter';
import type { InvocationOutcome } from './PluginAiRuntimeAdapter';
import { VerificationService } from './VerificationService';

const POLL_INTERVAL_MS = 3_000;
const LEASE_MS = 120_000;
const HEARTBEAT_MS = 30_000;
const PATH_LOCK_TTL_MS = 900_000;

export type LoopWorkerSyncMessage = {
  type: 'loop-run-abort-requested';
  runId: number;
};

export function loopWorkerAbortMessage(runId: number): LoopWorkerSyncMessage {
  return { type: 'loop-run-abort-requested', runId };
}

type RunSnapshot = {
  id: number;
  patternId: number;
  goal: string;
  autonomyLevel: 'L1' | 'L2' | 'L3';
  policy: LoopPatternPolicy;
  leaderUsername: string;
  makerUsernames: string[];
  verifierUsername: string;
  leaderHarness: CompiledHarness;
  makerHarnesses: Record<string, { effective: CompiledHarness }>;
  verifierHarness: CompiledHarness;
  repositoryKey: string;
  actingOn: string[];
  userId?: number;
};

function read(record: Model | Record<string, unknown>, key: string) {
  const model = record as Model & { get?: (name: string) => unknown };
  return typeof model.get === 'function' ? model.get(key) : (record as Record<string, unknown>)[key];
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function autonomyLevel(value: unknown): 'L1' | 'L2' | 'L3' {
  return value === 'L2' || value === 'L3' ? value : 'L1';
}

function harnessFrom(value: unknown): CompiledHarness {
  const snapshot = asObject(value);
  const effective = asObject(snapshot.effective);
  if (!effective.tools) throw new Error('The run harness snapshot is missing its compiled settings.');
  return effective as unknown as CompiledHarness;
}

function inputHash(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(value ?? null))
    .digest('hex');
}

export class LoopWorkerService {
  private readonly control: LoopControlService;
  private readonly stateMachine: LoopRunStateMachine;
  private readonly budgets: LoopBudgetService;
  private readonly circuits: DurableCircuitBreakerService;
  private readonly pathLocks: PathLockService;
  private readonly runtime: PluginAiRuntimeAdapter;
  private readonly verification: VerificationService;
  private readonly workerId: string;
  private readonly active = new Map<number, AbortController>();
  private readonly heldPathLocks = new Map<number, string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private draining: Promise<void> | null = null;

  constructor(
    private readonly app: Application,
    private readonly database: Database,
  ) {
    const distributedLock = {
      runExclusive: <T>(key: string, operation: () => Promise<T>, ttl?: number) =>
        this.app.lockManager.runExclusive(key, operation, ttl),
    };
    this.control = new LoopControlService(database);
    this.stateMachine = new LoopRunStateMachine(database);
    this.budgets = new LoopBudgetService(database, distributedLock);
    this.circuits = new DurableCircuitBreakerService(database, distributedLock);
    this.pathLocks = new PathLockService(database, distributedLock);
    this.runtime = new PluginAiRuntimeAdapter(app);
    this.verification = new VerificationService(database, this.runtime, this.stateMachine);
    this.workerId = `${app.name}:${process.pid}:${randomUUID()}`;
  }

  readonly start = () => {
    // Multi-instance deployments dedicate a process to background work; only that process
    // should claim runs, otherwise every web node competes for the same leases.
    if (this.running || !this.app.serving('agent-loop:worker')) return;
    this.running = true;
    this.scheduleNextPoll();
  };

  async stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const controller of this.active.values()) controller.abort();
    if (this.draining) await this.draining.catch(() => undefined);
  }

  abortRun(runId: number) {
    this.active.get(runId)?.abort();
  }

  // A run is only active on the node that claimed it, and `sendSyncMessage` publishes with
  // `skipSelf`, so pause/cancel aborts locally and broadcasts for whichever other node holds it.
  async handleSyncMessage(message: unknown) {
    if (!message || typeof message !== 'object') return;
    const value = message as Partial<LoopWorkerSyncMessage>;
    if (value.type !== 'loop-run-abort-requested') return;
    const runId = Number(value.runId);
    if (!Number.isSafeInteger(runId) || runId <= 0) return;
    this.abortRun(runId);
  }

  private scheduleNextPoll() {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.draining = this.poll()
        .catch((error) => {
          this.app.logger.error('[AgentOrchestrator] Loop worker poll failed.', { error });
        })
        .finally(() => this.scheduleNextPoll());
    }, POLL_INTERVAL_MS);
  }

  private async poll() {
    if (!this.running) return;
    const claimed = await this.stateMachine.claimNext(this.workerId, LEASE_MS);
    if (!claimed) return;
    await this.execute(claimed);
  }

  private async execute(claimed: ClaimedLoopRun) {
    const runId = Number(claimed.run.id);
    const controller = new AbortController();
    this.active.set(runId, controller);

    // The path lock TTL is much longer than the run lease, but a run can outlive it. Renewing both
    // on the same beat keeps them expiring together, so a run can never keep executing on paths
    // whose lock another run is already free to take.
    const heartbeat = setInterval(() => {
      this.heartbeat(runId, claimed.leaseToken).catch((error) => {
        this.app.logger.warn(`[AgentOrchestrator] Loop run ${runId} lost its worker lease.`, { error });
        controller.abort();
      });
    }, HEARTBEAT_MS);

    let snapshot: RunSnapshot | null = null;
    try {
      snapshot = this.snapshotFrom(claimed.run);
      await this.runToCompletion(snapshot, claimed.leaseToken, controller.signal);
    } catch (error) {
      await this.failRun(runId, claimed.leaseToken, snapshot, error);
    } finally {
      clearInterval(heartbeat);
      this.active.delete(runId);
      const repositoryKey = this.heldPathLocks.get(runId);
      this.heldPathLocks.delete(runId);
      if (repositoryKey) {
        // The lease token is the lock owner. Passing it stops a worker whose lease was already
        // reclaimed from releasing a lock the new owner of the same run now holds.
        await this.pathLocks
          .release(runId, repositoryKey, claimed.leaseToken)
          .catch((error) => this.app.logger.warn(`[AgentOrchestrator] Path lock release failed.`, { error }));
      }
      await this.stateMachine.releaseLease(runId, claimed.leaseToken).catch(() => undefined);
    }
  }

  private async heartbeat(runId: number, leaseToken: string) {
    await this.stateMachine.renewLease(runId, leaseToken, LEASE_MS);
    const repositoryKey = this.heldPathLocks.get(runId);
    if (repositoryKey) await this.pathLocks.renew(runId, repositoryKey, PATH_LOCK_TTL_MS, leaseToken);
  }

  private async runToCompletion(snapshot: RunSnapshot, leaseToken: string, signal: AbortSignal) {
    await this.control.assertCanExecute();
    const scopeKey = `pattern:${snapshot.patternId}`;
    await this.circuits.authorizeAttempt({
      patternId: snapshot.patternId,
      scopeKey,
      policy: snapshot.policy.circuit,
    });

    if (!(await this.acquirePaths(snapshot, leaseToken))) return;

    await this.stateMachine.transition({
      runId: snapshot.id,
      to: 'running',
      actorType: 'worker',
      actorIdentity: this.workerId,
      leaseToken,
      eventType: 'run_started',
      title: 'Run started',
      content: `Leader ${snapshot.leaderUsername} began working on the goal.`,
      correlationKey: `started:${snapshot.id}`,
      values: { currentRole: 'leader' },
    });

    const leader = await this.invokeRole(snapshot, {
      role: 'leader',
      username: snapshot.leaderUsername,
      harness: snapshot.leaderHarness,
      systemMessage:
        'You lead an autonomous run. Break the goal into concrete work for your makers, then finish with a concise plan of what must be built and which evidence will prove it. You do not modify anything yourself.',
      prompt: snapshot.goal,
      leaseToken,
      signal,
    });

    // plugin-ai stops the graph on an approval-gated tool. Approval is a human decision, so the
    // run parks here instead of the worker deciding on the operator's behalf.
    if (leader.interrupted.length) {
      await this.parkForApproval(snapshot, leader, leaseToken);
      return;
    }

    // Each maker executes with its own compiled harness snapshot. Reusing one harness would apply
    // the wrong per-employee tool grants, so the snapshot is looked up by username and a maker with
    // no snapshot is a compile error, not a silent skip.
    const makerReports: string[] = [leader.content];
    for (const username of snapshot.makerUsernames) {
      const harness = snapshot.makerHarnesses[username]?.effective;
      if (!harness) {
        throw new Error(`The claimed run has no harness snapshot for maker "${username}".`);
      }
      const maker = await this.invokeRole(snapshot, {
        role: 'maker',
        username,
        harness,
        systemMessage:
          'You are a maker on an autonomous run. Do the work assigned by the leader using only the tools you were granted, and report exactly what you changed and the evidence for it.',
        prompt: [
          `Goal: ${snapshot.goal}`,
          '',
          "Leader's plan:",
          leader.content || '(the leader produced no textual plan)',
        ].join('\n'),
        leaseToken,
        signal,
      });
      if (maker.interrupted.length) {
        await this.parkForApproval(snapshot, maker, leaseToken);
        return;
      }
      makerReports.push(`# ${username}\n${maker.content}`);
    }
    const makerSummary = makerReports.join('\n\n');

    await this.stateMachine.transition({
      runId: snapshot.id,
      to: 'verifying',
      actorType: 'worker',
      actorIdentity: this.workerId,
      leaseToken,
      eventType: 'run_verifying',
      title: 'Verification started',
      content: `Verifier ${snapshot.verifierUsername} is reviewing the reported result.`,
      correlationKey: `verifying:${snapshot.id}`,
      values: { currentRole: 'verifier', finalAnswer: makerSummary },
    });

    await this.budgets.reserve({
      runId: snapshot.id,
      patternId: snapshot.patternId,
      policy: snapshot.policy,
      delta: { verifications: 1 },
    });
    const outcome = await this.verification.verifyAndFinalize({
      runId: snapshot.id,
      goal: snapshot.goal,
      autonomyLevel: snapshot.autonomyLevel,
      verifierUsername: snapshot.verifierUsername,
      leaderUsername: snapshot.leaderUsername,
      makerUsernames: snapshot.makerUsernames,
      verifierHarness: snapshot.verifierHarness,
      policy: snapshot.policy,
      makerSummary,
      userId: snapshot.userId,
      workerId: this.workerId,
      leaseToken,
      signal,
    });

    if (outcome.finalStatus === 'failed') {
      await this.circuits.recordFailure({
        patternId: snapshot.patternId,
        scopeKey: `pattern:${snapshot.patternId}`,
        policy: snapshot.policy.circuit,
        error: new Error(`Verifier rejected run ${snapshot.id}.`),
        lastRunId: snapshot.id,
      });
      return;
    }
    await this.circuits.recordSuccess(snapshot.patternId, `pattern:${snapshot.patternId}`, snapshot.id);
  }

  private async acquirePaths(snapshot: RunSnapshot, leaseToken: string) {
    if (!snapshot.repositoryKey || !snapshot.actingOn.length) return true;
    const lock = await this.pathLocks.acquire({
      runId: snapshot.id,
      repositoryKey: snapshot.repositoryKey,
      owner: leaseToken,
      paths: snapshot.actingOn,
      ttlMs: PATH_LOCK_TTL_MS,
    });
    if (lock.acquired) {
      // Recorded before any work starts so the heartbeat renews this lock for as long as the run
      // executes, and the release in `execute` frees exactly the lock this worker took.
      this.heldPathLocks.set(snapshot.id, snapshot.repositoryKey);
      return true;
    }

    const deadlocked = lock.deadlocked;
    await this.stateMachine.transition({
      runId: snapshot.id,
      to: deadlocked ? 'blocked' : 'waiting_lock',
      actorType: 'worker',
      actorIdentity: this.workerId,
      leaseToken,
      eventType: deadlocked ? 'run_blocked' : 'run_waiting_lock',
      title: deadlocked ? 'Run blocked by a lock cycle' : 'Waiting for repository paths',
      content: `Blocked by run(s): ${lock.blockers.join(', ')}.`,
      correlationKey: `lock:${snapshot.id}:${lock.blockers.join('-')}`,
      values: deadlocked ? { blockedReason: 'Path lock wait graph contains a cycle.' } : {},
    });
    return false;
  }

  private async invokeRole(
    snapshot: RunSnapshot,
    input: {
      role: 'leader' | 'maker';
      username: string;
      harness: CompiledHarness;
      systemMessage: string;
      prompt: string;
      leaseToken: string;
      signal: AbortSignal;
    },
  ) {
    await this.budgets.reserve({
      runId: snapshot.id,
      patternId: snapshot.patternId,
      policy: snapshot.policy,
      delta: { invocations: 1 },
    });
    const sessionId = await this.runtime.createConversation({
      username: input.username,
      userId: snapshot.userId,
      runId: snapshot.id,
      title: snapshot.goal.slice(0, 200),
    });
    const step = await this.database.getRepository('agentLoopSteps').create({
      values: {
        runId: snapshot.id,
        runtimeVersion: 'control-plane-v2',
        sequence: await this.nextSequence(snapshot.id),
        role: input.role,
        kind: 'invocation',
        type: 'reasoning',
        employeeUsername: input.username,
        title: `${input.role} invocation`,
        inputHash: inputHash(input.prompt),
        status: 'running',
        startedAt: new Date(),
        createdAt: new Date(),
      },
    });

    const outcome = await this.runtime.invoke({
      username: input.username,
      sessionId,
      userId: snapshot.userId,
      systemMessage: input.systemMessage,
      harness: input.harness,
      prompt: input.prompt,
      signal: input.signal,
    });

    await this.database.getRepository('agentLoopSteps').update({
      filterByTk: read(step, 'id'),
      values: {
        status: outcome.interrupted.length ? 'waiting_user' : 'succeeded',
        output: { content: outcome.content },
        endedAt: new Date(),
      },
    });
    await this.database.getRepository('agentLoopRuns').update({
      filterByTk: snapshot.id,
      values: { sessionId: outcome.sessionId, messageId: outcome.messageId },
    });
    return outcome;
  }

  private async parkForApproval(snapshot: RunSnapshot, outcome: InvocationOutcome, leaseToken: string) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + snapshot.policy.actions.approvalTimeoutMs);
    const assignedToId = snapshot.policy.actions.approvalAssigneeIds[0] || snapshot.userId || null;
    for (const call of outcome.interrupted) {
      await this.database.getRepository('agentLoopActionApprovals').create({
        values: {
          runId: snapshot.id,
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          proposedInput: call.args,
          inputHash: inputHash(call.args),
          paths: snapshot.actingOn,
          policyDecision: { decision: 'ask', interruptId: call.interruptId },
          reason: `Tool "${call.toolName}" requires human approval under this pattern's policy.`,
          status: 'pending',
          assignedToId,
          requestedById: snapshot.userId || null,
          requestedAt: now,
          expiresAt,
          createdAt: now,
        },
      });
    }
    await this.stateMachine.transition({
      runId: snapshot.id,
      to: 'waiting_approval',
      actorType: 'worker',
      actorIdentity: this.workerId,
      leaseToken,
      eventType: 'run_waiting_approval',
      title: 'Waiting for action approval',
      content: `${outcome.interrupted.length} tool call(s) require approval.`,
      correlationKey: `approval:${snapshot.id}:${outcome.messageId}`,
      values: { approvalStatus: 'pending', messageId: outcome.messageId },
    });
  }

  private async failRun(runId: number, leaseToken: string, snapshot: RunSnapshot | null, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      if (snapshot) {
        await this.circuits.recordFailure({
          patternId: snapshot.patternId,
          scopeKey: `pattern:${snapshot.patternId}`,
          policy: snapshot.policy.circuit,
          error,
          lastRunId: runId,
        });
      }
      await this.stateMachine.transition({
        runId,
        to: 'failed',
        actorType: 'worker',
        actorIdentity: this.workerId,
        leaseToken,
        eventType: 'run_failed',
        title: 'Run failed',
        content: message,
        correlationKey: `failed:${runId}`,
        values: { summary: message },
      });
    } catch (transitionError) {
      this.app.logger.error(`[AgentOrchestrator] Loop run ${runId} could not be marked failed.`, {
        error: transitionError,
        cause: message,
      });
    }
  }

  private async nextSequence(runId: number) {
    const steps = await this.database.getRepository('agentLoopSteps').find({ filter: { runId } });
    return steps.length;
  }

  private snapshotFrom(run: Record<string, unknown>): RunSnapshot {
    const patternId = Number(run.patternId);
    if (!Number.isSafeInteger(patternId) || patternId <= 0) {
      throw new Error('The claimed run has no pattern snapshot.');
    }
    const roleBindings = asObject(run.roleBindingsSnapshot);
    const makerSnapshots = asObject(run.makerHarnessSnapshot);
    return {
      id: Number(run.id),
      patternId,
      goal: String(run.goal || ''),
      autonomyLevel: autonomyLevel(run.autonomyLevel),
      policy: loopPatternPolicySchema.parse(run.policySnapshot),
      leaderUsername: String(roleBindings.leader || run.leaderUsername || ''),
      makerUsernames: asStringArray(roleBindings.makers),
      verifierUsername: String(roleBindings.verifier || run.verifierUsername || ''),
      leaderHarness: harnessFrom(run.leaderHarnessSnapshot),
      makerHarnesses: makerSnapshots as Record<string, { effective: CompiledHarness }>,
      verifierHarness: harnessFrom(run.verifierHarnessSnapshot),
      repositoryKey: String(run.repositoryKey || ''),
      actingOn: asStringArray(run.actingOn),
      userId: Number(run.userId) || undefined,
    };
  }
}
