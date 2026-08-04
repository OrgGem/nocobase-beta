import type { Database } from '@nocobase/database';
import type { Application } from '@nocobase/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compileHarness } from '../services/HarnessCompiler';
import type { CompiledHarness } from '../services/HarnessCompiler';
import { loopPatternPolicySchema } from '../services/LoopPatternSchema';

type Row = Record<string, unknown>;

type InvokeCall = {
  username: string;
  systemMessage: string;
  prompt: string;
  harness: CompiledHarness;
};

const invokeCalls: InvokeCall[] = [];
const verifyCalls: Array<{ makerSummary: string; makerUsernames: string[] }> = [];
let onInvoke: ((call: InvokeCall) => Promise<void>) | null = null;

vi.mock('../services/PluginAiRuntimeAdapter', () => ({
  PluginAiRuntimeAdapter: class {
    async createConversation() {
      return 'session-1';
    }
    async invoke(input: InvokeCall) {
      invokeCalls.push(input);
      if (onInvoke) await onInvoke(input);
      return { sessionId: 'session-1', messageId: 'message-1', interrupted: [], content: `${input.username} done` };
    }
  },
}));

vi.mock('../services/VerificationService', () => ({
  VerificationService: class {
    async verifyAndFinalize(input: { makerSummary: string; makerUsernames: string[] }) {
      verifyCalls.push({ makerSummary: input.makerSummary, makerUsernames: input.makerUsernames });
      return { verdict: { verdict: 'pass' }, finalStatus: 'succeeded' as const };
    }
  },
}));

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

function harnessSnapshot(allow: string[]) {
  return { effective: compileHarness([{ source: 'test', settings: { tools: { allow } } }]) };
}

const policy = loopPatternPolicySchema.parse({ maxConcurrency: 1 });

function createWorker(run: Row) {
  const repositories = new Map<string, MemoryRepository>([
    [
      'agentLoopControlSettings',
      new MemoryRepository([{ id: 1, key: 'global', state: 'running', acceptNewRuns: true, globalMaxConcurrency: 5 }]),
    ],
    ['agentLoopRuns', new MemoryRepository([{ ...run }])],
    ['agentLoopEvents', new MemoryRepository()],
    ['agentLoopSteps', new MemoryRepository()],
    ['agentLoopUsageBuckets', new MemoryRepository()],
    ['agentLoopCircuitStates', new MemoryRepository()],
    ['agentLoopPathLocks', new MemoryRepository()],
    ['agentLoopArtifacts', new MemoryRepository()],
  ]);
  const database = {
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
  };
  const app = {
    name: 'test',
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    lockManager: { runExclusive: <T>(_key: string, operation: () => Promise<T>) => operation() },
  };
  const worker = new LoopWorkerService(app as unknown as Application, database as unknown as Database);
  return { repositories, worker: worker as unknown as WorkerInternals, service: worker };
}

type WorkerInternals = {
  execute(claimed: { run: Row; leaseToken: string; leaseUntil: Date }): Promise<void>;
  heartbeat(runId: number, leaseToken: string): Promise<void>;
};

function claimedRun(run: Row) {
  return { run, leaseToken: 'worker-a:lease', leaseUntil: new Date(Date.now() + 60_000) };
}

function baseRun(overrides: Row = {}) {
  return {
    id: 1,
    runtimeVersion: 'control-plane-v2',
    patternId: 1,
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
    ...overrides,
  };
}

beforeEach(() => {
  invokeCalls.length = 0;
  verifyCalls.length = 0;
  onInvoke = null;
});

describe('LoopWorkerService maker execution', () => {
  it('invokes every maker with its own compiled harness snapshot', async () => {
    const run = baseRun();
    const { worker } = createWorker(run);

    await worker.execute(claimedRun(run));

    // Before the fix the worker went leader -> verifier and `makerHarnessSnapshot` was never read,
    // so per-maker tool grants had no runtime effect at all.
    expect(invokeCalls.map((call) => call.username)).toEqual(['lead', 'maker-one', 'maker-two']);
    expect(invokeCalls[1].harness.tools.allow).toEqual(['editFile']);
    expect(invokeCalls[2].harness.tools.allow).toEqual(['runTests']);
    expect(invokeCalls[1].prompt).toContain('lead done');
  });

  it('aggregates every maker report into the summary handed to the verifier', async () => {
    const run = baseRun();
    const { worker } = createWorker(run);

    await worker.execute(claimedRun(run));

    expect(verifyCalls).toHaveLength(1);
    expect(verifyCalls[0].makerUsernames).toEqual(['maker-one', 'maker-two']);
    expect(verifyCalls[0].makerSummary).toContain('# maker-one');
    expect(verifyCalls[0].makerSummary).toContain('# maker-two');
  });

  it('fails the run when a bound maker has no harness snapshot', async () => {
    const run = baseRun({ makerHarnessSnapshot: { 'maker-one': harnessSnapshot(['editFile']) } });
    const { repositories, worker } = createWorker(run);

    await worker.execute(claimedRun(run));

    // A missing snapshot must not silently skip the maker: that would run the loop with fewer
    // participants than the pattern declared.
    expect(repositories.get('agentLoopRuns')?.rows[0].status).toBe('failed');
    expect(String(repositories.get('agentLoopRuns')?.rows[0].summary)).toContain('maker-two');
    expect(verifyCalls).toHaveLength(0);
  });
});

describe('LoopWorkerService path lock lifecycle', () => {
  it('renews the path lock on the same beat as the worker lease', async () => {
    const run = baseRun({ repositoryKey: 'repo', actingOn: ['src/a/**'] });
    const { repositories, worker } = createWorker(run);
    const renewedAt: Array<string | undefined> = [];

    onInvoke = async () => {
      const before = repositories.get('agentLoopPathLocks')?.rows[0];
      await worker.heartbeat(1, 'worker-a:lease');
      const after = repositories.get('agentLoopPathLocks')?.rows[0];
      renewedAt.push(String(after?.expiresAt));
      expect(String(after?.expiresAt)).not.toBe(String(before?.expiresAt));
      onInvoke = null;
    };

    await worker.execute(claimedRun(run));

    // The lock TTL is longer than the lease, but a run can outlive it. Without renewal the lock
    // lapses mid-run and another run becomes free to take the same paths.
    expect(renewedAt).toHaveLength(1);
    expect(repositories.get('agentLoopPathLocks')?.rows[0]).toMatchObject({ status: 'released' });
  });

  it('releases only the lock this worker still owns', async () => {
    const run = baseRun({ repositoryKey: 'repo', actingOn: ['src/a/**'] });
    const { repositories, worker } = createWorker(run);

    onInvoke = async () => {
      // Another worker reclaimed the run and re-took the lock while this one was mid-invocation.
      const lock = repositories.get('agentLoopPathLocks')?.rows[0];
      if (lock) lock.owner = 'worker-b:lease';
      onInvoke = null;
    };

    await worker.execute(claimedRun(run));

    expect(repositories.get('agentLoopPathLocks')?.rows[0]).toMatchObject({ status: 'held', owner: 'worker-b:lease' });
  });
});
