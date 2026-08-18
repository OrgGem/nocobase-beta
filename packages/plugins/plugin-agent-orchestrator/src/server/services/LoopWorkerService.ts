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
import type { InvocationOutcome, ToolCallDecision } from './PluginAiRuntimeAdapter';
import { ToolLoopDetectionService, toolLoopNotice, toolLoopReason } from './ToolLoopDetectionService';
import { VerificationService } from './VerificationService';

const POLL_INTERVAL_MS = 3_000;
const LEASE_MS = 120_000;
const HEARTBEAT_MS = 30_000;
const PATH_LOCK_TTL_MS = 900_000;

const LEADER_SYSTEM_MESSAGE =
  'You lead an autonomous run. Break the goal into concrete work for your makers, then finish with a concise plan of what must be built and which evidence will prove it. You do not modify anything yourself.';
const MAKER_SYSTEM_MESSAGE =
  'You are a maker on an autonomous run. Do the work assigned by the leader using only the tools you were granted, and report exactly what you changed and the evidence for it.';

export type LoopWorkerSyncMessage = {
  type: 'loop-run-abort-requested';
  runId: number;
};

export function loopWorkerAbortMessage(runId: number): LoopWorkerSyncMessage {
  return { type: 'loop-run-abort-requested', runId };
}

type ResumeContext = {
  role: 'leader' | 'maker';
  username: string;
  sessionId: string;
  messageId: string;
  makerReports: string[];
  makerQueue: string[];
};

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
  approvalStatus: string;
  resumeContext: ResumeContext | null;
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

function resumeContextFrom(value: unknown): ResumeContext | null {
  const context = asObject(value);
  if (!context) return null;
  const role = context.role === 'leader' || context.role === 'maker' ? context.role : null;
  const username = typeof context.username === 'string' ? context.username : '';
  const sessionId = typeof context.sessionId === 'string' ? context.sessionId : '';
  const messageId = typeof context.messageId === 'string' ? context.messageId : '';
  if (!role || !username || !sessionId || !messageId) return null;
  return {
    role,
    username,
    sessionId,
    messageId,
    makerReports: asStringArray(context.makerReports),
    makerQueue: asStringArray(context.makerQueue),
  };
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
  private readonly loopGuard: ToolLoopDetectionService;
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
    this.loopGuard = new ToolLoopDetectionService(database);
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
    await this.stateMachine.expireOverdueApprovals(new Date()).catch((error) => {
      this.app.logger.error('[AgentOrchestrator] Approval expiry sweep failed.', { error });
    });
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

    // A run requeued from a pause while its approvals are still pending has nothing to execute:
    // the decisions never arrived, so it parks again instead of restarting from the leader.
    if (snapshot.resumeContext && snapshot.approvalStatus === 'pending') {
      await this.stateMachine.transition({
        runId: snapshot.id,
        to: 'waiting_approval',
        actorType: 'worker',
        actorIdentity: this.workerId,
        leaseToken,
        eventType: 'run_waiting_approval',
        title: 'Waiting for action approval',
        content: 'Run requeued while its approval decisions are still pending.',
        correlationKey: `approval-repark:${snapshot.id}`,
        values: { approvalStatus: 'pending' },
      });
      return;
    }

    await this.stateMachine.transition({
      runId: snapshot.id,
      to: 'running',
      actorType: 'worker',
      actorIdentity: this.workerId,
      leaseToken,
      eventType: 'run_started',
      title: snapshot.resumeContext ? 'Run resumed' : 'Run started',
      content: snapshot.resumeContext
        ? `${snapshot.resumeContext.username} resumed after approval decisions.`
        : `Leader ${snapshot.leaderUsername} began working on the goal.`,
      correlationKey: `started:${snapshot.id}`,
      values: { currentRole: snapshot.resumeContext ? snapshot.resumeContext.role : 'leader' },
    });

    // Loops recorded before this claim (for example before a park for approval) keep warning the
    // prompts composed later in the run.
    const loopNotices = await this.loopGuard.existingNotices(snapshot.id);

    let makerReports: string[];
    let makerQueue: string[];

    if (snapshot.resumeContext) {
      const resume = snapshot.resumeContext;
      const decisions = await this.consumeDecisions(snapshot.id);
      const resumed = await this.resumeRole(snapshot, resume, decisions, signal);

      const resumeGuard = await this.enforceToolLoopGuard(
        snapshot,
        leaseToken,
        { role: resume.role, username: resume.username },
        loopNotices,
      );
      if (resumeGuard === 'halt') return;

      // A resumed conversation can hit another approval gate; park with the same role context so
      // the next resume continues exactly where this one stopped.
      if (resumed.interrupted.length) {
        await this.parkForApproval(snapshot, resumed, leaseToken, {
          role: resume.role,
          username: resume.username,
          makerReports: resume.makerReports,
          makerQueue: resume.makerQueue,
        });
        return;
      }
      if (resume.role === 'leader') {
        makerReports = [resumed.content];
        makerQueue = [...snapshot.makerUsernames];
      } else {
        makerReports = [...resume.makerReports, `# ${resume.username}\n${resumed.content}`];
        makerQueue = [...resume.makerQueue];
      }
    } else {
      const leader = await this.invokeRole(snapshot, {
        role: 'leader',
        username: snapshot.leaderUsername,
        harness: snapshot.leaderHarness,
        systemMessage: LEADER_SYSTEM_MESSAGE,
        prompt: snapshot.goal,
        leaseToken,
        signal,
      });

      const leaderGuard = await this.enforceToolLoopGuard(
        snapshot,
        leaseToken,
        { role: 'leader', username: snapshot.leaderUsername },
        loopNotices,
      );
      if (leaderGuard === 'halt') return;

      // plugin-ai stops the graph on an approval-gated tool. Approval is a human decision, so the
      // run parks here instead of the worker deciding on the operator's behalf.
      if (leader.interrupted.length) {
        await this.parkForApproval(snapshot, leader, leaseToken, {
          role: 'leader',
          username: snapshot.leaderUsername,
          makerReports: [],
          makerQueue: snapshot.makerUsernames,
        });
        return;
      }
      makerReports = [leader.content];
      makerQueue = [...snapshot.makerUsernames];
    }

    // Each maker executes with its own compiled harness snapshot. Reusing one harness would apply
    // the wrong per-employee tool grants, so the snapshot is looked up by username and a maker with
    // no snapshot is a compile error, not a silent skip.
    while (makerQueue.length) {
      const username = makerQueue[0];
      const harness = snapshot.makerHarnesses[username]?.effective;
      if (!harness) {
        throw new Error(`The claimed run has no harness snapshot for maker "${username}".`);
      }
      const maker = await this.invokeRole(snapshot, {
        role: 'maker',
        username,
        harness,
        systemMessage: MAKER_SYSTEM_MESSAGE,
        prompt: [
          `Goal: ${snapshot.goal}`,
          '',
          "Leader's plan:",
          makerReports[0] || '(the leader produced no textual plan)',
          ...loopNotices,
        ].join('\n'),
        leaseToken,
        signal,
      });
      const makerGuard = await this.enforceToolLoopGuard(
        snapshot,
        leaseToken,
        { role: 'maker', username },
        loopNotices,
      );
      if (makerGuard === 'halt') return;
      if (maker.interrupted.length) {
        await this.parkForApproval(snapshot, maker, leaseToken, {
          role: 'maker',
          username,
          makerReports,
          makerQueue: makerQueue.slice(1),
        });
        return;
      }
      makerReports.push(`# ${username}\n${maker.content}`);
      makerQueue = makerQueue.slice(1);
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
      loopNotices,
      signal,
    });

    // The tool loop guard already moved the run to blocked or waiting_human; the circuit breaker
    // tracks failed attempts, not behavioral stops, so it must not see this as a failure.
    if (outcome.finalStatus === 'halted') return;

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
        sessionId,
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

  private async resumeRole(
    snapshot: RunSnapshot,
    resume: ResumeContext,
    decisions: Array<{ toolCallId: string; decision: ToolCallDecision }>,
    signal: AbortSignal,
  ) {
    await this.budgets.reserve({
      runId: snapshot.id,
      patternId: snapshot.patternId,
      policy: snapshot.policy,
      delta: { invocations: 1 },
    });
    const harness =
      resume.role === 'leader' ? snapshot.leaderHarness : snapshot.makerHarnesses[resume.username]?.effective;
    if (!harness) {
      throw new Error(`The claimed run has no harness snapshot for ${resume.role} "${resume.username}".`);
    }
    const step = await this.database.getRepository('agentLoopSteps').create({
      values: {
        runId: snapshot.id,
        runtimeVersion: 'control-plane-v2',
        sequence: await this.nextSequence(snapshot.id),
        role: resume.role,
        kind: 'invocation',
        type: 'resume',
        employeeUsername: resume.username,
        sessionId: resume.sessionId,
        title: `${resume.role} resume after approval`,
        inputHash: inputHash(decisions),
        status: 'running',
        startedAt: new Date(),
        createdAt: new Date(),
      },
    });

    const outcome = await this.runtime.resume({
      username: resume.username,
      sessionId: resume.sessionId,
      messageId: resume.messageId,
      userId: snapshot.userId,
      systemMessage: resume.role === 'leader' ? LEADER_SYSTEM_MESSAGE : MAKER_SYSTEM_MESSAGE,
      harness,
      decisions,
      signal,
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

  // Run-level scan over every tool call issued so far, evaluated at each pass boundary. A warning
  // is injected into the prompts composed later in the run; block and escalate halt it at once.
  private async enforceToolLoopGuard(
    snapshot: RunSnapshot,
    leaseToken: string,
    pass: { role: 'leader' | 'maker'; username: string },
    loopNotices: string[],
  ): Promise<'continue' | 'halt'> {
    const finding = await this.loopGuard.scanRun(snapshot.id, snapshot.policy);
    if (!finding) return 'continue';

    await this.loopGuard.recordFinding(
      {
        runId: snapshot.id,
        role: pass.role,
        username: pass.username,
        runStatus: 'running',
        actorType: 'worker',
        actorIdentity: this.workerId,
      },
      finding,
    );

    if (finding.level === 'warn') {
      const notice = toolLoopNotice(finding.toolName, finding.count);
      if (!loopNotices.includes(notice)) loopNotices.push(notice);
      return 'continue';
    }

    const reason = toolLoopReason(finding);
    await this.stateMachine.transition({
      runId: snapshot.id,
      to: finding.level === 'block' ? 'blocked' : 'waiting_human',
      actorType: 'worker',
      actorIdentity: this.workerId,
      leaseToken,
      eventType: finding.level === 'block' ? 'run_blocked' : 'run_escalated',
      title: finding.level === 'block' ? 'Run blocked by tool loop detection' : 'Run escalated by tool loop detection',
      content: reason,
      correlationKey: `tool-loop-${finding.level}:${snapshot.id}:${finding.signature}`,
      values: finding.level === 'block' ? { blockedReason: reason } : { escalationReason: reason },
    });
    return 'halt';
  }

  // Decisions are consumed exactly once: rows are marked consumed so a retry or a second resume
  // can never replay a human decision against a fresh conversation.
  private async consumeDecisions(runId: number) {
    const repository = this.database.getRepository('agentLoopActionApprovals');
    const approvals = await repository.find({ filter: { runId } });
    const decisions: Array<{ toolCallId: string; decision: ToolCallDecision }> = [];
    const now = new Date();
    for (const approval of approvals) {
      const status = String(read(approval, 'status'));
      if (status !== 'approved' && status !== 'rejected') continue;
      if (read(approval, 'consumedAt')) continue;
      const editedInput = read(approval, 'editedInput');
      const decision: ToolCallDecision =
        status === 'approved'
          ? editedInput
            ? { type: 'edit', editedAction: { name: String(read(approval, 'toolName')), args: editedInput } }
            : { type: 'approve' }
          : { type: 'reject', message: String(read(approval, 'decisionNote') || '') || undefined };
      decisions.push({ toolCallId: String(read(approval, 'toolCallId')), decision });
      await repository.update({ filterByTk: Number(read(approval, 'id')), values: { consumedAt: now } });
    }
    if (!decisions.length) throw new Error('The resumed run has no recorded approval decisions.');
    return decisions;
  }

  private async parkForApproval(
    snapshot: RunSnapshot,
    outcome: InvocationOutcome,
    leaseToken: string,
    context: { role: 'leader' | 'maker'; username: string; makerReports: string[]; makerQueue: string[] },
  ) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + snapshot.policy.actions.approvalTimeoutMs);
    const assignedToId = snapshot.policy.actions.approvalAssigneeIds[0] || snapshot.userId || null;
    const harness =
      context.role === 'leader' ? snapshot.leaderHarness : snapshot.makerHarnesses[context.username]?.effective;
    const escalatable = new Set(harness?.tools.escalate ?? []);
    for (const call of outcome.interrupted) {
      // An escalation is a request for authority the harness never granted, widened for exactly
      // one call; a plain tool_call approval gates a tool the harness allows but asks about.
      const escalation = escalatable.has(call.toolName);
      await this.database.getRepository('agentLoopActionApprovals').create({
        values: {
          runId: snapshot.id,
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          actionType: escalation ? 'escalation' : 'tool_call',
          proposedInput: call.args,
          inputHash: inputHash(call.args),
          paths: snapshot.actingOn,
          policyDecision: { decision: 'ask', interruptId: call.interruptId },
          reason: escalation
            ? `Tool "${call.toolName}" is not granted by this run's harness. Approving widens authority for this single call only.`
            : `Tool "${call.toolName}" requires human approval under this pattern's policy.`,
          status: 'pending',
          assignedToId,
          requestedById: snapshot.userId || null,
          requestedAt: now,
          expiresAt,
          createdAt: now,
        },
      });
    }
    await this.database.getRepository('agentLoopRuns').update({
      filterByTk: snapshot.id,
      values: {
        // The resume point is durable: which role stopped, in which conversation, with which
        // reports already collected and which makers still queued. Without it a resumed run
        // would restart from the leader and redo every completed invocation.
        resumeContext: {
          role: context.role,
          username: context.username,
          sessionId: outcome.sessionId,
          messageId: outcome.messageId,
          makerReports: context.makerReports,
          makerQueue: context.makerQueue,
        },
      },
    });
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
    const approvalStatus = String(run.approvalStatus || 'none');
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
      approvalStatus,
      // Only a live approval state may resume. Stale context left over from an expired window or a
      // cleared retry would otherwise replay an old conversation against fresh approvals.
      resumeContext:
        approvalStatus === 'decided' || approvalStatus === 'pending' ? resumeContextFrom(run.resumeContext) : null,
    };
  }
}
