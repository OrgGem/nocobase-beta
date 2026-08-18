import type { Database } from '@nocobase/database';
import type { Application } from '@nocobase/server';
import { describe, expect, it, vi } from 'vitest';
import { compileHarness } from '../services/HarnessCompiler';
import { loopPatternPolicySchema } from '../services/LoopPatternSchema';

type Row = Record<string, unknown>;

vi.mock('../services/PluginAiRuntimeAdapter', () => ({
  PluginAiRuntimeAdapter: class {
    async createConversation() {
      return 'session-1';
    }
    async invoke() {
      return { sessionId: 'session-1', messageId: 'message-1', interrupted: [], content: 'done' };
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

const { LoopRunStateMachine } = await import('../services/LoopRunStateMachine');
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

function waitingRun(overrides: Row = {}) {
  return {
    id: 1,
    runtimeVersion: 'control-plane-v2',
    patternId: 1,
    status: 'waiting_approval',
    approvalStatus: 'pending',
    lockedBy: null,
    lockedUntil: null,
    ...overrides,
  };
}

function approval(overrides: Row = {}) {
  return {
    id: 10,
    runId: 1,
    toolCallId: 'call-1',
    toolName: 'editFile',
    inputHash: 'hash-1',
    status: 'pending',
    expiresAt: new Date(Date.now() - 1_000),
    ...overrides,
  };
}

function createStateMachine(runs: Row[], approvals: Row[]) {
  const repositories = new Map<string, MemoryRepository>([
    ['agentLoopRuns', new MemoryRepository(runs)],
    ['agentLoopActionApprovals', new MemoryRepository(approvals)],
    ['agentLoopEvents', new MemoryRepository()],
  ]);
  return { repositories, stateMachine: new LoopRunStateMachine(createDatabase(repositories)) };
}

describe('LoopRunStateMachine.expireOverdueApprovals', () => {
  it('blocks the run and expires approvals whose window has passed', async () => {
    const { repositories, stateMachine } = createStateMachine([waitingRun()], [approval()]);

    const blocked = await stateMachine.expireOverdueApprovals(new Date());

    // Fail closed: an unanswered approval must never turn into a continuation. The run parks in
    // `blocked` for a human retry, it does not requeue itself.
    expect(blocked).toEqual([1]);
    expect(repositories.get('agentLoopRuns')?.rows[0]).toMatchObject({
      status: 'blocked',
      approvalStatus: 'expired',
    });
    expect(String(repositories.get('agentLoopRuns')?.rows[0].blockedReason)).toContain('expired');
    expect(repositories.get('agentLoopActionApprovals')?.rows[0]).toMatchObject({ status: 'expired' });
    expect(repositories.get('agentLoopActionApprovals')?.rows[0].decidedAt).toBeInstanceOf(Date);

    const events = repositories.get('agentLoopEvents')?.rows || [];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ runId: 1, type: 'run_approval_expired', actorType: 'system' });
  });

  it('leaves approvals with time left untouched', async () => {
    const { repositories, stateMachine } = createStateMachine(
      [waitingRun()],
      [approval({ expiresAt: new Date(Date.now() + 60_000) })],
    );

    const blocked = await stateMachine.expireOverdueApprovals(new Date());

    expect(blocked).toEqual([]);
    expect(repositories.get('agentLoopRuns')?.rows[0].status).toBe('waiting_approval');
    expect(repositories.get('agentLoopActionApprovals')?.rows[0].status).toBe('pending');
  });

  it('never expires an approval that has no expiry configured', async () => {
    const { repositories, stateMachine } = createStateMachine([waitingRun()], [approval({ expiresAt: null })]);

    const blocked = await stateMachine.expireOverdueApprovals(new Date());

    expect(blocked).toEqual([]);
    expect(repositories.get('agentLoopActionApprovals')?.rows[0].status).toBe('pending');
  });

  it('does not expire approvals once the run has moved on', async () => {
    // A human pause races the reaper. The sweep only acts while the run is still parked in
    // `waiting_approval`; any other status means another path already owns the decision.
    const { repositories, stateMachine } = createStateMachine([waitingRun({ status: 'paused' })], [approval()]);

    const blocked = await stateMachine.expireOverdueApprovals(new Date());

    expect(blocked).toEqual([]);
    expect(repositories.get('agentLoopRuns')?.rows[0].status).toBe('paused');
    expect(repositories.get('agentLoopActionApprovals')?.rows[0].status).toBe('pending');
  });

  it('ignores historical plan-era runs', async () => {
    const { repositories, stateMachine } = createStateMachine(
      [waitingRun({ runtimeVersion: 'legacy-plan-v1' })],
      [approval()],
    );

    const blocked = await stateMachine.expireOverdueApprovals(new Date());

    expect(blocked).toEqual([]);
    expect(repositories.get('agentLoopRuns')?.rows[0].status).toBe('waiting_approval');
  });

  it('blocks only the runs whose approvals are overdue', async () => {
    const { repositories, stateMachine } = createStateMachine(
      [waitingRun({ id: 1 }), waitingRun({ id: 2 })],
      [approval({ id: 10, runId: 1 }), approval({ id: 11, runId: 2, expiresAt: new Date(Date.now() + 60_000) })],
    );

    const blocked = await stateMachine.expireOverdueApprovals(new Date());

    expect(blocked).toEqual([1]);
    const runs = repositories.get('agentLoopRuns')?.rows || [];
    expect(runs.find((row) => row.id === 1)?.status).toBe('blocked');
    expect(runs.find((row) => row.id === 2)?.status).toBe('waiting_approval');
  });
});

describe('LoopWorkerService approval sweep wiring', () => {
  type WorkerInternals = { running: boolean; poll(): Promise<void> };

  function createWorker(runs: Row[], approvals: Row[]) {
    const policy = loopPatternPolicySchema.parse({ maxConcurrency: 1 });
    const harness = { effective: compileHarness([{ source: 'test', settings: { tools: { allow: ['readFile'] } } }]) };
    const repositories = new Map<string, MemoryRepository>([
      [
        'agentLoopControlSettings',
        new MemoryRepository([
          { id: 1, key: 'global', state: 'running', acceptNewRuns: true, globalMaxConcurrency: 5 },
        ]),
      ],
      [
        'agentLoopRuns',
        new MemoryRepository(
          runs.map((run) => ({
            patternId: 1,
            goal: 'goal',
            autonomyLevel: 'L1',
            policySnapshot: policy,
            roleBindingsSnapshot: { leader: 'lead', makers: [], verifier: 'checker' },
            leaderHarnessSnapshot: harness,
            makerHarnessSnapshot: {},
            verifierHarnessSnapshot: harness,
            repositoryKey: '',
            actingOn: [],
            ...run,
          })),
        ),
      ],
      ['agentLoopActionApprovals', new MemoryRepository(approvals)],
      ['agentLoopEvents', new MemoryRepository()],
      ['agentLoopPatterns', new MemoryRepository([{ id: 1, enabled: true }])],
      ['agentLoopSteps', new MemoryRepository()],
      ['agentLoopUsageBuckets', new MemoryRepository()],
      ['agentLoopCircuitStates', new MemoryRepository()],
      ['agentLoopPathLocks', new MemoryRepository()],
      ['agentLoopArtifacts', new MemoryRepository()],
    ]);
    const database = createDatabase(repositories);
    const app = {
      name: 'test',
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
      log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
      lockManager: { runExclusive: <T>(_key: string, operation: () => Promise<T>) => operation() },
    };
    const worker = new LoopWorkerService(app as unknown as Application, database);
    return { repositories, worker: worker as unknown as WorkerInternals };
  }

  it('expires overdue approvals on every poll before claiming new work', async () => {
    const { repositories, worker } = createWorker([waitingRun()], [approval()]);
    worker.running = true;

    await worker.poll();

    expect(repositories.get('agentLoopRuns')?.rows[0]).toMatchObject({
      status: 'blocked',
      approvalStatus: 'expired',
    });
    expect(repositories.get('agentLoopActionApprovals')?.rows[0].status).toBe('expired');
  });
});
