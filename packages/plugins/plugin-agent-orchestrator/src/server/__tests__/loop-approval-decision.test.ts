import type { Database } from '@nocobase/database';
import type { Application } from '@nocobase/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compileHarness } from '../services/HarnessCompiler';
import type { CompiledHarness } from '../services/HarnessCompiler';
import { loopPatternPolicySchema } from '../services/LoopPatternSchema';

type Row = Record<string, unknown>;

type InvokeCall = { username: string; prompt: string; harness: CompiledHarness };
type ResumeCall = {
  username: string;
  sessionId: string;
  messageId: string;
  decisions: Array<{ toolCallId: string; decision: { type: string; message?: string; editedAction?: unknown } }>;
};
type ResumeOutcome = {
  sessionId: string;
  messageId: string;
  interrupted: Array<{ toolCallId: string; toolName: string; args: unknown; interruptId: string }>;
  content: string;
};

const invokeCalls: InvokeCall[] = [];
const resumeCalls: ResumeCall[] = [];
let resumeOutcome: ResumeOutcome = { sessionId: 'session-1', messageId: 'message-2', interrupted: [], content: '' };

vi.mock('../services/PluginAiRuntimeAdapter', () => ({
  PluginAiRuntimeAdapter: class {
    async createConversation() {
      return 'session-1';
    }
    async invoke(input: InvokeCall) {
      invokeCalls.push(input);
      return { sessionId: 'session-1', messageId: 'message-1', interrupted: [], content: `${input.username} done` };
    }
    async resume(input: ResumeCall) {
      resumeCalls.push(input);
      return resumeOutcome;
    }
  },
}));

vi.mock('../services/VerificationService', () => ({
  VerificationService: class {
    async verifyAndFinalize() {
      return { verdict: { verdict: 'pass' }, finalStatus: 'succeeded' as const };
    }
  },
}));

const { LoopRunRepository } = await import('../services/LoopRunRepository');
const { LoopWorkerService } = await import('../services/LoopWorkerService');

class MemoryRepository {
  private nextId = 1;

  constructor(readonly rows: Row[] = []) {
    this.nextId = rows.reduce((maximum, row) => Math.max(maximum, Number(row.id) || 0), 0) + 1;
  }

  async find(options: Row = {}) {
    const filter = (options.filter as Row | undefined) || {};
    return this.rows.filter((row) => Object.entries(filter).every(([key, value]) => row[key] === value));
  }

  async findOne(options: Row) {
    if (options.filterByTk !== undefined) return this.rows.find((row) => row.id === options.filterByTk) || null;
    return (await this.find(options))[0] || null;
  }

  async create(options: Row) {
    const row = { id: this.nextId++, ...((options.values as Row | undefined) || {}) };
    this.rows.push(row);
    return row;
  }

  async update(options: Row) {
    const values = (options.values as Row | undefined) || {};
    for (const row of this.rows) {
      if (row.id === options.filterByTk) Object.assign(row, values);
    }
  }
}

function createDatabase(repositories: Map<string, MemoryRepository>) {
  return {
    getRepository(name: string) {
      const repository = repositories.get(name);
      if (!repository) throw new Error(`Unexpected repository ${name}`);
      return repository;
    },
    sequelize: {
      transaction<T>(callback: (value: { LOCK: { UPDATE: string } }) => Promise<T>) {
        return callback({ LOCK: { UPDATE: 'UPDATE' } });
      },
    },
  } as unknown as Database;
}

beforeEach(() => {
  invokeCalls.length = 0;
  resumeCalls.length = 0;
  resumeOutcome = { sessionId: 'session-1', messageId: 'message-2', interrupted: [], content: 'resumed done' };
});

function waitingRun(overrides: Row = {}) {
  return {
    id: 1,
    runtimeVersion: 'control-plane-v2',
    patternId: 1,
    userId: 7,
    status: 'waiting_approval',
    approvalStatus: 'pending',
    resumeContext: null,
    lockedBy: null,
    lockedUntil: null,
    ...overrides,
  };
}

function pendingApproval(overrides: Row = {}) {
  return {
    id: 10,
    runId: 1,
    toolCallId: 'call-1',
    toolName: 'editFile',
    inputHash: 'hash-1',
    status: 'pending',
    assignedToId: null,
    expiresAt: new Date(Date.now() + 3_600_000),
    consumedAt: null,
    decisionNote: null,
    editedInput: undefined,
    ...overrides,
  };
}

describe('LoopRunRepository.decideApproval', () => {
  function setup(runs: Row[], approvals: Row[]) {
    const repositories = new Map<string, MemoryRepository>([
      ['agentLoopRuns', new MemoryRepository(runs)],
      ['agentLoopActionApprovals', new MemoryRepository(approvals)],
      ['agentLoopEvents', new MemoryRepository()],
    ]);
    return { repositories, repository: new LoopRunRepository(createDatabase(repositories)) };
  }

  it('records the decision and requeues the run once every approval is decided', async () => {
    const { repositories, repository } = setup(
      [waitingRun()],
      [pendingApproval({ id: 10, status: 'approved', consumedAt: null }), pendingApproval({ id: 11 })],
    );

    const result = await repository.decideApproval({
      approvalId: 11,
      userId: 7,
      isAdmin: false,
      decision: 'approved',
      note: 'looks safe',
    });

    expect(result).toMatchObject({ status: 'approved', decidedById: 7, requeued: true });
    expect(repositories.get('agentLoopRuns')?.rows[0]).toMatchObject({ status: 'queued', approvalStatus: 'decided' });
    const decided = repositories.get('agentLoopActionApprovals')?.rows.find((row) => row.id === 11);
    expect(decided).toMatchObject({ status: 'approved', decidedById: 7, decisionNote: 'looks safe' });
    expect(decided?.decidedAt).toBeInstanceOf(Date);

    const events = repositories.get('agentLoopEvents')?.rows || [];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ runId: 1, type: 'run_approval_decided', actorType: 'human' });
  });

  it('records the decision but keeps the run parked while approvals remain pending', async () => {
    const { repositories, repository } = setup(
      [waitingRun()],
      [pendingApproval({ id: 10 }), pendingApproval({ id: 11 })],
    );

    const result = await repository.decideApproval({ approvalId: 10, userId: 7, isAdmin: false, decision: 'rejected' });

    expect(result).toMatchObject({ status: 'rejected', requeued: false });
    expect(repositories.get('agentLoopRuns')?.rows[0].status).toBe('waiting_approval');
    expect(repositories.get('agentLoopEvents')?.rows).toHaveLength(0);
  });

  it('stores editedInput only for approvals', async () => {
    const { repositories, repository } = setup([waitingRun()], [pendingApproval()]);

    await repository.decideApproval({
      approvalId: 10,
      userId: 7,
      isAdmin: false,
      decision: 'approved',
      editedInput: { path: '/tmp/safe.txt' },
    });

    expect(repositories.get('agentLoopActionApprovals')?.rows[0].editedInput).toEqual({ path: '/tmp/safe.txt' });
  });

  it('rejects a decision on an approval that is already decided', async () => {
    const { repository } = setup([waitingRun()], [pendingApproval({ status: 'approved' })]);

    await expect(
      repository.decideApproval({ approvalId: 10, userId: 7, isAdmin: false, decision: 'rejected' }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('rejects a decision once the approval window has expired', async () => {
    const { repositories, repository } = setup(
      [waitingRun()],
      [pendingApproval({ expiresAt: new Date(Date.now() - 1_000) })],
    );

    await expect(
      repository.decideApproval({ approvalId: 10, userId: 7, isAdmin: false, decision: 'approved' }),
    ).rejects.toMatchObject({ status: 409 });
    // Fail closed: the row stays pending for the reaper to expire, a late click cannot revive it.
    expect(repositories.get('agentLoopActionApprovals')?.rows[0].status).toBe('pending');
  });

  it('rejects a decision once the run has moved on', async () => {
    const { repository } = setup([waitingRun({ status: 'running' })], [pendingApproval()]);

    await expect(
      repository.decideApproval({ approvalId: 10, userId: 7, isAdmin: false, decision: 'approved' }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('records decisions for a paused run without requeueing it', async () => {
    const { repositories, repository } = setup([waitingRun({ status: 'paused' })], [pendingApproval()]);

    const result = await repository.decideApproval({
      approvalId: 10,
      userId: 7,
      isAdmin: false,
      decision: 'approved',
    });

    expect(result).toMatchObject({ status: 'approved', requeued: false });
    expect(repositories.get('agentLoopRuns')?.rows[0].status).toBe('paused');
  });

  it('refuses decisions from users who own neither the run nor the approval', async () => {
    const { repository } = setup([waitingRun()], [pendingApproval({ assignedToId: 8 })]);

    await expect(
      repository.decideApproval({ approvalId: 10, userId: 9, isAdmin: false, decision: 'approved' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('lets the assigned approver decide even without owning the run', async () => {
    const { repository } = setup([waitingRun()], [pendingApproval({ assignedToId: 8 })]);

    const result = await repository.decideApproval({
      approvalId: 10,
      userId: 8,
      isAdmin: false,
      decision: 'approved',
    });

    expect(result).toMatchObject({ status: 'approved', decidedById: 8 });
  });
});

describe('LoopWorkerService approval resume-mode', () => {
  type WorkerInternals = { execute(claimed: { run: Row; leaseToken: string; leaseUntil: Date }): Promise<void> };

  function harnessSnapshot(allow: string[]) {
    return { effective: compileHarness([{ source: 'test', settings: { tools: { allow } } }]) };
  }

  const policy = loopPatternPolicySchema.parse({ maxConcurrency: 1 });

  function createWorker(run: Row, approvals: Row[] = []) {
    const repositories = new Map<string, MemoryRepository>([
      [
        'agentLoopControlSettings',
        new MemoryRepository([
          { id: 1, key: 'global', state: 'running', acceptNewRuns: true, globalMaxConcurrency: 5 },
        ]),
      ],
      ['agentLoopRuns', new MemoryRepository([{ ...run }])],
      ['agentLoopActionApprovals', new MemoryRepository(approvals)],
      ['agentLoopEvents', new MemoryRepository()],
      ['agentLoopSteps', new MemoryRepository()],
      ['aiMessages', new MemoryRepository()],
      ['agentLoopUsageBuckets', new MemoryRepository()],
      ['agentLoopCircuitStates', new MemoryRepository()],
      ['agentLoopPathLocks', new MemoryRepository()],
      ['agentLoopArtifacts', new MemoryRepository()],
    ]);
    const app = {
      name: 'test',
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
      log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
      lockManager: { runExclusive: <T>(_key: string, operation: () => Promise<T>) => operation() },
    };
    const worker = new LoopWorkerService(app as unknown as Application, createDatabase(repositories));
    return { repositories, worker: worker as unknown as WorkerInternals };
  }

  function resumedRun(overrides: Row = {}) {
    return {
      id: 1,
      runtimeVersion: 'control-plane-v2',
      patternId: 1,
      userId: 7,
      status: 'preparing',
      lockedBy: 'worker-a:lease',
      lockedUntil: new Date(Date.now() + 60_000),
      goal: 'Ship the feature',
      autonomyLevel: 'L1',
      policySnapshot: policy,
      roleBindingsSnapshot: { leader: 'lead', makers: ['maker-one', 'maker-two'], verifier: 'checker' },
      leaderHarnessSnapshot: harnessSnapshot(['readFile']),
      makerHarnessSnapshot: {
        'maker-one': harnessSnapshot(['editFile']),
        'maker-two': harnessSnapshot(['runTests']),
      },
      verifierHarnessSnapshot: harnessSnapshot(['readFile']),
      repositoryKey: '',
      actingOn: [],
      approvalStatus: 'decided',
      resumeContext: {
        role: 'maker',
        username: 'maker-one',
        sessionId: 'session-1',
        messageId: 'message-1',
        makerReports: ['the leader plan'],
        makerQueue: ['maker-two'],
      },
      ...overrides,
    };
  }

  function claimed(run: Row) {
    return { run, leaseToken: 'worker-a:lease', leaseUntil: new Date(Date.now() + 60_000) };
  }

  it('resumes the interrupted role instead of restarting from the leader', async () => {
    const run = resumedRun();
    const { repositories, worker } = createWorker(run, [
      pendingApproval({ status: 'approved', decidedById: 7, consumedAt: null }),
    ]);

    await worker.execute(claimed(run));

    expect(resumeCalls).toHaveLength(1);
    expect(resumeCalls[0]).toMatchObject({
      username: 'maker-one',
      sessionId: 'session-1',
      messageId: 'message-1',
      decisions: [{ toolCallId: 'call-1', decision: { type: 'approve' } }],
    });
    // Only the makers still queued run; the leader and completed makers are not re-invoked.
    expect(invokeCalls.map((call) => call.username)).toEqual(['maker-two']);
    expect(repositories.get('agentLoopRuns')?.rows[0].status).toBe('verifying');
  });

  it('maps edited and rejected approvals onto plugin-ai decisions', async () => {
    const run = resumedRun();
    const { worker } = createWorker(run, [
      pendingApproval({
        id: 10,
        toolCallId: 'call-1',
        status: 'approved',
        editedInput: { path: '/tmp/safe.txt' },
        consumedAt: null,
      }),
      pendingApproval({
        id: 11,
        toolCallId: 'call-2',
        status: 'rejected',
        decisionNote: 'too risky',
        consumedAt: null,
      }),
    ]);

    await worker.execute(claimed(run));

    expect(resumeCalls[0].decisions).toEqual([
      {
        toolCallId: 'call-1',
        decision: { type: 'edit', editedAction: { name: 'editFile', args: { path: '/tmp/safe.txt' } } },
      },
      { toolCallId: 'call-2', decision: { type: 'reject', message: 'too risky' } },
    ]);
  });

  it('consumes each decision exactly once', async () => {
    const run = resumedRun();
    const { repositories, worker } = createWorker(run, [pendingApproval({ status: 'approved', consumedAt: null })]);

    await worker.execute(claimed(run));

    const approval = repositories.get('agentLoopActionApprovals')?.rows[0];
    expect(approval?.consumedAt).toBeInstanceOf(Date);
  });

  it('parks again with the same resume point when the resumed call hits another gate', async () => {
    resumeOutcome = {
      sessionId: 'session-1',
      messageId: 'message-3',
      interrupted: [{ toolCallId: 'call-9', toolName: 'runShell', args: { cmd: 'rm' }, interruptId: 'int-9' }],
      content: '',
    };
    const run = resumedRun();
    const { repositories, worker } = createWorker(run, [pendingApproval({ status: 'approved', consumedAt: null })]);

    await worker.execute(claimed(run));

    const row = repositories.get('agentLoopRuns')?.rows[0];
    expect(row?.status).toBe('waiting_approval');
    expect(row?.approvalStatus).toBe('pending');
    // The queue and reports survive the second gate, so the next resume continues in place.
    expect(row?.resumeContext).toMatchObject({
      role: 'maker',
      username: 'maker-one',
      messageId: 'message-3',
      makerQueue: ['maker-two'],
      makerReports: ['the leader plan'],
    });
    const approvals = repositories.get('agentLoopActionApprovals')?.rows || [];
    expect(approvals.filter((approval) => approval.status === 'pending')).toHaveLength(1);
    expect(approvals[approvals.length - 1]).toMatchObject({ toolCallId: 'call-9' });
  });

  it('tags approvals for escalatable tools as escalations', async () => {
    resumeOutcome = {
      sessionId: 'session-1',
      messageId: 'message-3',
      interrupted: [
        { toolCallId: 'call-9', toolName: 'runShell', args: { cmd: 'ls' }, interruptId: 'int-9' },
        { toolCallId: 'call-10', toolName: 'editFile', args: { path: '/tmp/x' }, interruptId: 'int-10' },
      ],
      content: '',
    };
    const run = resumedRun({
      makerHarnessSnapshot: {
        'maker-one': {
          // runShell is not granted but escalatable; editFile is granted yet still ask-gated here
          // because the interrupted call reached the approval gate through the plan.
          effective: compileHarness([
            { source: 'test', settings: { tools: { allow: ['editFile'], escalate: ['runShell'] } } },
          ]),
        },
        'maker-two': harnessSnapshot(['runTests']),
      },
    });
    const { repositories, worker } = createWorker(run, [pendingApproval({ status: 'approved', consumedAt: null })]);

    await worker.execute(claimed(run));

    const approvals = repositories.get('agentLoopActionApprovals')?.rows || [];
    const escalation = approvals.find((approval) => approval.toolCallId === 'call-9');
    const plain = approvals.find((approval) => approval.toolCallId === 'call-10');
    expect(escalation).toMatchObject({
      actionType: 'escalation',
      toolName: 'runShell',
      status: 'pending',
    });
    expect(String(escalation?.reason)).toContain('widens authority for this single call only');
    expect(plain).toMatchObject({ actionType: 'tool_call', toolName: 'editFile' });
    expect(String(plain?.reason)).toContain('requires human approval');
  });

  it('re-parks a requeued run whose decisions never arrived', async () => {
    const run = resumedRun({ approvalStatus: 'pending' });
    const { repositories, worker } = createWorker(run, [pendingApproval()]);

    await worker.execute(claimed(run));

    expect(resumeCalls).toHaveLength(0);
    expect(invokeCalls).toHaveLength(0);
    expect(repositories.get('agentLoopRuns')?.rows[0].status).toBe('waiting_approval');
  });

  it('ignores a stale resume context left behind by an expired window', async () => {
    // The reaper blocks expired runs; a later retry clears approvalStatus to null. Either way the
    // saved context must not replay an old conversation, so the run starts fresh from the leader.
    const run = resumedRun({ approvalStatus: 'expired' });
    const { worker } = createWorker(run, []);

    await worker.execute(claimed(run));

    expect(resumeCalls).toHaveLength(0);
    expect(invokeCalls.map((call) => call.username)).toEqual(['lead', 'maker-one', 'maker-two']);
  });

  it('resumes the leader into a full maker pass', async () => {
    const run = resumedRun({
      resumeContext: {
        role: 'leader',
        username: 'lead',
        sessionId: 'session-1',
        messageId: 'message-1',
        makerReports: [],
        makerQueue: ['maker-one', 'maker-two'],
      },
    });
    resumeOutcome = { sessionId: 'session-1', messageId: 'message-2', interrupted: [], content: 'the resumed plan' };
    const { worker } = createWorker(run, [pendingApproval({ status: 'approved', consumedAt: null })]);

    await worker.execute(claimed(run));

    expect(resumeCalls).toHaveLength(1);
    expect(invokeCalls.map((call) => call.username)).toEqual(['maker-one', 'maker-two']);
    // The resumed leader content replaces the plan handed to the makers.
    expect(invokeCalls[0].prompt).toContain('the resumed plan');
  });
});
